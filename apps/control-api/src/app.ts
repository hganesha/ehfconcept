import Fastify from "fastify";
import { runRequestSchema } from "@ehf/contracts";
import {
  AuthorizationError,
  createGuard,
  createWorkloadResolverFromEnv,
  DelegatedPrincipalResolver,
  type AuthorizationDecision,
  type PlatformAction,
  type Principal,
  type ResourceRef,
  type ServiceTokenGrant,
} from "@ehf/identity";
import {
  admitPlan, createAuthoringDraft, createDatabase, createRun, getAuthoringDraft, getPlan, getRun,
  SeparationOfDutiesError,
  getAuthoringAgent, listAuthoringAgents, listAuthoringSkills, registerAuthoringAgent, registerAuthoringSkill,
  listAuthoringDrafts, listAuthoringEvents, listEvents, listGatewayReceipts, listNodeAttempts, listPlanRecords,
  listPlans, listRegisteredCapabilities, listRuns, setAuthoringLifecycle, updateAuthoringSources, type Database,
} from "@ehf/persistence";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  analyzeAuthoringSources,
  compileAuthoringDraft,
  defaultAuthoringSources,
  evaluateCompiledPlan,
} from "./authoring.js";
import { importAgentBundle } from "./agent-import.js";
import { EnvelopeBrokerError, issueExecutionEnvelope } from "./envelope-broker.js";
import {
  applyStateWrite,
  authorizeStateWrite,
  parseStateRequest,
  RuntimeStateAuthorityError,
  runtimeStateOperations,
  type RuntimeStateOperation,
} from "./runtime-state-routes.js";
import { applyAgentToAuthoringSources, materializeRegisteredContracts, updateNodeCaseWrites } from "./authoring-agents.js";

function serviceGrantsFromEnv(env: NodeJS.ProcessEnv): ServiceTokenGrant[] {
  const tenantId = env.LOCAL_DEFAULT_TENANT_ID ?? "tenant_demo";
  const grants: ServiceTokenGrant[] = [];
  if (env.EDGE_SERVICE_TOKEN) {
    grants.push({ token: env.EDGE_SERVICE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId });
  }
  if (env.RUNTIME_SERVICE_TOKEN) {
    grants.push({ token: env.RUNTIME_SERVICE_TOKEN, subjectId: "harness-runtime", roles: ["Runtime.State.Write"], tenantId });
  }
  return grants;
}

export type ControlApiOptions = {
  db?: Database;
  serviceGrants?: ServiceTokenGrant[];
  env?: NodeJS.ProcessEnv;
  envelopeSecret?: string;
  grantSecret?: string;
};

export function buildControlApi(options: ControlApiOptions = {}) {
  const app = Fastify({ logger: true });
  const env = options.env ?? process.env;
  const db = options.db ?? createDatabase();
  const workloadResolver = createWorkloadResolverFromEnv(options.serviceGrants ?? serviceGrantsFromEnv(env), env);
  const recordDecision = (decision: AuthorizationDecision) => app.log.info({ authorization: decision }, "authorization decision");
  // Human operations arrive delegated through the control surface edge; the edge proves
  // itself and the actor it carries is believed only then. There is no longer a default
  // actor: an anonymous request is anonymous.
  const guard = createGuard({ resolver: new DelegatedPrincipalResolver(workloadResolver), onDecision: recordDecision });
  const runtimeGuard = createGuard({ resolver: workloadResolver, onDecision: recordDecision });

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof AuthorizationError) {
      return reply.code(error.httpStatus).send({ error: error.decision.reasonCode });
    }
    if (error instanceof SeparationOfDutiesError) {
      return reply.code(403).send({ error: error.message, actor: error.actor });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "control.internal_error" });
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => { await db.query("select 1"); return { status: "ready" }; });
  const requirePrincipal = (
    request: { headers: Record<string, string | string[] | undefined> },
    action: PlatformAction,
    resource?: ResourceRef,
  ): Promise<Principal> => guard.require(request, action, resource);
  const profilesPath = env.MODEL_PROFILES_PATH ?? "config/model-profiles.json";
  const envelopeSecret = () => {
    const value = options.envelopeSecret ?? env.EXECUTION_ENVELOPE_SECRET;
    if (!value) throw new EnvelopeBrokerError("broker.envelope_secret_missing", 503);
    return value;
  };
  const grantSecret = () => {
    const value = options.grantSecret ?? env.RUNTIME_GRANT_SECRET;
    if (!value) throw new EnvelopeBrokerError("broker.grant_secret_missing", 503);
    return value;
  };
  const domainsPath = fileURLToPath(new URL("../../../domains/", import.meta.url));
  app.get("/v1/plans", async (request) => {
    const principal = await requirePrincipal(request, "plan.read", { kind: "plan" });
    return { plans: await listPlans(db, principal.tenantId) };
  });
  app.get("/v1/plan-records", async (request) => {
    const principal = await requirePrincipal(request, "plan.read", { kind: "plan" });
    return { records: await listPlanRecords(db, principal.tenantId) };
  });
  app.get<{ Params: { digest: string } }>("/v1/plans/:digest", async (request, reply) => {
    const principal = await requirePrincipal(request, "plan.read", { kind: "plan", id: request.params.digest });
    const plan = await getPlan(db, request.params.digest, principal.tenantId);
    return plan ?? reply.code(404).send({ error: "plan.not_found" });
  });
  app.post("/v1/plans", async (request, reply) => {
    const principal = await requirePrincipal(request, "plan.admit", { kind: "plan" });
    try {
      // admitPlan verifies the digest before it writes; do not re-order these.
      const admitted = await admitPlan(db, request.body, principal.tenantId);
      return reply.code(admitted.created ? 201 : 200).send(admitted);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "plan.invalid" });
    }
  });
  app.get("/v1/authoring/drafts", async (request) => {
    const principal = await requirePrincipal(request, "draft.read", { kind: "draft" });
    return { drafts: await listAuthoringDrafts(db, principal.tenantId) };
  });
  app.get("/v1/authoring/agents", async (request) => {
    await requirePrincipal(request, "draft.read", { kind: "agent" });
    return { agents: await listAuthoringAgents(db) };
  });
  app.post("/v1/authoring/agents", async (request, reply) => {
    await requirePrincipal(request, "agent.register", { kind: "agent" });
    try { return reply.code(201).send(await registerAuthoringAgent(db, request.body)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.agent_invalid" }); }
  });
  app.get("/v1/authoring/skills", async (request) => {
    await requirePrincipal(request, "draft.read", { kind: "skill" });
    return { skills: await listAuthoringSkills(db) };
  });
  app.post("/v1/authoring/skills", async (request, reply) => {
    await requirePrincipal(request, "agent.register", { kind: "skill" });
    try { return reply.code(201).send(await registerAuthoringSkill(db, request.body)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.skill_invalid" }); }
  });
  app.post("/v1/authoring/import/github", async (request, reply) => {
    await requirePrincipal(request, "agent.register", { kind: "agent-import" });
    try {
      const url = (request.body as { url?: unknown } | null)?.url;
      if (typeof url !== "string") return reply.code(400).send({ error: "authoring.github_url_required" });
      const bundle = await importAgentBundle(url);
      const skills = await Promise.all(bundle.skills.map((skill) => registerAuthoringSkill(db, skill)));
      const agent = await registerAuthoringAgent(db, bundle.agent);
      return reply.code(201).send({ agent, skills });
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.github_import_failed" }); }
  });
  app.post("/v1/authoring/drafts", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.write", { kind: "draft" });
    try {
      const body = (request.body ?? {}) as { packageSource?: unknown; workflowSource?: unknown };
      const defaults = defaultAuthoringSources();
      const packageSource = typeof body.packageSource === "string" ? body.packageSource : defaults.packageSource;
      const workflowSource = typeof body.workflowSource === "string" ? body.workflowSource : defaults.workflowSource;
      const analysis = analyzeAuthoringSources(packageSource, workflowSource);
      const draft = await createAuthoringDraft(db, {
        packageSource, workflowSource, parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow,
        ...analysis.metadata, diagnostics: analysis.diagnostics, actor: principal.subjectId,
        tenantId: principal.tenantId,
      });
      return reply.code(201).send(draft);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.create_failed" });
    }
  });
  app.get("/v1/authoring/templates", async (request) => {
    await requirePrincipal(request, "draft.read", { kind: "template" });
    const names = ["kyc", "invoice"];
    const templates = await Promise.all(names.map(async (name) => ({
      id: name,
      packageSource: await readFile(resolve(domainsPath, name, "package.yaml"), "utf8"),
      workflowSource: await readFile(resolve(domainsPath, name, "workflow.yaml"), "utf8"),
    })));
    return { templates };
  });
  app.get<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.read", { kind: "draft", id: request.params.draftId });
    const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    return { ...draft, events: await listAuthoringEvents(db, draft.draftId) };
  });
  app.put<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.write", { kind: "draft", id: request.params.draftId });
    try {
      const body = request.body as { expectedRevision?: unknown; packageSource?: unknown; workflowSource?: unknown };
      if (typeof body.expectedRevision !== "number" || typeof body.packageSource !== "string" || typeof body.workflowSource !== "string") {
        return reply.code(400).send({ error: "authoring.update_invalid" });
      }
      const analysis = analyzeAuthoringSources(body.packageSource, body.workflowSource);
      return await updateAuthoringSources(db, request.params.draftId, {
        expectedRevision: body.expectedRevision, packageSource: body.packageSource, workflowSource: body.workflowSource,
        parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow, ...analysis.metadata,
        diagnostics: analysis.diagnostics, actor: principal.subjectId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "authoring.update_failed";
      return reply.code(message.includes("conflict") ? 409 : 400).send({ error: message });
    }
  });
  app.post<{ Params: { draftId: string; agentId: string } }>("/v1/authoring/drafts/:draftId/agents/:agentId/attach", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.write", { kind: "draft", id: request.params.draftId });
    try {
      const body = (request.body ?? {}) as { expectedRevision?: unknown; nodeId?: unknown; mode?: unknown; newNodeId?: unknown };
      if (typeof body.expectedRevision !== "number" || typeof body.nodeId !== "string" || (body.mode !== "replace" && body.mode !== "insert-after")) {
        return reply.code(400).send({ error: "authoring.agent_attachment_invalid" });
      }
      const [draft, registered, registeredSkills] = await Promise.all([
        getAuthoringDraft(db, request.params.draftId, principal.tenantId),
        getAuthoringAgent(db, request.params.agentId),
        listAuthoringSkills(db),
      ]);
      if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
      if (!registered) return reply.code(404).send({ error: "authoring.agent_not_found" });
      const sources = applyAgentToAuthoringSources({
        packageSource: draft.packageSource, workflowSource: draft.workflowSource, agent: registered.agent,
        skills: registeredSkills.map((item) => item.skill),
        nodeId: body.nodeId, mode: body.mode, ...(typeof body.newNodeId === "string" ? { newNodeId: body.newNodeId } : {}),
      });
      const analysis = analyzeAuthoringSources(sources.packageSource, sources.workflowSource);
      const updated = await updateAuthoringSources(db, draft.draftId, {
        expectedRevision: body.expectedRevision, packageSource: sources.packageSource, workflowSource: sources.workflowSource,
        parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow, ...analysis.metadata,
        diagnostics: analysis.diagnostics, actor: principal.subjectId,
      });
      return { draft: updated, attachedNodeId: sources.attachedNodeId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "authoring.agent_attachment_failed";
      return reply.code(message.includes("conflict") ? 409 : 400).send({ error: message });
    }
  });
  app.put<{ Params: { draftId: string; nodeId: string } }>("/v1/authoring/drafts/:draftId/nodes/:nodeId/case-writes", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.write", { kind: "draft", id: request.params.draftId });
    try {
      const body = (request.body ?? {}) as { expectedRevision?: unknown; caseWrites?: unknown };
      if (typeof body.expectedRevision !== "number" || !Array.isArray(body.caseWrites)) {
        return reply.code(400).send({ error: "authoring.case_writes_update_invalid" });
      }
      const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
      if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
      const workflowSource = updateNodeCaseWrites(draft.workflowSource, request.params.nodeId, body.caseWrites);
      const analysis = analyzeAuthoringSources(draft.packageSource, workflowSource);
      const caseWriteErrors = analysis.diagnostics.filter((item) => item.severity === "error" && item.path.includes(`nodes.${request.params.nodeId}.config.caseWrites`));
      if (caseWriteErrors.length) return reply.code(422).send({ error: "authoring.case_writes_invalid", diagnostics: caseWriteErrors });
      return await updateAuthoringSources(db, draft.draftId, {
        expectedRevision: body.expectedRevision, packageSource: draft.packageSource, workflowSource,
        parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow, ...analysis.metadata,
        diagnostics: analysis.diagnostics, actor: principal.subjectId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "authoring.case_writes_update_failed";
      return reply.code(message.includes("conflict") ? 409 : 400).send({ error: message });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/validate", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.read", { kind: "draft", id: request.params.draftId });
    const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    const analysis = analyzeAuthoringSources(draft.packageSource, draft.workflowSource);
    return { valid: !analysis.diagnostics.some((item) => item.severity === "error"), diagnostics: analysis.diagnostics };
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/compile", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.compile", { kind: "draft", id: request.params.draftId });
    try {
      let draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
      if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
      if (draft.status !== "DRAFT") return reply.code(409).send({ error: "authoring.compile_requires_draft" });
      const [registry, registeredAgents, registeredSkills] = await Promise.all([
        listRegisteredCapabilities(db), listAuthoringAgents(db), listAuthoringSkills(db),
      ]);
      const sources = materializeRegisteredContracts({
        packageSource: draft.packageSource,
        workflowSource: draft.workflowSource,
        agents: registeredAgents.filter((item) => item.agent.status === "active").map((item) => item.agent),
        skills: registeredSkills.filter((item) => item.skill.status === "active").map((item) => item.skill),
        capabilities: registry.filter((item) => item.capability.status === "active").map((item) => item.capability),
      });
      if (sources.materialized) {
        const analysis = analyzeAuthoringSources(sources.packageSource, sources.workflowSource);
        draft = await updateAuthoringSources(db, draft.draftId, {
          expectedRevision: draft.revision, packageSource: sources.packageSource, workflowSource: sources.workflowSource,
          parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow, ...analysis.metadata,
          diagnostics: analysis.diagnostics, actor: principal.subjectId,
        });
      }
      const result = await compileAuthoringDraft({
        packageSource: draft.packageSource, workflowSource: draft.workflowSource,
        registryCapabilities: registry.filter((item) => item.capability.status === "active").map((item) => item.capability),
        modelProfilesPath: profilesPath,
      });
      if (!result.plan) return reply.code(422).send({ error: "authoring.compile_failed", diagnostics: result.diagnostics });
      return await setAuthoringLifecycle(db, draft.draftId, {
        expectedStatus: "DRAFT", status: "COMPILED", actor: principal.subjectId, compiledPlan: result.plan, diagnostics: result.diagnostics,
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.compile_failed" });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/evaluate", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.evaluate", { kind: "draft", id: request.params.draftId });
    try {
      const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
      if (!draft?.compiledPlan) return reply.code(409).send({ error: "authoring.evaluate_requires_compiled" });
      const report = evaluateCompiledPlan(draft.compiledPlan);
      if (!report.passed) return reply.code(422).send({ error: "authoring.evaluation_failed", report });
      return await setAuthoringLifecycle(db, draft.draftId, { expectedStatus: "COMPILED", status: "EVALUATED", actor: principal.subjectId, evaluationReport: report });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "authoring.evaluate_failed" });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/approve", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.approve", { kind: "draft", id: request.params.draftId });
    try {
      return await setAuthoringLifecycle(db, request.params.draftId, { expectedStatus: "EVALUATED", status: "APPROVED", actor: principal.subjectId });
    } catch (error) {
      if (error instanceof SeparationOfDutiesError) throw error;
      return reply.code(409).send({ error: error instanceof Error ? error.message : "authoring.approve_failed" });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/publish", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.publish", { kind: "draft", id: request.params.draftId });
    try {
      const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
      if (!draft?.compiledPlan || draft.status !== "APPROVED") return reply.code(409).send({ error: "authoring.publish_requires_approved" });
      await admitPlan(db, draft.compiledPlan, principal.tenantId);
      return await setAuthoringLifecycle(db, draft.draftId, { expectedStatus: "APPROVED", status: "PUBLISHED", actor: principal.subjectId, publishedPlanDigest: draft.compiledPlan.planDigest });
    } catch (error) {
      if (error instanceof SeparationOfDutiesError) throw error;
      return reply.code(409).send({ error: error instanceof Error ? error.message : "authoring.publish_failed" });
    }
  });
  // Private broker surface. The runtime holds no signing key; it presents the grant the
  // dispatcher issued for this invocation and receives an envelope scoped to one node.
  app.post("/v1/runtime/envelopes", async (request, reply) => {
    await runtimeGuard.require(request, "envelope.mint", { kind: "run" });
    const header = request.headers["x-runtime-grant"];
    const grant = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!grant) return reply.code(401).send({ error: "broker.grant_missing" });
    try {
      return await issueExecutionEnvelope({
        db,
        envelopeSecret: envelopeSecret(),
        grantSecret: grantSecret(),
        ...(env.EXECUTION_ENVELOPE_TTL_SECONDS ? { envelopeTtlSeconds: Number(env.EXECUTION_ENVELOPE_TTL_SECONDS) } : {}),
      }, grant, request.body);
    } catch (error) {
      if (error instanceof EnvelopeBrokerError) return reply.code(error.httpStatus).send({ error: error.code });
      return reply.code(400).send({ error: error instanceof Error ? error.message : "broker.request_invalid" });
    }
  });

  // Private journalling surface. The runtime describes what happened; the control plane
  // re-checks the lease and fence and decides whether to record it, so the runtime needs
  // no database credential of its own.
  app.post<{ Params: { operation: string } }>("/v1/runtime/state/:operation", async (request, reply) => {
    await runtimeGuard.require(request, "runtime.state.write", { kind: "run" });
    const operation = request.params.operation as RuntimeStateOperation;
    if (!runtimeStateOperations.includes(operation)) return reply.code(404).send({ error: "runtime_state.operation_unknown" });
    const header = request.headers["x-runtime-grant"];
    const grant = (Array.isArray(header) ? header[0] : header)?.trim();
    try {
      const { run, payload } = parseStateRequest(operation, request.body);
      await authorizeStateWrite(db, grant, grantSecret(), run);
      await applyStateWrite(db, operation, run, payload);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof RuntimeStateAuthorityError) return reply.code(error.httpStatus).send({ error: error.code });
      if (error instanceof EnvelopeBrokerError) return reply.code(error.httpStatus).send({ error: error.code });
      const message = error instanceof Error ? error.message : "runtime_state.request_invalid";
      // A fenced write that lost its race is a denial, not a server fault.
      if (message.includes("stale_fence")) return reply.code(403).send({ error: message });
      return reply.code(400).send({ error: message });
    }
  });

  app.get("/v1/runs", async (request) => {
    const principal = await requirePrincipal(request, "run.read", { kind: "run" });
    return { runs: await listRuns(db, principal.tenantId) };
  });
  app.post("/v1/runs", async (request, reply) => {
    const principal = await requirePrincipal(request, "run.start", { kind: "run" });
    const parsed = runRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "run.request_invalid", issues: parsed.error.issues });
    // Scoped read: a plan admitted in another tenant is not startable here.
    if (!await getPlan(db, parsed.data.planDigest, principal.tenantId)) return reply.code(404).send({ error: "plan.not_found" });
    const key = String(request.headers["idempotency-key"] ?? "");
    if (!key) return reply.code(400).send({ error: "run.idempotency_key_required" });
    const result = await createRun(db, {
      planDigest: parsed.data.planDigest, runInput: parsed.data.input, idempotencyKey: key,
      tenantId: principal.tenantId,
    });
    return reply.code(result.created ? 202 : 200).send(result);
  });
  app.get<{ Params: { runId: string } }>("/v1/runs/:runId", async (request, reply) => {
    const principal = await requirePrincipal(request, "run.read", { kind: "run", id: request.params.runId });
    const run = await getRun(db, request.params.runId, principal.tenantId);
    return run ?? reply.code(404).send({ error: "run.not_found" });
  });
  app.get<{ Params: { runId: string } }>("/v1/runs/:runId/trace", async (request, reply) => {
    const principal = await requirePrincipal(request, "run.read", { kind: "run", id: request.params.runId });
    const run = await getRun(db, request.params.runId, principal.tenantId);
    if (!run) return reply.code(404).send({ error: "run.not_found" });
    if (!run.traceId || !run.rootSpanId) return reply.code(404).send({ error: "trace.not_bound" });
    const base = process.env.TRACE_VIEWER_BASE_URL?.replace(/\/$/, "");
    return {
      traceId: run.traceId,
      rootSpanId: run.rootSpanId,
      sampled: Boolean((run.traceFlags ?? 0) & 1),
      viewerUrl: base ? `${base}/trace/${run.traceId}` : null,
    };
  });
  app.get<{ Params: { runId: string }; Querystring: { after?: string } }>("/v1/runs/:runId/events", async (request) => {
    await requirePrincipal(request, "event.read", { kind: "run", id: request.params.runId });
    return { events: await listEvents(db, request.params.runId, Number(request.query.after ?? 0)) };
  });
  app.get<{ Params: { runId: string } }>("/v1/runs/:runId/attempts", async (request, reply) => {
    const principal = await requirePrincipal(request, "run.read", { kind: "run", id: request.params.runId });
    if (!await getRun(db, request.params.runId, principal.tenantId)) return reply.code(404).send({ error: "run.not_found" });
    return { attempts: await listNodeAttempts(db, request.params.runId) };
  });
  app.get<{ Querystring: { runId?: string; decision?: string; limit?: string } }>("/v1/gateway/receipts", async (request, reply) => {
    await requirePrincipal(request, "receipt.read", { kind: "receipt" });
    const decision = request.query.decision;
    if (decision && decision !== "allowed" && decision !== "denied") {
      return reply.code(400).send({ error: "gateway.decision_filter_invalid" });
    }
    const normalizedDecision = decision === "allowed" || decision === "denied" ? decision : undefined;
    return {
      receipts: await listGatewayReceipts(db, {
        ...(request.query.runId ? { runId: request.query.runId } : {}),
        ...(normalizedDecision ? { decision: normalizedDecision } : {}),
        ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
      }),
    };
  });
  app.addHook("onClose", async () => { if (!options.db) await db.end(); });
  return app;
}
