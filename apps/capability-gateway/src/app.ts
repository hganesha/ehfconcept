import Fastify from "fastify";
import { invokeModel, invokeSimulator, loadModelProfiles } from "@ehf/adapters";
import {
  capabilityRequestSchema,
  stableDigest,
  type CapabilityDefinition,
  type CapabilityRequest,
  type CapabilityResult,
  type ExecutionEnvelopeClaims,
  type HarnessPlan,
} from "@ehf/contracts";
import { verifyExecutionEnvelope } from "@ehf/execution-auth";
import {
  AuthorizationError,
  createGuard,
  isAzureMode,
  createWorkloadResolverFromEnv,
  DelegatedPrincipalResolver,
  type AuthorizationDecision,
  type Guard,
  type ServiceTokenGrant,
} from "@ehf/identity";
import {
  completeGatewayReceipt,
  createDatabase,
  currentFencingEpoch,
  getPlan,
  getRun,
  listRegisteredCapabilities,
  recordCapabilityCost,
  registerCapability,
  reserveCapabilityBudget,
  reserveGatewayReceipt,
  type Database,
} from "@ehf/persistence";
import {
  SpanKind,
  SpanStatusCode,
  context,
  extractTraceContext,
  recordFailure,
  trace,
  traceReference,
  withSpan,
} from "@ehf/telemetry";

export type GatewayOptions = {
  db?: Database;
  executionSecret?: string;
  modelProfilesPath?: string;
  /** Callers permitted to reach this gateway, and the roles each one holds. */
  serviceGrants?: ServiceTokenGrant[];
  env?: NodeJS.ProcessEnv;
};

/**
 * The execution envelope travels in its own header.
 *
 * Transport authorization and execution authority answer different questions -- "is this
 * workload the runtime?" and "may this run, node and attempt call these capabilities
 * right now?" -- and a deployment needs both. Sharing the Authorization header between
 * them makes it impossible to require both at once.
 */
const EXECUTION_ENVELOPE_HEADER = "x-execution-envelope";

function serviceGrantsFromEnv(env: NodeJS.ProcessEnv): ServiceTokenGrant[] {
  const tenantId = env.LOCAL_DEFAULT_TENANT_ID ?? "tenant_demo";
  const grants: ServiceTokenGrant[] = [];
  if (env.RUNTIME_SERVICE_TOKEN) {
    grants.push({ token: env.RUNTIME_SERVICE_TOKEN, subjectId: "harness-runtime", roles: ["Capability.Invoke"], tenantId });
  }
  if (env.EDGE_SERVICE_TOKEN) {
    grants.push({ token: env.EDGE_SERVICE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId });
  }
  return grants;
}

function envelopeToken(headers: Record<string, string | string[] | undefined>): string {
  const value = headers[EXECUTION_ENVELOPE_HEADER];
  const token = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!token) throw new Error("gateway.execution_envelope_missing");
  return token;
}

function expectedDenial(code: string): boolean {
  return code.includes("denied") || code.includes("authorization") || code.includes("stale_fence");
}

/**
 * Whether a missing provider credential may fall back to the recorded adapter.
 *
 * Locally the deterministic adapter is what makes the POC testable offline. In Azure a
 * silent fallback would let a deployment report successful model calls it never made, so
 * the absent credential has to fail closed instead.
 */
function recordedFallbackAllowed(env: NodeJS.ProcessEnv): boolean {
  if (env.MODEL_RECORDED_FALLBACK === "deny") return false;
  if (env.MODEL_RECORDED_FALLBACK === "allow") return true;
  return !isAzureMode(env);
}

export function buildGateway(options: GatewayOptions = {}) {
  const app = Fastify({ logger: true });
  const env = options.env ?? process.env;
  const db = options.db ?? createDatabase();
  const secret = options.executionSecret ?? env.EXECUTION_ENVELOPE_SECRET ?? "";
  const profilesPath = options.modelProfilesPath ?? env.MODEL_PROFILES_PATH ?? "config/model-profiles.json";
  const workloadResolver = createWorkloadResolverFromEnv(options.serviceGrants ?? serviceGrantsFromEnv(env), env);
  const recordDecision = (decision: AuthorizationDecision) => {
    app.log.info({ authorization: decision }, "authorization decision");
    const span = trace.getActiveSpan();
    span?.setAttributes({
      "harness.authorization.outcome": decision.outcome.toUpperCase(),
      "harness.authorization.reason": decision.reasonCode,
      "harness.principal.type": decision.actorType,
    });
  };
  // Management routes are operated by a person through the control surface; capability
  // invocation is a workload path and is authorized by the execution envelope below.
  const managementGuard: Guard = createGuard({
    resolver: new DelegatedPrincipalResolver(workloadResolver),
    onDecision: recordDecision,
  });
  const workloadGuard: Guard = createGuard({ resolver: workloadResolver, onDecision: recordDecision });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AuthorizationError) {
      return reply.code(error.httpStatus).send({ error: error.decision.reasonCode });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "gateway.internal_error" });
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await db.query("select 1");
    return { status: "ready" };
  });
  app.get("/v1/status", async (request) => {
    await managementGuard.require(request, "capability.read", { kind: "gateway" });
    return {
      readiness: "Ready",
      openRouterState: env.OPENROUTER_API_KEY ? "Configured" : "Missing",
      runtimeMode: env.OPENROUTER_API_KEY ? "OpenRouter" : "Recorded",
      envelopeVerifierStatus: secret ? "Verified · HMAC-SHA256 envelope-v1" : "Degraded",
      generatedAt: new Date().toISOString(),
    };
  });
  app.get("/v1/model-profiles", async (request) => {
    await managementGuard.require(request, "capability.read", { kind: "model-profile" });
    return { profiles: await loadModelProfiles(profilesPath) };
  });
  app.get("/v1/capabilities", async (request) => {
    await managementGuard.require(request, "capability.read", { kind: "capability" });
    return { capabilities: await listRegisteredCapabilities(db) };
  });
  app.post("/v1/capabilities", async (request, reply) => {
    // Registering a capability decides what a compiled plan may later be bound to, so it
    // is a control-plane write. It used to be completely unauthenticated.
    await managementGuard.require(request, "capability.register", { kind: "capability" });
    try {
      const result = await registerCapability(db, request.body);
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "capability.registration_invalid" });
    }
  });
  app.post("/v1/openrouter/test", async (request, reply) => {
    await managementGuard.require(request, "capability.read", { kind: "provider-probe" });
    const started = Date.now();
    const testedAt = new Date().toISOString();
    if (!process.env.OPENROUTER_API_KEY) {
      return {
        status: "Recorded",
        credentialState: "Missing",
        latencyMs: Date.now() - started,
        testedAt,
        message: "OPENROUTER_API_KEY is not configured; deterministic recorded adapter remains available.",
      };
    }
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`openrouter.http_${response.status}`);
      return {
        status: "Ready",
        credentialState: "Configured",
        latencyMs: Date.now() - started,
        testedAt,
        message: "OpenRouter catalog and credential probe succeeded; credential value remained server-side.",
      };
    } catch (error) {
      return reply.code(503).send({
        status: "Unavailable",
        credentialState: "Configured",
        latencyMs: Date.now() - started,
        testedAt,
        message: error instanceof Error ? error.message : "openrouter.test_failed",
      });
    }
  });

  app.post("/v1/invoke", async (request, reply) => {
    const parent = extractTraceContext(request.headers as Record<string, string | string[] | undefined>);
    return withSpan("capability.invoke", {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": "POST", "http.route": "/v1/invoke" },
    }, async (span) => {
      const started = Date.now();
      let claims!: ExecutionEnvelopeClaims;
      let invocation!: CapabilityRequest;
      let plan!: HarnessPlan;
      let capability!: CapabilityDefinition;
      try {
        const authSpan = trace.getTracer("harness.gateway", "0.1.0").startSpan(
          "authorization.evaluate", { kind: SpanKind.INTERNAL }, context.active(),
        );
        try {
          // Both credentials are required: the workload token says which service is
          // calling, the envelope says what this run, node and attempt may do right now.
          await workloadGuard.require(request, "capability.read", { kind: "capability" });
          claims = await verifyExecutionEnvelope(envelopeToken(request.headers), secret);
          invocation = capabilityRequestSchema.parse(request.body);
          if (claims.jti !== invocation.invocationId) throw new Error("gateway.invocation_mismatch");
          if (!claims.capabilities.includes(invocation.capabilityId)) throw new Error("gateway.capability_denied");
          if (!claims.effects.includes(invocation.effect)) throw new Error("gateway.effect_denied");
          const epoch = await currentFencingEpoch(db, claims.run_id);
          if (epoch !== claims.fencing_epoch) throw new Error("gateway.stale_fence");
          plan = await getPlan(db, claims.plan_digest) as HarnessPlan;
          if (!plan) throw new Error("gateway.plan_not_admitted");
          const permission = plan.permissionEnvelopes.find((item) => item.nodeId === claims.node_id);
          const resolved = plan.capabilities.find((item) => item.id === invocation.capabilityId);
          if (!permission || permission.digest !== claims.permission_digest) throw new Error("gateway.permission_mismatch");
          if (!permission.capabilities.includes(invocation.capabilityId)) throw new Error("gateway.capability_denied");
          if (!permission.effects.includes(invocation.effect)) throw new Error("gateway.effect_denied");
          if (!resolved || resolved.effect !== invocation.effect) throw new Error("gateway.capability_contract_mismatch");
          capability = resolved;
          const run = await getRun(db, claims.run_id);
          if (!run) throw new Error("gateway.run_not_found");
          // Reserved, not merely checked: the counters move in the same statement that
          // tests them, so concurrent nodes cannot both pass against the same counts.
          const reserved = await reserveCapabilityBudget(db, {
            runId: claims.run_id,
            modelCall: capability.kind === "model",
            maxCapabilityCalls: plan.budgets.maxCapabilityCalls,
            maxModelCalls: plan.budgets.maxModelCalls,
            maxCostUsd: plan.budgets.maxCostUsd,
          });
          if (!reserved) throw new Error("gateway.budget_denied");
          authSpan.setAttributes({
            "harness.authorization.outcome": "ALLOWED",
            "harness.authorization.reason": "permission.envelope_allowed",
            "harness.capability.effect": capability.effect,
          });
          authSpan.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          const message = error instanceof Error ? error.message : "gateway.unknown";
          if (expectedDenial(message)) {
            authSpan.setStatus({ code: SpanStatusCode.OK });
            authSpan.setAttributes({ "harness.authorization.outcome": "DENIED", "harness.authorization.reason": message });
          } else {
            recordFailure(authSpan, error);
          }
          throw error;
        } finally {
          authSpan.end();
        }

        span.setAttributes({
          "harness.execution.id": claims.run_id,
          "harness.node.id": claims.node_id,
          "harness.execution.attempt": claims.attempt,
          "harness.capability.id": invocation.capabilityId,
          "harness.capability.effect": invocation.effect,
          "harness.plan.digest_prefix": claims.plan_digest.slice(0, 12),
          "harness.provider.binding_digest_prefix": stableDigest(capability.adapterBindingId).slice(0, 12),
        });
        const spanRef = traceReference(span);
        const requestDigest = stableDigest(invocation);
        const reserved = await reserveGatewayReceipt(db, {
          invocationId: invocation.invocationId,
          runId: claims.run_id,
          nodeId: claims.node_id,
          attempt: claims.attempt,
          fencingEpoch: claims.fencing_epoch,
          planDigest: claims.plan_digest,
          permissionDigest: claims.permission_digest,
          capabilityId: invocation.capabilityId,
          effect: invocation.effect,
          decision: "allowed",
          reasonCode: "permission.envelope_allowed",
          requestDigest,
          traceId: spanRef.traceId,
          spanId: spanRef.spanId,
        });
        if (!reserved.created) {
          span.setAttribute("harness.gateway.receipt_replayed", true);
          if (reserved.result) return reserved.result;
          return reply.code(409).send({ error: "gateway.invocation_in_progress" });
        }

        const operationName = capability.kind === "model" ? "model.inference" : "tool.execution";
        const adapter = await withSpan(operationName, {
          kind: SpanKind.CLIENT,
          attributes: {
            "harness.capability.id": capability.id,
            "harness.capability.effect": capability.effect,
            "harness.provider.binding_digest_prefix": stableDigest(capability.adapterBindingId).slice(0, 12),
            ...(capability.kind === "model"
              ? { "harness.model.profile": capability.adapterBindingId.replace(/^openrouter:/, "") }
              : {}),
          },
        }, async (providerSpan) => {
          const response = capability.kind === "model"
            ? await (async () => {
              const profileId = capability.adapterBindingId.replace(/^openrouter:/, "");
              const profile = (await loadModelProfiles(profilesPath)).find((item) => item.id === profileId);
              if (!profile) throw new Error("gateway.model_profile_missing");
              return invokeModel({
                profile,
                input: invocation.input,
                allowRecordedFallback: recordedFallbackAllowed(env),
                ...(capability.outputSchema ? { outputSchema: capability.outputSchema } : {}),
                ...(env.OPENROUTER_API_KEY ? { apiKey: env.OPENROUTER_API_KEY } : {}),
                ...(env.OPENROUTER_SITE_URL ? { siteUrl: env.OPENROUTER_SITE_URL } : {}),
                ...(env.OPENROUTER_APP_NAME ? { appName: env.OPENROUTER_APP_NAME } : {}),
              });
            })()
            : await invokeSimulator(capability.adapterBindingId.replace(/^simulator:/, ""), invocation.input);
          providerSpan.setAttributes({
            "harness.provider": response.provider,
            "harness.model.id": response.model,
            "harness.outcome": "SUCCEEDED",
            ...(response.inputTokens === null ? {} : { "gen_ai.usage.input_tokens": response.inputTokens }),
            ...(response.outputTokens === null ? {} : { "gen_ai.usage.output_tokens": response.outputTokens }),
            ...(response.costUsd === null ? {} : { "harness.cost.usd": response.costUsd }),
          });
          return response;
        });

        const unsigned = {
          invocationId: invocation.invocationId,
          capabilityId: invocation.capabilityId,
          status: "succeeded" as const,
          output: adapter.output,
          errorCode: null,
          provider: adapter.provider,
          model: adapter.model,
          providerRequestId: adapter.providerRequestId,
          usage: { inputTokens: adapter.inputTokens, outputTokens: adapter.outputTokens, costUsd: adapter.costUsd },
          latencyMs: Date.now() - started,
        };
        const result: CapabilityResult = { ...unsigned, receiptDigest: stableDigest(unsigned) };
        await completeGatewayReceipt(db, result);
        await recordCapabilityCost(db, { runId: claims.run_id, costUsd: adapter.costUsd });
        span.setAttributes({ "harness.outcome": "SUCCEEDED", "harness.gateway.receipt_replayed": false });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "gateway.unknown";
        if (expectedDenial(message)) {
          span.setStatus({ code: SpanStatusCode.OK });
          span.setAttribute("harness.outcome", "DENIED");
        } else {
          recordFailure(span, error);
        }
        request.log.warn({ err: error }, "capability invocation denied or failed");
        return reply.code(expectedDenial(message) ? 403 : 400).send({ error: message });
      }
    }, parent);
  });

  app.addHook("onClose", async () => { if (!options.db) await db.end(); });
  return app;
}
