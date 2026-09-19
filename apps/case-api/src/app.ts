import Fastify, { type FastifyRequest } from "fastify";
import {
  CaseStoreError,
  createCaseStore,
  createKycCase,
  getCaseView,
  getEvidence,
  listCaseEvents,
  listCases,
  registerEvidence,
  submitBusinessCommand,
  verifyCaseLedger,
  type CaseStore,
} from "@ehf/case-store";
import {
  businessCommandSchema,
  createKycCaseRequestSchema,
  kycCaseStatusSchema,
  registerEvidenceRequestSchema,
} from "@ehf/contracts";
import {
  AuthorizationError,
  createGuard,
  createWorkloadResolverFromEnv,
  DelegatedPrincipalResolver,
  type AuthorizationDecision,
  type PlatformAction,
  type Principal,
  type ServiceTokenGrant,
} from "@ehf/identity";
import { extractTraceContext, SpanKind, withSpan } from "@ehf/telemetry";

function serviceGrantsFromEnv(env: NodeJS.ProcessEnv): ServiceTokenGrant[] {
  const tenantId = env.LOCAL_DEFAULT_TENANT_ID ?? "tenant_demo";
  const grants: ServiceTokenGrant[] = [];
  if (env.EDGE_SERVICE_TOKEN) {
    grants.push({ token: env.EDGE_SERVICE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId });
  }
  if (env.RUNTIME_SERVICE_TOKEN) {
    grants.push({ token: env.RUNTIME_SERVICE_TOKEN, subjectId: "harness-runtime", roles: ["Case.Api.Access"], tenantId });
  }
  return grants;
}

function requestedTenant(request: FastifyRequest): string | undefined {
  const value = request.headers["x-tenant-id"];
  const single = Array.isArray(value) ? value[0] : value;
  return single?.trim() || undefined;
}

function requestParent(request: FastifyRequest) {
  const carrier = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, value]));
  return extractTraceContext(carrier);
}

async function traced<T>(request: FastifyRequest, operation: string, attributes: Record<string, string | number>, fn: () => Promise<T>) {
  return withSpan(operation, {
    kind: SpanKind.SERVER,
    attributes: {
      "http.request.method": request.method,
      "url.path": request.url.split("?")[0] ?? request.url,
      "case.operation": operation,
      ...attributes,
    },
  }, async (span) => {
    const result = await fn();
    span.setAttribute("case.outcome", "OK");
    return result;
  }, requestParent(request));
}

export type CaseApiOptions = {
  store?: CaseStore;
  serviceGrants?: ServiceTokenGrant[];
  env?: NodeJS.ProcessEnv;
};

export function buildCaseApi(options: CaseApiOptions = {}) {
  const app = Fastify({ logger: true });
  const env = options.env ?? process.env;
  const store = options.store ?? createCaseStore();
  const workloadResolver = createWorkloadResolverFromEnv(options.serviceGrants ?? serviceGrantsFromEnv(env), env);
  const recordDecision = (decision: AuthorizationDecision) => app.log.info({ authorization: decision }, "authorization decision");
  const humanGuard = createGuard({ resolver: new DelegatedPrincipalResolver(workloadResolver), onDecision: recordDecision });
  const workloadGuard = createGuard({ resolver: workloadResolver, onDecision: recordDecision });

  /**
   * Authorize a case operation and return the principal whose tenant it runs in.
   *
   * Tenancy is taken from the authenticated identity. `x-tenant-id` used to be the only
   * thing standing between a caller and any tenant's cases; it is now at most a
   * requested scope that has to match the assignment the identity already carries.
   */
  const authorize = async (request: FastifyRequest, action: PlatformAction, resource: { kind: string; id?: string }): Promise<Principal> => {
    const delegated = request.headers["x-actor-id"] !== undefined;
    const guard = delegated ? humanGuard : workloadGuard;
    const scope = requestedTenant(request);
    return guard.require(request, action, scope ? { ...resource, tenantId: scope } : resource);
  };

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AuthorizationError) {
      return reply.code(error.httpStatus).send({ error: error.decision.reasonCode });
    }
    if (error instanceof CaseStoreError) {
      return reply.code(error.httpStatus).send({ error: error.code, ...error.details });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "case_store.internal_error" });
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await store.db.query("select 1");
    return {
      status: "ready",
      schemas: store.schemas,
      artifactBackend: store.artifactBackend,
      evidencePolicy: { requireScan: store.evidenceRequireScan, maxBytes: store.evidenceMaxBytes },
    };
  });

  app.post("/v1/cases", async (request, reply) => traced(request, "case.create", {}, async () => {
    const principal = await authorize(request, "case.write", { kind: "case" });
    const parsed = createKycCaseRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "case.request_invalid", issues: parsed.error.issues });
    if (parsed.data.tenantId !== principal.tenantId) return reply.code(403).send({ error: "authorization.tenant_mismatch" });
    const key = String(request.headers["idempotency-key"] ?? "");
    const result = await createKycCase(store, parsed.data, key);
    return reply.code(result.created ? 201 : 200).send(result);
  }));

  app.get<{ Querystring: { status?: string; limit?: string } }>("/v1/cases", async (request, reply) => traced(request, "case.list", {}, async () => {
    const tenant = (await authorize(request, "case.read", { kind: "case" })).tenantId;
    const status = request.query.status ? kycCaseStatusSchema.safeParse(request.query.status) : null;
    if (status && !status.success) return reply.code(400).send({ error: "case.status_invalid" });
    return {
      cases: await listCases(store, {
        tenantId: tenant,
        ...(status?.success ? { status: status.data } : {}),
        ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
      }),
    };
  }));

  app.get<{ Params: { caseId: string } }>("/v1/cases/:caseId", async (request, reply) => traced(request, "case.read", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "case.read", { kind: "case", id: request.params.caseId });
    const result = await getCaseView(store, principal.tenantId, request.params.caseId);
    if (!result) return reply.code(404).send({ error: "case.not_found" });
    reply.header("etag", result.etag);
    return result;
  }));

  app.post<{ Params: { caseId: string } }>("/v1/cases/:caseId/commands", async (request, reply) => traced(request, "case.command", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "case.write", { kind: "case", id: request.params.caseId });
    const parsed = businessCommandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "command.request_invalid", issues: parsed.error.issues });
    if (parsed.data.caseId !== request.params.caseId) return reply.code(400).send({ error: "command.case_id_mismatch" });
    // The command names its own tenant; that claim only holds inside the caller's.
    if (parsed.data.tenantId !== principal.tenantId) return reply.code(403).send({ error: "authorization.tenant_mismatch" });
    const result = await submitBusinessCommand(store, parsed.data);
    return reply.code(200).send(result);
  }));

  app.get<{ Params: { caseId: string }; Querystring: { after?: string } }>("/v1/cases/:caseId/events", async (request) => traced(request, "case.events.read", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "event.read", { kind: "case", id: request.params.caseId });
    return { events: await listCaseEvents(store, principal.tenantId, request.params.caseId, Number(request.query.after ?? 0)) };
  }));

  app.post<{ Params: { caseId: string } }>("/v1/cases/:caseId/ledger:verify", async (request) => traced(request, "case.ledger.verify", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "case.read", { kind: "case", id: request.params.caseId });
    return verifyCaseLedger(store, principal.tenantId, request.params.caseId);
  }));

  app.post("/v1/evidence:register", async (request, reply) => traced(request, "evidence.register", {}, async () => {
    const principal = await authorize(request, "evidence.write", { kind: "evidence" });
    const parsed = registerEvidenceRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "evidence.request_invalid", issues: parsed.error.issues });
    if (parsed.data.tenantId !== principal.tenantId) return reply.code(403).send({ error: "authorization.tenant_mismatch" });
    const key = String(request.headers["idempotency-key"] ?? "");
    const result = await registerEvidence(store, parsed.data, key);
    return reply.code(result.created ? 201 : 200).send(result);
  }));

  app.get<{ Params: { evidenceId: string } }>("/v1/evidence/:evidenceId", async (request, reply) => traced(request, "evidence.read", {
    "evidence.id": request.params.evidenceId,
  }, async () => {
    const principal = await authorize(request, "evidence.read", { kind: "evidence", id: request.params.evidenceId });
    const result = await getEvidence(store, principal.tenantId, request.params.evidenceId);
    return result ?? reply.code(404).send({ error: "evidence.not_found" });
  }));

  app.addHook("onClose", async () => {
    if (store.ownsDatabase) await store.db.end();
  });
  return app;
}
