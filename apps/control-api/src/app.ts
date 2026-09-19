import Fastify from "fastify";
import { runRequestSchema } from "@ehf/contracts";
import {
  admitPlan, createAuthoringDraft, createDatabase, createRun, getAuthoringDraft, getPlan, getRun,
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
import { applyAgentToAuthoringSources, materializeRegisteredContracts, updateNodeCaseWrites } from "./authoring-agents.js";

export function buildControlApi(options: { db?: Database } = {}) {
  const app = Fastify({ logger: true });
  const db = options.db ?? createDatabase();
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => { await db.query("select 1"); return { status: "ready" }; });
  const actor = (headers: Record<string, string | string[] | undefined>) => String(headers["x-actor-id"] ?? "local-author");
  const profilesPath = process.env.MODEL_PROFILES_PATH ?? "config/model-profiles.json";
  const domainsPath = fileURLToPath(new URL("../../../domains/", import.meta.url));
  app.get("/v1/plans", async () => ({ plans: await listPlans(db) }));
  app.get("/v1/plan-records", async () => ({ records: await listPlanRecords(db) }));
  app.get<{ Params: { digest: string } }>("/v1/plans/:digest", async (request, reply) => {
    const plan = await getPlan(db, request.params.digest);
    return plan ?? reply.code(404).send({ error: "plan.not_found" });
  });
  app.post("/v1/plans", async (request, reply) => {
    try {
      // admitPlan verifies the digest before it writes; do not re-order these.
      const admitted = await admitPlan(db, request.body);
      return reply.code(admitted.created ? 201 : 200).send(admitted);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "plan.invalid" });
    }
  });
  app.get("/v1/authoring/drafts", async () => ({ drafts: await listAuthoringDrafts(db) }));
  app.get("/v1/authoring/agents", async () => ({ agents: await listAuthoringAgents(db) }));
  app.post("/v1/authoring/agents", async (request, reply) => {
    try { return reply.code(201).send(await registerAuthoringAgent(db, request.body)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.agent_invalid" }); }
  });
  app.get("/v1/authoring/skills", async () => ({ skills: await listAuthoringSkills(db) }));
  app.post("/v1/authoring/skills", async (request, reply) => {
    try { return reply.code(201).send(await registerAuthoringSkill(db, request.body)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.skill_invalid" }); }
  });
  app.post("/v1/authoring/import/github", async (request, reply) => {
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
    try {
      const body = (request.body ?? {}) as { packageSource?: unknown; workflowSource?: unknown };
      const defaults = defaultAuthoringSources();
      const packageSource = typeof body.packageSource === "string" ? body.packageSource : defaults.packageSource;
      const workflowSource = typeof body.workflowSource === "string" ? body.workflowSource : defaults.workflowSource;
      const analysis = analyzeAuthoringSources(packageSource, workflowSource);
      const draft = await createAuthoringDraft(db, {
        packageSource, workflowSource, parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow,
        ...analysis.metadata, diagnostics: analysis.diagnostics, actor: actor(request.headers),
      });
      return reply.code(201).send(draft);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.create_failed" });
    }
  });
  app.get("/v1/authoring/templates", async () => {
    const names = ["kyc", "invoice"];
    const templates = await Promise.all(names.map(async (name) => ({
      id: name,
      packageSource: await readFile(resolve(domainsPath, name, "package.yaml"), "utf8"),
      workflowSource: await readFile(resolve(domainsPath, name, "workflow.yaml"), "utf8"),
    })));
    return { templates };
  });
  app.get<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId", async (request, reply) => {
    const draft = await getAuthoringDraft(db, request.params.draftId);
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    return { ...draft, events: await listAuthoringEvents(db, draft.draftId) };
  });
  app.put<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId", async (request, reply) => {
    try {
      const body = request.body as { expectedRevision?: unknown; packageSource?: unknown; workflowSource?: unknown };
      if (typeof body.expectedRevision !== "number" || typeof body.packageSource !== "string" || typeof body.workflowSource !== "string") {
        return reply.code(400).send({ error: "authoring.update_invalid" });
      }
      const analysis = analyzeAuthoringSources(body.packageSource, body.workflowSource);
      return await updateAuthoringSources(db, request.params.draftId, {
        expectedRevision: body.expectedRevision, packageSource: body.packageSource, workflowSource: body.workflowSource,
        parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow, ...analysis.metadata,
        diagnostics: analysis.diagnostics, actor: actor(request.headers),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "authoring.update_failed";
      return reply.code(message.includes("conflict") ? 409 : 400).send({ error: message });
    }
  });
  app.post<{ Params: { draftId: string; agentId: string } }>("/v1/authoring/drafts/:draftId/agents/:agentId/attach", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { expectedRevision?: unknown; nodeId?: unknown; mode?: unknown; newNodeId?: unknown };
      if (typeof body.expectedRevision !== "number" || typeof body.nodeId !== "string" || (body.mode !== "replace" && body.mode !== "insert-after")) {
        return reply.code(400).send({ error: "authoring.agent_attachment_invalid" });
      }
      const [draft, registered, registeredSkills] = await Promise.all([
        getAuthoringDraft(db, request.params.draftId),
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
        diagnostics: analysis.diagnostics, actor: actor(request.headers),
      });
      return { draft: updated, attachedNodeId: sources.attachedNodeId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "authoring.agent_attachment_failed";
      return reply.code(message.includes("conflict") ? 409 : 400).send({ error: message });
    }
  });
  app.put<{ Params: { draftId: string; nodeId: string } }>("/v1/authoring/drafts/:draftId/nodes/:nodeId/case-writes", async (request, reply) => {
    try {
      const body = (request.body ?? {}) as { expectedRevision?: unknown; caseWrites?: unknown };
      if (typeof body.expectedRevision !== "number" || !Array.isArray(body.caseWrites)) {
        return reply.code(400).send({ error: "authoring.case_writes_update_invalid" });
      }
      const draft = await getAuthoringDraft(db, request.params.draftId);
      if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
      const workflowSource = updateNodeCaseWrites(draft.workflowSource, request.params.nodeId, body.caseWrites);
      const analysis = analyzeAuthoringSources(draft.packageSource, workflowSource);
      const caseWriteErrors = analysis.diagnostics.filter((item) => item.severity === "error" && item.path.includes(`nodes.${request.params.nodeId}.config.caseWrites`));
      if (caseWriteErrors.length) return reply.code(422).send({ error: "authoring.case_writes_invalid", diagnostics: caseWriteErrors });
      return await updateAuthoringSources(db, draft.draftId, {
        expectedRevision: body.expectedRevision, packageSource: draft.packageSource, workflowSource,
        parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow, ...analysis.metadata,
        diagnostics: analysis.diagnostics, actor: actor(request.headers),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "authoring.case_writes_update_failed";
      return reply.code(message.includes("conflict") ? 409 : 400).send({ error: message });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/validate", async (request, reply) => {
    const draft = await getAuthoringDraft(db, request.params.draftId);
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    const analysis = analyzeAuthoringSources(draft.packageSource, draft.workflowSource);
    return { valid: !analysis.diagnostics.some((item) => item.severity === "error"), diagnostics: analysis.diagnostics };
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/compile", async (request, reply) => {
    try {
      let draft = await getAuthoringDraft(db, request.params.draftId);
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
          diagnostics: analysis.diagnostics, actor: actor(request.headers),
        });
      }
      const result = await compileAuthoringDraft({
        packageSource: draft.packageSource, workflowSource: draft.workflowSource,
        registryCapabilities: registry.filter((item) => item.capability.status === "active").map((item) => item.capability),
        modelProfilesPath: profilesPath,
      });
      if (!result.plan) return reply.code(422).send({ error: "authoring.compile_failed", diagnostics: result.diagnostics });
      return await setAuthoringLifecycle(db, draft.draftId, {
        expectedStatus: "DRAFT", status: "COMPILED", actor: actor(request.headers), compiledPlan: result.plan, diagnostics: result.diagnostics,
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.compile_failed" });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/evaluate", async (request, reply) => {
    try {
      const draft = await getAuthoringDraft(db, request.params.draftId);
      if (!draft?.compiledPlan) return reply.code(409).send({ error: "authoring.evaluate_requires_compiled" });
      const report = evaluateCompiledPlan(draft.compiledPlan);
      if (!report.passed) return reply.code(422).send({ error: "authoring.evaluation_failed", report });
      return await setAuthoringLifecycle(db, draft.draftId, { expectedStatus: "COMPILED", status: "EVALUATED", actor: actor(request.headers), evaluationReport: report });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "authoring.evaluate_failed" });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/approve", async (request, reply) => {
    try {
      return await setAuthoringLifecycle(db, request.params.draftId, { expectedStatus: "EVALUATED", status: "APPROVED", actor: actor(request.headers) });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "authoring.approve_failed" });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/publish", async (request, reply) => {
    try {
      const draft = await getAuthoringDraft(db, request.params.draftId);
      if (!draft?.compiledPlan || draft.status !== "APPROVED") return reply.code(409).send({ error: "authoring.publish_requires_approved" });
      await admitPlan(db, draft.compiledPlan);
      return await setAuthoringLifecycle(db, draft.draftId, { expectedStatus: "APPROVED", status: "PUBLISHED", actor: actor(request.headers), publishedPlanDigest: draft.compiledPlan.planDigest });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "authoring.publish_failed" });
    }
  });
  app.get("/v1/runs", async () => ({ runs: await listRuns(db) }));
  app.post("/v1/runs", async (request, reply) => {
    const parsed = runRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "run.request_invalid", issues: parsed.error.issues });
    if (!await getPlan(db, parsed.data.planDigest)) return reply.code(404).send({ error: "plan.not_found" });
    const key = String(request.headers["idempotency-key"] ?? "");
    if (!key) return reply.code(400).send({ error: "run.idempotency_key_required" });
    const result = await createRun(db, { planDigest: parsed.data.planDigest, runInput: parsed.data.input, idempotencyKey: key });
    return reply.code(result.created ? 202 : 200).send(result);
  });
  app.get<{ Params: { runId: string } }>("/v1/runs/:runId", async (request, reply) => {
    const run = await getRun(db, request.params.runId);
    return run ?? reply.code(404).send({ error: "run.not_found" });
  });
  app.get<{ Params: { runId: string } }>("/v1/runs/:runId/trace", async (request, reply) => {
    const run = await getRun(db, request.params.runId);
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
  app.get<{ Params: { runId: string }; Querystring: { after?: string } }>("/v1/runs/:runId/events", async (request) => ({
    events: await listEvents(db, request.params.runId, Number(request.query.after ?? 0)),
  }));
  app.get<{ Params: { runId: string } }>("/v1/runs/:runId/attempts", async (request, reply) => {
    if (!await getRun(db, request.params.runId)) return reply.code(404).send({ error: "run.not_found" });
    return { attempts: await listNodeAttempts(db, request.params.runId) };
  });
  app.get<{ Querystring: { runId?: string; decision?: string; limit?: string } }>("/v1/gateway/receipts", async (request, reply) => {
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
