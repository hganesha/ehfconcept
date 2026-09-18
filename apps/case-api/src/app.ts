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
import { extractTraceContext, SpanKind, withSpan } from "@ehf/telemetry";

function tenantId(request: FastifyRequest): string {
  const value = request.headers["x-tenant-id"];
  if (typeof value !== "string" || !value.trim()) throw new CaseStoreError("tenant.header_required", 400);
  return value;
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

export function buildCaseApi(options: { store?: CaseStore } = {}) {
  const app = Fastify({ logger: true });
  const store = options.store ?? createCaseStore();

  app.setErrorHandler((error, _request, reply) => {
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
    const parsed = createKycCaseRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "case.request_invalid", issues: parsed.error.issues });
    const key = String(request.headers["idempotency-key"] ?? "");
    const result = await createKycCase(store, parsed.data, key);
    return reply.code(result.created ? 201 : 200).send(result);
  }));

  app.get<{ Querystring: { status?: string; limit?: string } }>("/v1/cases", async (request, reply) => traced(request, "case.list", {}, async () => {
    const tenant = tenantId(request);
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
    const result = await getCaseView(store, tenantId(request), request.params.caseId);
    if (!result) return reply.code(404).send({ error: "case.not_found" });
    reply.header("etag", result.etag);
    return result;
  }));

  app.post<{ Params: { caseId: string } }>("/v1/cases/:caseId/commands", async (request, reply) => traced(request, "case.command", {
    "case.id": request.params.caseId,
  }, async () => {
    const parsed = businessCommandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "command.request_invalid", issues: parsed.error.issues });
    if (parsed.data.caseId !== request.params.caseId) return reply.code(400).send({ error: "command.case_id_mismatch" });
    const result = await submitBusinessCommand(store, parsed.data);
    return reply.code(200).send(result);
  }));

  app.get<{ Params: { caseId: string }; Querystring: { after?: string } }>("/v1/cases/:caseId/events", async (request) => traced(request, "case.events.read", {
    "case.id": request.params.caseId,
  }, async () => ({ events: await listCaseEvents(store, tenantId(request), request.params.caseId, Number(request.query.after ?? 0)) })));

  app.post<{ Params: { caseId: string } }>("/v1/cases/:caseId/ledger:verify", async (request) => traced(request, "case.ledger.verify", {
    "case.id": request.params.caseId,
  }, async () => verifyCaseLedger(store, tenantId(request), request.params.caseId)));

  app.post("/v1/evidence:register", async (request, reply) => traced(request, "evidence.register", {}, async () => {
    const parsed = registerEvidenceRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "evidence.request_invalid", issues: parsed.error.issues });
    const key = String(request.headers["idempotency-key"] ?? "");
    const result = await registerEvidence(store, parsed.data, key);
    return reply.code(result.created ? 201 : 200).send(result);
  }));

  app.get<{ Params: { evidenceId: string } }>("/v1/evidence/:evidenceId", async (request, reply) => traced(request, "evidence.read", {
    "evidence.id": request.params.evidenceId,
  }, async () => {
    const result = await getEvidence(store, tenantId(request), request.params.evidenceId);
    return result ?? reply.code(404).send({ error: "evidence.not_found" });
  }));

  app.addHook("onClose", async () => {
    if (store.ownsDatabase) await store.db.end();
  });
  return app;
}
