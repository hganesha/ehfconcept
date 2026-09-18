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
  completeGatewayReceipt,
  createDatabase,
  currentFencingEpoch,
  getPlan,
  getRun,
  listRegisteredCapabilities,
  recordCapabilityUsage,
  registerCapability,
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
};

function bearer(value: string | undefined): string {
  if (!value?.startsWith("Bearer ")) throw new Error("gateway.authorization_missing");
  return value.slice(7);
}

function expectedDenial(code: string): boolean {
  return code.includes("denied") || code.includes("authorization") || code.includes("stale_fence");
}

export function buildGateway(options: GatewayOptions = {}) {
  const app = Fastify({ logger: true });
  const db = options.db ?? createDatabase();
  const secret = options.executionSecret ?? process.env.EXECUTION_ENVELOPE_SECRET ?? "";
  const profilesPath = options.modelProfilesPath ?? process.env.MODEL_PROFILES_PATH ?? "config/model-profiles.json";

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await db.query("select 1");
    return { status: "ready" };
  });
  app.get("/v1/status", async () => ({
    readiness: "Ready",
    openRouterState: process.env.OPENROUTER_API_KEY ? "Configured" : "Missing",
    runtimeMode: process.env.OPENROUTER_API_KEY ? "OpenRouter" : "Recorded",
    envelopeVerifierStatus: secret ? "Verified · HMAC-SHA256 envelope-v1" : "Degraded",
    generatedAt: new Date().toISOString(),
  }));
  app.get("/v1/model-profiles", async () => ({ profiles: await loadModelProfiles(profilesPath) }));
  app.get("/v1/capabilities", async () => ({ capabilities: await listRegisteredCapabilities(db) }));
  app.post("/v1/capabilities", async (request, reply) => {
    try {
      const result = await registerCapability(db, request.body);
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "capability.registration_invalid" });
    }
  });
  app.post("/v1/openrouter/test", async (_request, reply) => {
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
          claims = await verifyExecutionEnvelope(bearer(request.headers.authorization), secret);
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
          if (run.capabilityCalls >= plan.budgets.maxCapabilityCalls) throw new Error("gateway.capability_budget_denied");
          if (capability.kind === "model" && run.modelCalls >= plan.budgets.maxModelCalls) throw new Error("gateway.model_budget_denied");
          if (run.costUsd >= plan.budgets.maxCostUsd) throw new Error("gateway.cost_budget_denied");
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
                ...(capability.outputSchema ? { outputSchema: capability.outputSchema } : {}),
                ...(process.env.OPENROUTER_API_KEY ? { apiKey: process.env.OPENROUTER_API_KEY } : {}),
                ...(process.env.OPENROUTER_SITE_URL ? { siteUrl: process.env.OPENROUTER_SITE_URL } : {}),
                ...(process.env.OPENROUTER_APP_NAME ? { appName: process.env.OPENROUTER_APP_NAME } : {}),
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
        await recordCapabilityUsage(db, {
          runId: claims.run_id, modelCall: capability.kind === "model", costUsd: adapter.costUsd,
        });
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
