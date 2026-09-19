import { createHash, randomUUID } from "node:crypto";
import type {
  CompiledHarnessPlan,
  CaseActivityView,
  CaseDetailView,
  CaseSummaryView,
  AuthoringDraftView,
  AgentRegistryItemView,
  CapabilityRegistryItemView,
  SkillRegistryItemView,
  ExplorerGraphEdge,
  ExplorerGraphNode,
  FailureBannerInfo,
  GatewayDecisionView,
  GatewayStatusView,
  HarnessDetail,
  HarnessSummary,
  ModelTierProfileView,
  NodeAttemptView,
  NodeExecutionState,
  NodePrimitive,
  OverviewIssueItem,
  OverviewView,
  RunDetail,
  RunEventView,
  RunStatus,
  RunSummary,
  ServiceReadinessItem,
  SystemView,
  ToolCapabilityView,
} from "./types";

const controlBase = (process.env.CONTROL_API_INTERNAL_URL ?? "http://127.0.0.1:4100").replace(/\/$/, "");
const gatewayBase = (process.env.CAPABILITY_GATEWAY_INTERNAL_URL ?? "http://127.0.0.1:4101").replace(/\/$/, "");
const jaegerBase = (process.env.JAEGER_API_INTERNAL_URL ?? "http://127.0.0.1:16686").replace(/\/$/, "");
const caseBase = (process.env.CASE_API_INTERNAL_URL ?? "http://127.0.0.1:4102").replace(/\/$/, "");
const caseTenantId = process.env.CASE_UI_TENANT_ID ?? "tenant_demo";

/**
 * Credential the control surface presents to the internal services.
 *
 * This module is the backend-for-frontend: it is the only component that has seen the
 * user, so it proves it is the edge and carries the acting persona onwards. The services
 * believe the persona only because the edge credential came with it -- the actor and
 * tenant headers used to be accepted from anyone.
 */
const edgeServiceToken = process.env.EDGE_SERVICE_TOKEN ?? "";

export type EdgePersona = "operator" | "approver";

const personas: Record<EdgePersona, { actorId: string; roles: string }> = {
  operator: {
    actorId: process.env.CONTROL_UI_ACTOR_ID ?? "local-author",
    roles: process.env.CONTROL_UI_ACTOR_ROLES
      ?? "Harness.Reader,Harness.Author,Harness.Operator,Case.Analyst,Case.Reviewer",
  },
  // Approval and publication run as a separate persona so the local demo exercises the
  // same separation of duties the deployed roles describe, instead of one identity
  // authoring and approving its own plan.
  approver: {
    actorId: process.env.CONTROL_UI_APPROVER_ID ?? "local-approver",
    roles: process.env.CONTROL_UI_APPROVER_ROLES ?? "Harness.Reader,Harness.Approver",
  },
};

function edgeHeaders(persona: EdgePersona = "operator"): Record<string, string> {
  const identity = personas[persona];
  return {
    ...(edgeServiceToken ? { authorization: `Bearer ${edgeServiceToken}` } : {}),
    "x-actor-id": identity.actorId,
    "x-actor-roles": identity.roles,
  };
}

type JsonMap = Record<string, unknown>;
type RawPlan = {
  apiVersion: string;
  kind: "HarnessPlan";
  planId: string;
  planDigest: string;
  packageDigest: string;
  compiler: { name: string; version: string; lgirCoreRevision: string };
  metadata: { name: string; version: string; domain: string; objective: string };
  execution: {
    engine: { kind: string; adapterVersion: string; profile: string };
    maxTransitions: number;
    maxConcurrency: number;
    durability: string;
  };
  budgets: { maxDurationMs: number; maxCostUsd: number; maxModelCalls: number; maxCapabilityCalls: number };
  schemas: { input: JsonMap; output: JsonMap };
  modelProfiles: { id: string; digest: string }[];
  capabilities: RawCapability[];
  permissionEnvelopes: { nodeId: string; capabilities: string[]; effects: string[]; digest: string }[];
  graph: {
    apiVersion: string;
    name: string;
    nodes: RawNode[];
    edges: { id: string; from: string; to: string; kind: string; condition?: string; sourcePath?: string; targetPath?: string }[];
    nodeOrder: string[];
  };
  dependencyManifest: { path: string; digest: string }[];
};
type RawCapability = {
  id: string;
  kind: "model" | "tool" | "deterministic";
  effect: string;
  adapterBindingId: string;
  inputSchema: JsonMap;
  outputSchema: JsonMap;
  timeoutMs: number;
  maxAttempts: number;
  idempotent: boolean;
};
type RawNode = {
  id: string;
  kind: string;
  name: string;
  summary?: string;
  prompt?: string;
  inputSchema?: JsonMap | null;
  outputSchema?: JsonMap | null;
  config: JsonMap;
};
type RawRun = {
  runId: string;
  idempotencyKey: string;
  planDigest: string;
  status: RunStatus;
  terminalOutcome: string | null;
  input: unknown;
  output: unknown | null;
  attempt: number;
  fencingEpoch: number;
  latestCheckpointId: string | null;
  currentNodeId: string | null;
  errorCode: string | null;
  traceId: string | null;
  rootSpanId: string | null;
  traceFlags: number | null;
  costUsd: number;
  costComplete: boolean;
  modelCalls: number;
  capabilityCalls: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
};
type RawEvent = {
  runId: string;
  sequence: number;
  code: string;
  nodeId: string | null;
  status: "observed" | "passed" | "failed" | "denied";
  values: JsonMap;
  occurredAt: string;
};
type RawAttempt = {
  runId: string; nodeId: string; attempt: number; fencingEpoch: number; status: string;
  inputDigest: string | null; outputDigest: string | null; checkpointId: string | null;
  startedAt: string; completedAt: string | null; errorCode: string | null;
  traceId: string | null; spanId: string | null;
};
type RawReceipt = {
  invocationId: string; runId: string; nodeId: string; attempt: number; fencingEpoch: number;
  planDigest: string; permissionDigest: string; capabilityId: string; effect: string;
  decision: "allowed" | "denied"; reasonCode: string; requestDigest: string;
  result: null | {
    status: string; errorCode: string | null; provider: string | null; model: string | null;
    providerRequestId: string | null; latencyMs: number; receiptDigest: string;
    usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
  };
  receiptDigest: string | null; traceId: string | null; spanId: string | null;
  createdAt: string; completedAt: string | null;
};

const KNOWN_EVENT_CODES = new Set([
  "run.admitted", "run.started", "run.completed", "run.failed", "run.denied",
  "node.started", "node.completed", "node.failed", "checkpoint.committed",
  "capability.requested", "capability.completed", "capability.denied",
]);

async function apiJson<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    cache: "no-store",
    ...init,
    headers: { ...edgeHeaders(), ...(init?.headers as Record<string, string> | undefined) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body as { error?: string; message?: string };
    throw new Error(error.message ?? error.error ?? `upstream.http_${response.status}`);
  }
  return body as T;
}

async function optionalJson<T>(base: string, path: string): Promise<T | null> {
  try {
    return await apiJson<T>(base, path);
  } catch {
    return null;
  }
}

function caseHeaders(): HeadersInit {
  // The tenant is a requested scope; the case service checks it against the assignment
  // the edge credential already carries and rejects anything wider.
  return { "x-tenant-id": caseTenantId };
}

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function primitive(kind: string, capability?: RawCapability): NodePrimitive {
  if (kind === "agent") return "agent";
  if (kind === "condition") return "condition";
  if (kind === "evaluate") return "evaluate";
  if (kind === "aggregator") return "aggregator";
  if (capability?.kind === "model") return "model";
  if (kind === "input" || kind === "output" || kind === "tool" || kind === "transform" || kind === "join") return kind;
  return "transform";
}

function mapPlan(raw: RawPlan, admittedAt: string): CompiledHarnessPlan {
  const ordered = raw.graph.nodeOrder.length
    ? raw.graph.nodeOrder.map((id) => raw.graph.nodes.find((node) => node.id === id)).filter(Boolean) as RawNode[]
    : raw.graph.nodes;
  const capabilityById = new Map(raw.capabilities.map((capability) => [capability.id, capability]));
  return {
    schemaVersion: raw.apiVersion,
    planDigest: raw.planDigest,
    name: raw.metadata.name,
    packageVersion: raw.metadata.version,
    domain: raw.metadata.domain,
    objective: raw.metadata.objective,
    compilerVersion: `${raw.compiler.name} ${raw.compiler.version} · ${raw.compiler.lgirCoreRevision.slice(0, 8)}`,
    admittedAt,
    inputSchema: raw.schemas.input as CompiledHarnessPlan["inputSchema"],
    outputSchema: raw.schemas.output,
    terminalOutcomes: [
      { code: "completed", label: "Completed", description: "Plan reached a schema-valid output.", category: "completed" },
      { code: "manual_review", label: "Manual review", description: "Plan requested human review.", category: "manual_review" },
      { code: "denied", label: "Denied", description: "Capability authority denied execution.", category: "denied" },
    ],
    failurePolicy: {
      defaultAction: "fail_closed",
      retryBackoff: "capability-defined",
      fencingMode: "monotonic PostgreSQL epoch",
      effectSafeGuard: "signed execution envelope",
    },
    budgets: {
      ...raw.budgets,
      maxRetries: Math.max(0, ...raw.capabilities.map((capability) => capability.maxAttempts - 1)),
      maxConcurrency: raw.execution.maxConcurrency,
    },
    dependencies: raw.dependencyManifest.map((dependency) => ({
      packageId: dependency.path,
      version: raw.metadata.version,
      digest: dependency.digest,
      kind: dependency.path.includes("schema") ? "schema" : "adapter",
    })),
    nodes: ordered.map((node, index) => {
      const capabilityId = typeof node.config.capabilityId === "string" ? node.config.capabilityId : undefined;
      const capability = capabilityId ? capabilityById.get(capabilityId) : undefined;
      const permission = raw.permissionEnvelopes.find((entry) => entry.nodeId === node.id);
      const adapterProfile = capability?.adapterBindingId.startsWith("openrouter:")
        ? capability.adapterBindingId.replace(/^openrouter:/, "")
        : undefined;
      return {
        id: node.id,
        name: node.name,
        primitive: primitive(node.kind, capability),
        purpose: node.summary || node.prompt || node.name,
        x: 115 + index * Math.min(200, 880 / Math.max(1, ordered.length - 1)),
        y: ordered.length > 3 && index > 0 && index < ordered.length - 1
          ? (index % 2 === 0 ? 175 : 85)
          : 130,
        ...(adapterProfile ? { modelTier: adapterProfile } : {}),
        ...(capabilityId ? { capabilityId } : {}),
        effectClass: capability?.effect === "none" || !capability
          ? "none"
          : capability.effect === "read"
            ? "read_only"
            : "external_mutation",
        allowedEffects: permission?.effects ?? [],
        permissionEnvelopeDigest: permission?.digest ?? sha({ planDigest: raw.planDigest, nodeId: node.id }),
        timeoutMs: capability?.timeoutMs ?? raw.budgets.maxDurationMs,
        maxRetries: Math.max(0, (capability?.maxAttempts ?? 1) - 1),
        maxCostUsd: capability?.kind === "model" ? raw.budgets.maxCostUsd : 0,
        inputSchema: node.inputSchema ?? capability?.inputSchema ?? {},
        outputSchema: node.outputSchema ?? capability?.outputSchema ?? {},
        caseWrites: Array.isArray(node.config.caseWrites)
          ? (node.config.caseWrites as Array<Record<string, unknown>>).flatMap((write) =>
              typeof write.commandType === "string" && write.payloadSchema && typeof write.payloadSchema === "object" && !Array.isArray(write.payloadSchema)
                ? [{
                    commandType: write.commandType,
                    ...(typeof write.when === "string" ? { when: write.when } : {}),
                    payloadSchema: write.payloadSchema as Record<string, unknown>,
                  }]
                : [],
            )
          : [],
      };
    }),
    edges: raw.graph.edges.map((edge) => ({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      ...(edge.condition ? { conditionLabel: edge.condition } : {}),
      mappingSummary: [edge.sourcePath, edge.targetPath].filter(Boolean).join(" → ") || edge.kind,
    })),
  };
}

async function planRecords(): Promise<{ raw: RawPlan; plan: CompiledHarnessPlan }[]> {
  const response = await apiJson<{ records: { plan: RawPlan; admittedAt: string }[] }>(controlBase, "/v1/plan-records");
  return response.records.map((record) => ({ raw: record.plan, plan: mapPlan(record.plan, record.admittedAt) }));
}

async function rawRuns(): Promise<RawRun[]> {
  return (await apiJson<{ runs: RawRun[] }>(controlBase, "/v1/runs")).runs;
}

async function gatewayStatusRaw() {
  return apiJson<{
    readiness: "Ready" | "Degraded" | "Unavailable";
    openRouterState: "Configured" | "Missing" | "Unreachable";
    runtimeMode: "OpenRouter" | "Recorded";
    envelopeVerifierStatus: string;
    generatedAt: string;
  }>(gatewayBase, "/v1/status");
}

function duration(run: RawRun): number {
  const start = new Date(run.startedAt ?? run.createdAt).getTime();
  const end = new Date(run.completedAt ?? run.updatedAt).getTime();
  return Math.max(0, end - start);
}

function summarizeRun(run: RawRun, plan: CompiledHarnessPlan, runtimeMode: "OpenRouter" | "Recorded", recentEvents: RawEvent[] = []): RunSummary {
  const needsAttention = ["failed", "denied", "retrying", "manual_review"].includes(run.status);
  return {
    runId: run.runId,
    planDigest: run.planDigest,
    harnessName: plan.name,
    packageVersion: plan.packageVersion,
    domain: plan.domain,
    status: run.status,
    terminalOutcome: run.terminalOutcome,
    currentNodeId: run.currentNodeId,
    attempt: run.attempt,
    fencingEpoch: run.fencingEpoch,
    modelTiers: plan.nodes.map((node) => node.modelTier).filter(Boolean) as string[],
    modelCalls: run.modelCalls,
    capabilityCalls: run.capabilityCalls,
    cost: { reportedUsd: run.costUsd, complete: run.costComplete },
    durationMs: duration(run),
    startedAt: run.startedAt ?? run.createdAt,
    updatedAt: run.updatedAt,
    fixture: runtimeMode === "Recorded",
    traceId: run.traceId,
    rootSpanId: run.rootSpanId,
    traceViewerUrl: run.traceId && process.env.TRACE_VIEWER_PUBLIC_URL
      ? `${process.env.TRACE_VIEWER_PUBLIC_URL.replace(/\/$/, "")}/trace/${run.traceId}`
      : run.traceId ? `http://localhost:16686/trace/${run.traceId}` : null,
    needsAttention,
    recentEventsPreview: recentEvents.slice(-3).reverse().map((event) => ({
      sequence: event.sequence,
      code: event.code,
      summary: eventSummary(event),
      occurredAt: event.occurredAt,
    })),
  };
}

function eventSummary(event: RawEvent): string {
  const supplied = event.values.summary;
  if (typeof supplied === "string") return supplied;
  return event.code.split(".").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export async function listHarnessSummaries(filters?: { query?: string; domain?: string; modelTier?: string }): Promise<HarnessSummary[]> {
  const [records, runs] = await Promise.all([planRecords(), rawRuns()]);
  return records.flatMap(({ plan }) => {
    const matches = runs.filter((run) => run.planDigest === plan.planDigest);
    const completed = matches.filter((run) => run.status === "completed").length;
    const durations = matches.map(duration).toSorted((left, right) => left - right);
    const summary: HarnessSummary = {
      planDigest: plan.planDigest,
      name: plan.name,
      packageVersion: plan.packageVersion,
      domain: plan.domain,
      objective: plan.objective,
      compilerVersion: plan.compilerVersion,
      admittedAt: plan.admittedAt,
      nodeCount: plan.nodes.length,
      edgeCount: plan.edges.length,
      modelTiers: plan.nodes.map((node) => node.modelTier).filter(Boolean) as string[],
      capabilityCount: plan.nodes.filter((node) => node.capabilityId).length,
      effectfulCapabilityCount: plan.nodes.filter((node) => node.effectClass !== "none" && node.effectClass !== "read_only").length,
      runs: matches.length,
      completedRuns: completed,
      completionRatePct: matches.length ? Math.round(completed / matches.length * 100) : null,
      meanReportedCost: {
        reportedUsd: matches.length ? matches.reduce((sum, run) => sum + run.costUsd, 0) / matches.length : 0,
        complete: matches.every((run) => run.costComplete),
      },
      p50DurationMs: durations.length ? durations[Math.floor((durations.length - 1) * 0.5)] ?? null : null,
      p95DurationMs: durations.length ? durations[Math.floor((durations.length - 1) * 0.95)] ?? null : null,
      lastRunAt: matches.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.updatedAt ?? null,
      nodesPreview: plan.nodes.map(({ id, name, primitive: nodePrimitive, x, y }) => ({ id, name, primitive: nodePrimitive, x, y })),
      edgesPreview: plan.edges.map(({ from, to }) => ({ from, to })),
    };
    const query = filters?.query?.toLowerCase();
    if (query && ![summary.name, summary.planDigest, summary.domain].some((value) => value.toLowerCase().includes(query))) return [];
    if (filters?.domain && filters.domain !== "all" && summary.domain !== filters.domain) return [];
    if (filters?.modelTier && filters.modelTier !== "all" && !summary.modelTiers.includes(filters.modelTier)) return [];
    return [summary];
  });
}

export async function getHarnessDetail(planDigest: string): Promise<HarnessDetail | null> {
  const [records, summaries, gateway] = await Promise.all([planRecords(), listHarnessSummaries(), gatewayStatusRaw()]);
  const digest = decodeURIComponent(planDigest);
  const record = records.find(({ plan }) => plan.planDigest === digest);
  const summary = summaries.find((item) => item.planDigest === digest);
  return record && summary ? { ...summary, plan: record.plan, fixture: gateway.runtimeMode === "Recorded" } : null;
}

export async function admitCompiledPlan(rawText: string): Promise<{
  admitted: boolean; collision: boolean; planDigest: string | null; diagnostics: string[]; summary?: HarnessSummary;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return { admitted: false, collision: false, planDigest: null, diagnostics: [error instanceof Error ? error.message : "Invalid JSON"] };
  }
  const digest = (parsed as { planDigest?: unknown }).planDigest;
  const response = await fetch(`${controlBase}/v1/plans`, {
    method: "POST",
    headers: { "content-type": "application/json", ...edgeHeaders() },
    body: JSON.stringify(parsed),
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as { created?: boolean; error?: string };
  if (!response.ok) {
    return { admitted: false, collision: false, planDigest: typeof digest === "string" ? digest : null, diagnostics: [body.error ?? `HTTP ${response.status}`] };
  }
  const summary = (await listHarnessSummaries()).find((item) => item.planDigest === digest);
  return {
    admitted: Boolean(body.created),
    collision: !body.created,
    planDigest: typeof digest === "string" ? digest : null,
    diagnostics: [body.created ? "Digest verified and plan admitted." : "Plan digest is already admitted."],
    ...(summary ? { summary } : {}),
  };
}

export async function listRuns(filters?: {
  query?: string; status?: string; planDigest?: string; domain?: string; modelTier?: string; onlyNeedsAttention?: boolean;
}): Promise<RunSummary[]> {
  const [runs, records, gateway] = await Promise.all([rawRuns(), planRecords(), gatewayStatusRaw()]);
  const plans = new Map(records.map(({ plan }) => [plan.planDigest, plan]));
  return runs.flatMap((run) => {
    const plan = plans.get(run.planDigest);
    if (!plan) return [];
    const summary = summarizeRun(run, plan, gateway.runtimeMode);
    const query = filters?.query?.toLowerCase();
    if (query && ![summary.runId, summary.harnessName, summary.planDigest].some((value) => value.toLowerCase().includes(query))) return [];
    if (filters?.status && filters.status !== "all" && summary.status !== filters.status) return [];
    if (filters?.planDigest && filters.planDigest !== "all" && summary.planDigest !== decodeURIComponent(filters.planDigest)) return [];
    if (filters?.domain && filters.domain !== "all" && summary.domain !== filters.domain) return [];
    if (filters?.modelTier && filters.modelTier !== "all" && !summary.modelTiers.includes(filters.modelTier)) return [];
    if (filters?.onlyNeedsAttention && !summary.needsAttention) return [];
    return [summary];
  });
}

function mapReceipt(receipt: RawReceipt): GatewayDecisionView {
  return {
    receiptId: receipt.invocationId,
    occurredAt: receipt.createdAt,
    runId: receipt.runId,
    nodeId: receipt.nodeId,
    attempt: receipt.attempt,
    fencingEpoch: receipt.fencingEpoch,
    capabilityId: receipt.capabilityId,
    effect: receipt.effect,
    decision: receipt.decision,
    reasonCode: receipt.reasonCode,
    adapterBindingId: receipt.result?.provider ?? null,
    latencyMs: receipt.result?.latencyMs ?? 0,
    resultStatus: receipt.result?.status ?? null,
    envelopeDigest: receipt.permissionDigest,
    requestDigest: receipt.requestDigest,
    resultDigest: receipt.receiptDigest,
    idempotencyKey: receipt.invocationId,
    traceId: receipt.traceId,
    spanId: receipt.spanId,
  };
}

function nodeState(nodeId: string, run: RawRun, attempts: RawAttempt[]): NodeExecutionState {
  const attempt = attempts.filter((entry) => entry.nodeId === nodeId).toSorted((a, b) => b.attempt - a.attempt)[0];
  if (attempt?.status === "running") return "executing";
  if (attempt?.status === "completed") return "completed";
  if (attempt?.status === "failed") return "failed";
  if (run.currentNodeId === nodeId && run.status === "retrying") return "retrying";
  if (run.currentNodeId === nodeId && run.status === "denied") return "denied";
  if (run.currentNodeId === nodeId && run.status === "running") return "executing";
  return "not_reached";
}

export async function getRunDetail(runId: string): Promise<RunDetail | null> {
  const encoded = encodeURIComponent(runId);
  const [runResponse, eventsResponse, attemptsResponse, receiptsResponse, records, gateway, traceResponse] = await Promise.all([
    optionalJson<RawRun>(controlBase, `/v1/runs/${encoded}`),
    optionalJson<{ events: RawEvent[] }>(controlBase, `/v1/runs/${encoded}/events`),
    optionalJson<{ attempts: RawAttempt[] }>(controlBase, `/v1/runs/${encoded}/attempts`),
    optionalJson<{ receipts: RawReceipt[] }>(controlBase, `/v1/gateway/receipts?runId=${encoded}`),
    planRecords(),
    gatewayStatusRaw(),
    optionalJson<{ traceId: string; rootSpanId: string; viewerUrl: string | null }>(controlBase, `/v1/runs/${encoded}/trace`),
  ]);
  if (!runResponse) return null;
  const plan = records.find(({ plan: candidate }) => candidate.planDigest === runResponse.planDigest)?.plan;
  if (!plan) return null;
  const events = eventsResponse?.events ?? [];
  const attempts = attemptsResponse?.attempts ?? [];
  const receipts = receiptsResponse?.receipts ?? [];
  const summary = summarizeRun(runResponse, plan, gateway.runtimeMode, events);
  if (traceResponse) {
    summary.traceId = traceResponse.traceId;
    summary.rootSpanId = traceResponse.rootSpanId;
    summary.traceViewerUrl = traceResponse.viewerUrl ?? summary.traceViewerUrl;
  }
  const eventViews: RunEventView[] = events.map((event) => ({
    id: `${event.runId}-event-${event.sequence}`,
    runId: event.runId,
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    code: event.code,
    nodeId: event.nodeId,
    attempt: typeof event.values.attempt === "number" ? event.values.attempt : runResponse.attempt,
    fencingEpoch: typeof event.values.fencingEpoch === "number" ? event.values.fencingEpoch : runResponse.fencingEpoch,
    status: event.status,
    durationMs: typeof event.values.durationMs === "number" ? event.values.durationMs : null,
    summary: eventSummary(event),
    details: event.values,
    isKnownCode: KNOWN_EVENT_CODES.has(event.code),
  }));
  const nodeAttempts: Record<string, NodeAttemptView> = {};
  for (const node of plan.nodes) {
    const matching = attempts.filter((entry) => entry.nodeId === node.id).toSorted((a, b) => b.attempt - a.attempt)[0];
    const calls = receipts.filter((receipt) => receipt.nodeId === node.id).map(mapReceipt);
    const modelCall = receipts.find((receipt) => receipt.nodeId === node.id && receipt.result?.model);
    const state = nodeState(node.id, runResponse, attempts);
    nodeAttempts[node.id] = {
      nodeId: node.id,
      nodeName: node.name,
      primitive: node.primitive,
      state,
      attempt: matching?.attempt ?? runResponse.attempt,
      fencingEpoch: matching?.fencingEpoch ?? runResponse.fencingEpoch,
      startedAt: matching?.startedAt ?? null,
      completedAt: matching?.completedAt ?? null,
      durationMs: matching?.completedAt ? new Date(matching.completedAt).getTime() - new Date(matching.startedAt).getTime() : null,
      retryClassification: matching && matching.attempt > 1 ? "runtime_retry" : "none",
      inputSchemaValid: Boolean(matching?.inputDigest),
      outputSchemaValid: matching ? matching.status === "completed" : null,
      redactedInput: { inputDigest: matching?.inputDigest ?? null, redactionPolicy: "Only content digests are persisted for node attempts." },
      validatedOutput: matching?.outputDigest ? { outputDigest: matching.outputDigest, checkpointId: matching.checkpointId } : null,
      validationDiagnostics: matching?.errorCode ? [matching.errorCode] : [],
      authority: {
        planDigest: runResponse.planDigest,
        permissionEnvelopeDigest: node.permissionEnvelopeDigest,
        executionEnvelopeId: calls[0]?.receiptId ?? "not-issued",
        audience: "gateway.runtime.local",
        issuedAt: matching?.startedAt ?? summary.startedAt,
        expiresAt: matching?.completedAt ?? summary.updatedAt,
        capabilityScope: node.capabilityId ? [node.capabilityId] : [],
        effectScope: node.allowedEffects,
        attempt: matching?.attempt ?? runResponse.attempt,
        fencingEpoch: matching?.fencingEpoch ?? runResponse.fencingEpoch,
      },
      usage: modelCall?.result ? {
        requestedTier: node.modelTier ?? "unknown",
        resolvedOpenRouterModel: modelCall.result.model ?? "recorded",
        adapterVersion: modelCall.result.provider ?? "openrouter",
        providerRequestId: modelCall.result.providerRequestId ?? modelCall.invocationId,
        temperature: 0,
        maxOutputTokens: 0,
        inputTokens: modelCall.result.usage.inputTokens ?? 0,
        outputTokens: modelCall.result.usage.outputTokens ?? 0,
        reportedCost: { reportedUsd: modelCall.result.usage.costUsd ?? 0, complete: modelCall.result.usage.costUsd !== null },
        latencyMs: modelCall.result.latencyMs,
      } : null,
      capabilityCalls: calls,
    };
  }
  const failureInfo: FailureBannerInfo | null = runResponse.errorCode ? {
    errorCode: runResponse.errorCode,
    title: "Harness execution stopped",
    explanation: typeof (runResponse.output as JsonMap | null)?.error === "string"
      ? String((runResponse.output as JsonMap).error)
      : runResponse.errorCode,
    failingNodeId: runResponse.currentNodeId ?? "runtime",
    failingNodeName: plan.nodes.find((node) => node.id === runResponse.currentNodeId)?.name ?? "Runtime",
    attempt: runResponse.attempt,
    fencingEpoch: runResponse.fencingEpoch,
    retryPermitted: false,
    externalEffectOccurred: receipts.some((receipt) => receipt.decision === "allowed" && receipt.effect !== "none" && receipt.effect !== "read"),
    lastCommittedCheckpoint: runResponse.latestCheckpointId ?? "none",
    suggestedOperatorAction: "Inspect the node attempt, capability receipt, and linked OpenTelemetry trace before repeating as a new run.",
  } : null;
  return {
    ...summary,
    idempotencyKey: runResponse.idempotencyKey,
    inputPayload: (runResponse.input && typeof runResponse.input === "object" ? runResponse.input : { value: runResponse.input }) as JsonMap,
    plan,
    nodeAttempts,
    failureInfo,
    events: eventViews,
  };
}

export async function startNewRun(params: { planDigest: string; inputPayload: JsonMap; idempotencyKey: string }): Promise<{
  created: boolean; deduplicated: boolean; runId: string; validationErrors: string[];
}> {
  const response = await fetch(`${controlBase}/v1/runs`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": params.idempotencyKey, ...edgeHeaders() },
    body: JSON.stringify({ planDigest: params.planDigest, input: params.inputPayload }),
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({})) as { created?: boolean; run?: RawRun; error?: string; issues?: unknown[] };
  if (!response.ok || !body.run) {
    return { created: false, deduplicated: false, runId: "", validationErrors: [body.error ?? `HTTP ${response.status}`] };
  }
  return { created: Boolean(body.created), deduplicated: !body.created, runId: body.run.runId, validationErrors: [] };
}

export async function listModelProfiles(): Promise<ModelTierProfileView[]> {
  const [response, status] = await Promise.all([
    apiJson<{ profiles: { id: string; provider: string; model: string; maxOutputTokens: number; timeoutMs: number; maxConcurrency: number }[] }>(gatewayBase, "/v1/model-profiles"),
    gatewayStatusRaw(),
  ]);
  return response.profiles.map((profile) => ({
    tierId: profile.id,
    version: "v1",
    purpose: `${profile.provider} capability tier`,
    profileDigest: sha(profile),
    resolvedOpenRouterModel: profile.model,
    maxInputTokens: 0,
    maxOutputTokens: profile.maxOutputTokens,
    timeoutMs: profile.timeoutMs,
    concurrencyLimit: profile.maxConcurrency,
    enabled: true,
    credentialState: status.openRouterState === "Configured" ? "Configured" : "Missing",
    lastSuccessAt: null,
  }));
}

export async function listToolCapabilities(): Promise<ToolCapabilityView[]> {
  const records = await planRecords();
  const capabilities = new Map<string, RawCapability>();
  for (const { raw } of records) {
    for (const capability of raw.capabilities) if (capability.kind !== "model") capabilities.set(capability.id, capability);
  }
  return [...capabilities.values()].map((capability) => ({
    capabilityId: capability.id,
    effectClass: capability.effect === "read" ? "read_only" : "external_mutation",
    adapterBindingId: capability.adapterBindingId,
    adapterVersion: capability.adapterBindingId.split(":").at(-1) ?? "v1",
    requestSchemaVersion: "json-schema",
    resultSchemaVersion: "json-schema",
    timeoutMs: capability.timeoutMs,
    retryPolicy: capability.maxAttempts > 1 ? `up to ${capability.maxAttempts} attempts` : "no retry",
    credentialState: capability.adapterBindingId.startsWith("simulator:") ? "Not required" : "Configured",
    health: "Healthy",
  }));
}

export async function listGatewayDecisions(decisionFilter?: string): Promise<GatewayDecisionView[]> {
  const query = decisionFilter && decisionFilter !== "all" ? `?decision=${encodeURIComponent(decisionFilter)}` : "";
  const response = await apiJson<{ receipts: RawReceipt[] }>(controlBase, `/v1/gateway/receipts${query}`);
  return response.receipts.map(mapReceipt);
}

export async function getGatewayStatus(): Promise<GatewayStatusView> {
  const [status, decisions] = await Promise.all([gatewayStatusRaw(), listGatewayDecisions()]);
  return {
    ...status,
    lastConnectionTestAt: null,
    lastConnectionLatencyMs: null,
    lastConnectionMessage: null,
    calls24h: decisions.length,
    denials24h: decisions.filter((decision) => decision.decision === "denied").length,
    telemetryFreshThrough: status.generatedAt,
  };
}

export async function runOpenRouterConnectionTest(): Promise<{
  status: string; latencyMs: number; testedAt: string; message: string; credentialState: string;
}> {
  return apiJson(gatewayBase, "/v1/openrouter/test", { method: "POST" });
}

async function serviceStatus(id: string, name: string, url: string, detail: string): Promise<ServiceReadinessItem> {
  const started = Date.now();
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(3_000) });
    return { id, name, status: response.ok ? "Ready" : "Degraded", detail, latencyMs: Date.now() - started };
  } catch {
    return { id, name, status: "Unavailable", detail, latencyMs: Date.now() - started };
  }
}

export async function getOverviewData(): Promise<OverviewView> {
  const [summaries, runs, profiles, gateway, services] = await Promise.all([
    listHarnessSummaries(),
    listRuns(),
    listModelProfiles(),
    getGatewayStatus(),
    Promise.all([
      serviceStatus("api", "Control-Plane API", `${controlBase}/health/ready`, "Plan admission and execution read models"),
      serviceStatus("gateway", "Capability Gateway", `${gatewayBase}/health/ready`, "Credential envelope and capability policy"),
      serviceStatus("cases", "Case Store API", `${caseBase}/health/ready`, `Canonical case, ledger, and evidence views for ${caseTenantId}`),
      serviceStatus("jaeger", "OpenTelemetry / Jaeger", `${jaegerBase}/api/services`, "Cross-service trace store and viewer"),
    ]),
  ]);
  const activeRuns = runs.filter((run) => ["queued", "running", "retrying"].includes(run.status));
  const issueRuns = runs.filter((run) => run.needsAttention).slice(0, 5);
  const recentIssues: OverviewIssueItem[] = issueRuns.map((run) => ({
    id: `issue-${run.runId}`,
    category: run.status === "denied" ? "gateway_denial" : run.status === "retrying" ? "stale_fencing_attempt" : "invalid_output",
    code: run.status.toUpperCase(),
    title: `${run.harnessName} requires attention`,
    runId: run.runId,
    harnessName: run.harnessName,
    nodeId: run.currentNodeId ?? "runtime",
    occurredAt: run.updatedAt,
    summary: run.traceId ? `Execution trace ${run.traceId} is available for inspection.` : "Execution stopped without a bound trace.",
  }));
  const failedCount = runs.filter((run) => run.status === "failed").length;
  const deniedCount = runs.filter((run) => run.status === "denied").length;
  const retryingCount = runs.filter((run) => run.status === "retrying").length;
  const now = new Date().toISOString();
  const globalReadiness = services.some((service) => service.status === "Unavailable") ? "Degraded" : "Ready";
  return {
    window: "24h",
    admittedHarnessesCount: summaries.length,
    activeRunsCount: activeRuns.length,
    queuedCount: runs.filter((run) => run.status === "queued").length,
    runningCount: runs.filter((run) => run.status === "running").length,
    retryingCount,
    needsAttentionCount: failedCount + deniedCount + retryingCount,
    failedCount,
    deniedCount,
    staleLeaseCount: retryingCount,
    reportedCost24h: {
      reportedUsd: runs.reduce((sum, run) => sum + run.cost.reportedUsd, 0),
      complete: runs.every((run) => run.cost.complete),
    },
    activeRuns,
    recentIssues,
    serviceStatus: services,
    modelTiers: profiles,
    runtimeMode: gateway.runtimeMode,
    fixture: gateway.runtimeMode === "Recorded",
    globalReadiness,
    generatedAt: now,
    telemetryFreshThrough: now,
  };
}

export async function getSystemStatus(): Promise<SystemView> {
  const overview = await getOverviewData();
  const runs = await listRuns();
  const now = new Date().toISOString();
  const defaultProvider = process.env.RUNTIME_PROVIDER === "azure_foundry" ? "azure_foundry" : "local_http";
  const azureFoundryConfigured = Boolean(
    process.env.FOUNDRY_AGENT_INVOCATION_ENDPOINT
    && process.env.FOUNDRY_AGENT_NAME
    && process.env.FOUNDRY_AGENT_VERSION,
  );
  return {
    globalReadiness: overview.globalReadiness,
    runtimeMode: overview.runtimeMode,
    environment: "local",
    fixture: overview.fixture,
    componentReadiness: overview.serviceStatus,
    runtimeIsolation: {
      scope: "harness_invocation",
      defaultProvider,
      selectionAuthority: "Agent runtimeTarget in the immutable compiled plan; environment default when absent",
      mixedTargetsAllowed: false,
      providers: [
        {
          id: "local_http",
          name: "Local isolated runtime",
          boundary: "Dedicated read-only runtime-host container",
          authentication: "Signed invocation contract + private host token",
          configured: true,
        },
        {
          id: "azure_foundry",
          name: "Azure Foundry hosted agent",
          boundary: "Hosted-agent project and execution identity",
          authentication: "Microsoft Entra workload identity",
          configured: azureFoundryConfigured,
        },
      ],
    },
    buildMetadata: {
      uiVersion: process.env.CONTROL_UI_VERSION ?? "0.1.0",
      apiVersion: "v1",
      runtimeVersion: "langgraph-js · harness-langgraph-v1",
      compilerVersion: "harnessc 0.1.0",
      adapterBundleVersion: "openrouter + simulator",
      commitSha: process.env.BUILD_COMMIT_SHA ?? "local",
      builtAt: process.env.BUILD_TIMESTAMP ?? now,
    },
    queueWorkState: {
      ready: runs.filter((run) => run.status === "queued").length,
      leased: runs.filter((run) => run.status === "running").length,
      retrying: runs.filter((run) => run.status === "retrying").length,
      stale: 0,
      activeWorkers: runs.some((run) => run.status === "running") ? 1 : 0,
      fencingAuthority: "PostgreSQL monotonic fencing_epoch",
    },
    databaseMigrationVersion: "004_agent_skill_registry",
    supportedPrimitives: [
      ["input", true, "Canonical input admission."],
      ["transform", true, "Deterministic state transformation."],
      ["agent", false, "Registered agent contract resolved through a model capability tier."],
      ["model", false, "Tier-routed OpenRouter invocation through the capability gateway."],
      ["tool", true, "Envelope-authorized capability invocation."],
      ["condition", true, "Deterministic control-edge routing."],
      ["evaluate", true, "Policy and model-assisted evaluation."],
      ["join", true, "All-source or typed all-settled branch synchronization."],
      ["aggregator", true, "Deterministic collect, merge, concat, or vote reduction."],
      ["output", true, "Terminal output sealing."],
    ].map(([nodePrimitive, deterministicReplay, description]) => ({
      primitive: nodePrimitive as NodePrimitive,
      profileVersion: "harness-langgraph-v1",
      deterministicReplay: deterministicReplay as boolean,
      description: description as string,
    })),
    knownPocLimitations: [
      { id: "lim-1", area: "Single local worker", explanation: "The POC proves leases and fencing locally; horizontal worker scaling is a cloud-phase concern." },
      { id: "lim-2", area: "Recorded adapter fallback", explanation: "Without OPENROUTER_API_KEY, model calls use deterministic recorded responses and are labeled accordingly." },
      { id: "lim-3", area: "Operator actions", explanation: "Runs are immutable. Recovery creates a new idempotent run instead of mutating prior execution history." },
      { id: "lim-4", area: "Trace retention", explanation: "Jaeger uses local ephemeral storage unless a durable backend is configured." },
    ],
    generatedAt: now,
    telemetryFreshThrough: now,
  };
}

type RawCaseSummary = {
  tenantId: string;
  caseId: string;
  caseType: string;
  schemaVersion: string;
  jurisdiction: string;
  status: string;
  caseSequence: number;
  externalRef: string;
  policySnapshotDigest: string;
  harnessPlanDigest: string;
  classification: string;
  createdAt: string;
  updatedAt: string;
};

type RawCaseEvent = {
  eventId: string;
  caseSequence: number;
  eventType: string;
  occurredAt: string;
  actor: JsonMap;
  authority: JsonMap;
  payload: JsonMap;
  evidenceRefs: string[];
  previousEventDigest: string | null;
  eventDigest: string;
};

type RawCaseView = {
  generatedAt: string;
  viewSchema: string;
  etag: string;
  case: RawCaseSummary;
  subjects: JsonMap[];
  evidence: JsonMap[];
  claims: JsonMap[];
  facts: JsonMap[];
  findings: JsonMap[];
  assumptions: JsonMap[];
  contradictions: JsonMap[];
  workItems: JsonMap[];
  decisionRecommendations: JsonMap[];
  gateResults: JsonMap[];
  reviews: JsonMap[];
  finalDispositions: JsonMap[];
  executionRefs: JsonMap[];
  lineageEdges: JsonMap[];
};

function mapCaseSummary(item: RawCaseSummary): CaseSummaryView {
  return {
    tenantId: item.tenantId,
    caseId: item.caseId,
    caseType: item.caseType,
    jurisdiction: item.jurisdiction,
    status: item.status,
    caseSequence: item.caseSequence,
    externalRef: item.externalRef,
    harnessPlanDigest: item.harnessPlanDigest,
    classification: item.classification,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export async function listCaseSummaries(filters?: { status?: string; query?: string }): Promise<CaseSummaryView[]> {
  const query = filters?.status && filters.status !== "all"
    ? `?status=${encodeURIComponent(filters.status)}`
    : "";
  const response = await apiJson<{ cases: RawCaseSummary[] }>(caseBase, `/v1/cases${query}`, { headers: caseHeaders() });
  const needle = filters?.query?.trim().toLowerCase();
  return response.cases.map(mapCaseSummary).filter((item) => !needle || [
    item.caseId,
    item.externalRef,
    item.caseType,
    item.status,
  ].some((value) => value.toLowerCase().includes(needle)));
}

export async function createDemoKycCase(input: {
  planDigest: string;
  tenantId?: string;
  name?: string;
  country?: string;
  customerType?: string;
  riskTier?: string;
  policySnapshotDigest?: string;
}): Promise<{ caseId: string; subjectId: string; inputPatch: JsonMap }> {
  const tenantId = input.tenantId?.trim() || caseTenantId;
  const name = input.name?.trim() || "Ada Lovelace";
  const country = input.country?.trim().toUpperCase() || "US";
  if (country !== "US") throw new Error("demo_case.us_jurisdiction_only");
  const customerType = input.customerType === "sole_proprietor" ? "sole_proprietor" : "individual";
  const riskTier = ["standard", "elevated", "high"].includes(input.riskTier ?? "") ? input.riskTier! : "standard";
  const requestedPolicyDigest = input.policySnapshotDigest?.trim() ?? "";
  const policySnapshotDigest = /^[a-f0-9]{64}$/i.test(requestedPolicyDigest)
    ? requestedPolicyDigest
    : "b".repeat(64);
  const demoId = randomUUID();
  const actor = { type: "SYSTEM", principalId: "control-surface-demo-intake", roles: [] };
  const idempotencyKey = `ui-demo:${demoId}`;
  const created = await apiJson<{ case: RawCaseSummary }>(caseBase, "/v1/cases", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": `${idempotencyKey}:case` },
    body: JSON.stringify({
      tenantId,
      externalRef: `KYC-DEMO-${demoId.slice(0, 8)}`,
      policySnapshotDigest,
      harnessPlanDigest: input.planDigest,
      actor,
    }),
  });
  const subjectId = `subject_demo_${demoId.replaceAll("-", "").slice(0, 16)}`;
  const permissionEnvelopeDigest = sha({ action: "AddSubject", planDigest: input.planDigest, source: "control-surface-demo" });
  const subjectResult = await apiJson<{ createdIdentifiers?: { subjectId?: string } }>(
    caseBase,
    `/v1/cases/${encodeURIComponent(created.case.caseId)}/commands`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        commandId: `cmd_demo_${demoId.replaceAll("-", "")}`,
        commandType: "AddSubject",
        commandVersion: "kyc.command.add_subject.v1",
        tenantId,
        caseId: created.case.caseId,
        actor,
        authority: {
          planDigest: input.planDigest,
          permissionEnvelopeDigest,
          policySnapshotDigest,
        },
        payload: {
          subjectId,
          subjectType: "individual",
          displayName: name,
          attributes: { country, customerType, riskTier },
          identifiers: [],
        },
        preconditions: { caseSequence: created.case.caseSequence },
        idempotencyKey: `${idempotencyKey}:subject`,
      }),
    },
  );
  const createdSubjectId = subjectResult.createdIdentifiers?.subjectId ?? subjectId;
  return {
    caseId: created.case.caseId,
    subjectId: createdSubjectId,
    inputPatch: {
      tenantId,
      caseId: created.case.caseId,
      subjectId: createdSubjectId,
      name,
      aliases: [],
      country,
      customerType,
      riskTier,
      policySnapshotDigest,
      linkedEvidenceRefs: [],
    },
  };
}

const CASE_CATEGORY_ORDER = [
  "Case",
  "Subject",
  "Work",
  "Evidence",
  "Claim",
  "Fact",
  "Finding",
  "Decision",
  "Assurance",
  "Outcome",
  "Execution",
];

function stringValue(record: JsonMap, ...keys: string[]): string | null {
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return null;
}

function nodeLabel(record: JsonMap, category: string, id: string): string {
  return stringValue(
    record,
    "display_name",
    "predicate",
    "finding_type",
    "work_type",
    "review_type",
    "evidence_type",
    "outcome",
    "decision",
    "purpose",
  ) ?? `${category} ${id.slice(-8)}`;
}

function nodeStatus(record: JsonMap): string | undefined {
  return stringValue(record, "status", "outcome", "decision", "verification_status") ?? undefined;
}

function makeGraphNode(record: JsonMap, category: string, idKeys: string[]): ExplorerGraphNode | null {
  const id = stringValue(record, ...idKeys);
  if (!id) return null;
  return {
    id,
    label: nodeLabel(record, category, id),
    subtitle: id,
    category,
    status: nodeStatus(record),
    data: record,
  };
}

function refs(record: JsonMap, key: string): string[] {
  return Array.isArray(record[key]) ? (record[key] as unknown[]).filter((value): value is string => typeof value === "string") : [];
}

function buildCaseGraph(view: RawCaseView): { nodes: ExplorerGraphNode[]; edges: ExplorerGraphEdge[]; categories: string[] } {
  const root: ExplorerGraphNode = {
    id: view.case.caseId,
    label: view.case.externalRef || view.case.caseId,
    subtitle: view.case.caseType,
    category: "Case",
    status: view.case.status,
    data: view.case as unknown as JsonMap,
  };
  const groups: Array<{ category: string; records: JsonMap[]; keys: string[] }> = [
    { category: "Subject", records: view.subjects, keys: ["subject_id"] },
    { category: "Work", records: view.workItems, keys: ["work_item_id"] },
    { category: "Evidence", records: view.evidence, keys: ["evidence_id"] },
    { category: "Claim", records: view.claims, keys: ["claim_id"] },
    { category: "Fact", records: view.facts, keys: ["fact_id"] },
    { category: "Finding", records: [...view.findings, ...view.assumptions, ...view.contradictions], keys: ["finding_id", "assumption_id", "contradiction_id"] },
    { category: "Decision", records: view.decisionRecommendations, keys: ["recommendation_id"] },
    { category: "Assurance", records: [...view.gateResults, ...view.reviews], keys: ["gate_result_id", "review_id"] },
    { category: "Outcome", records: view.finalDispositions, keys: ["disposition_id"] },
    { category: "Execution", records: view.executionRefs, keys: ["run_id"] },
  ];
  const nodes = [root, ...groups.flatMap(({ category, records, keys }) => records.map((record) => makeGraphNode(record, category, keys)).filter((node): node is ExplorerGraphNode => Boolean(node)))];
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges: ExplorerGraphEdge[] = [];
  const seen = new Set<string>();
  const add = (from: string | null, to: string | null, label: string) => {
    if (!from || !to || !nodeIds.has(from) || !nodeIds.has(to)) return;
    const key = `${from}|${to}|${label}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ id: `edge-${edges.length + 1}`, from, to, label });
  };

  for (const edge of view.lineageEdges) {
    add(stringValue(edge, "source_id"), stringValue(edge, "target_id"), stringValue(edge, "predicate") ?? "LINEAGE");
  }
  for (const subject of view.subjects) add(view.case.caseId, stringValue(subject, "subject_id"), "HAS_SUBJECT");
  for (const work of view.workItems) {
    const workId = stringValue(work, "work_item_id");
    add(view.case.caseId, workId, "HAS_WORK");
    for (const target of refs(work, "result_refs")) add(workId, target, "PRODUCED");
  }
  for (const evidence of view.evidence) {
    const evidenceId = stringValue(evidence, "evidence_id");
    for (const subject of refs(evidence, "subject_refs")) add(subject, evidenceId, "EVIDENCED_BY");
  }
  for (const recommendation of view.decisionRecommendations) {
    const id = stringValue(recommendation, "recommendation_id");
    for (const finding of refs(recommendation, "finding_refs")) add(finding, id, "SUPPORTS");
    for (const evidence of refs(recommendation, "evidence_refs")) add(evidence, id, "INFORMS");
  }
  for (const gate of view.gateResults) {
    const gateId = stringValue(gate, "gate_result_id");
    add(stringValue(gate, "recommendation_ref"), gateId, "GATED_BY");
    if (Array.isArray(gate.rule_results)) {
      for (const result of gate.rule_results as JsonMap[]) add(stringValue(result, "ref"), gateId, "RULE_INPUT");
    }
  }
  for (const review of view.reviews) {
    const reviewId = stringValue(review, "review_id");
    add(stringValue(review, "object_ref"), reviewId, "REVIEWED_BY");
    for (const evidence of refs(review, "viewed_evidence_refs")) add(evidence, reviewId, "VIEWED_IN");
  }
  for (const disposition of view.finalDispositions) {
    const id = stringValue(disposition, "disposition_id");
    add(stringValue(disposition, "recommendation_ref"), id, "DISPOSITION");
    add(stringValue(disposition, "gate_result_ref"), id, "AUTHORIZED");
    add(stringValue(disposition, "review_ref"), id, "HUMAN_APPROVAL");
  }
  for (const execution of view.executionRefs) add(view.case.caseId, stringValue(execution, "run_id"), "EXECUTED_AS");

  const categories = CASE_CATEGORY_ORDER.filter((category) => nodes.some((node) => node.category === category));
  return { nodes, edges, categories };
}

function actorLabel(actor: JsonMap): string {
  const principal = stringValue(actor, "principalId") ?? "unknown";
  const type = stringValue(actor, "type") ?? "ACTOR";
  return `${type.toLowerCase()} · ${principal}`;
}

export async function getCaseDetail(caseId: string): Promise<CaseDetailView | null> {
  const encoded = encodeURIComponent(decodeURIComponent(caseId));
  let view: RawCaseView;
  try {
    view = await apiJson<RawCaseView>(caseBase, `/v1/cases/${encoded}`, { headers: caseHeaders() });
  } catch (error) {
    if (error instanceof Error && error.message.includes("case.not_found")) return null;
    throw error;
  }
  const eventResponse = await apiJson<{ events: RawCaseEvent[] }>(caseBase, `/v1/cases/${encoded}/events`, { headers: caseHeaders() });
  const activities: CaseActivityView[] = eventResponse.events.map((event) => ({
    eventId: event.eventId,
    sequence: event.caseSequence,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    actorLabel: actorLabel(event.actor),
    evidenceRefs: event.evidenceRefs,
    eventDigest: event.eventDigest,
    previousEventDigest: event.previousEventDigest,
    payload: event.payload,
    authority: event.authority,
  }));
  const objectGroups: Array<[string, JsonMap[]]> = [
    ["subjects", view.subjects], ["evidence", view.evidence], ["claims", view.claims], ["facts", view.facts],
    ["findings", view.findings], ["assumptions", view.assumptions], ["contradictions", view.contradictions],
    ["workItems", view.workItems], ["recommendations", view.decisionRecommendations], ["gates", view.gateResults],
    ["reviews", view.reviews], ["dispositions", view.finalDispositions], ["executions", view.executionRefs],
  ];
  const last = activities.at(-1);
  return {
    generatedAt: view.generatedAt,
    viewSchema: view.viewSchema,
    etag: view.etag,
    case: mapCaseSummary(view.case),
    counts: Object.fromEntries(objectGroups.map(([name, records]) => [name, records.length])),
    graph: buildCaseGraph(view),
    activities,
    executionRefs: view.executionRefs,
    ledger: {
      eventCount: activities.length,
      latestSequence: last?.sequence ?? 0,
      headDigest: last?.eventDigest ?? null,
    },
  };
}

type RawAuthoringDraft = Omit<AuthoringDraftView, "compiledPlan"> & { compiledPlan: RawPlan | null };

function mapAuthoringDraft(draft: RawAuthoringDraft): AuthoringDraftView {
  return {
    ...draft,
    compiledPlan: draft.compiledPlan ? mapPlan(draft.compiledPlan, draft.updatedAt) : null,
  };
}

export async function listAuthoringDraftsView(): Promise<AuthoringDraftView[]> {
  const response = await apiJson<{ drafts: RawAuthoringDraft[] }>(controlBase, "/v1/authoring/drafts");
  return response.drafts.map(mapAuthoringDraft);
}

export async function getAuthoringDraftView(draftId: string): Promise<AuthoringDraftView | null> {
  try {
    const draft = await apiJson<RawAuthoringDraft>(controlBase, `/v1/authoring/drafts/${encodeURIComponent(decodeURIComponent(draftId))}`);
    return mapAuthoringDraft(draft);
  } catch (error) {
    if (error instanceof Error && error.message.includes("authoring.draft_not_found")) return null;
    throw error;
  }
}

export async function createAuthoringDraftView(input: { packageSource?: string; workflowSource?: string }): Promise<AuthoringDraftView> {
  const draft = await apiJson<RawAuthoringDraft>(controlBase, "/v1/authoring/drafts", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  return mapAuthoringDraft(draft);
}

export async function updateAuthoringDraftView(draftId: string, input: { expectedRevision: number; packageSource: string; workflowSource: string }): Promise<AuthoringDraftView> {
  const draft = await apiJson<RawAuthoringDraft>(controlBase, `/v1/authoring/drafts/${encodeURIComponent(decodeURIComponent(draftId))}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  return mapAuthoringDraft(draft);
}

export async function advanceAuthoringDraft(draftId: string, action: "compile" | "evaluate" | "approve" | "publish"): Promise<AuthoringDraftView> {
  // Approval and publication are the approver's actions; compile and evaluate are the
  // author's. Sending both as one identity is what made self-approval invisible.
  const persona: EdgePersona = action === "approve" || action === "publish" ? "approver" : "operator";
  const draft = await apiJson<RawAuthoringDraft>(controlBase, `/v1/authoring/drafts/${encodeURIComponent(decodeURIComponent(draftId))}/${action}`, {
    method: "POST", headers: edgeHeaders(persona),
  });
  return mapAuthoringDraft(draft);
}

export async function listAuthoringTemplates(): Promise<Array<{ id: string; packageSource: string; workflowSource: string }>> {
  return (await apiJson<{ templates: Array<{ id: string; packageSource: string; workflowSource: string }> }>(controlBase, "/v1/authoring/templates")).templates;
}

export async function listCapabilityRegistry(): Promise<CapabilityRegistryItemView[]> {
  return (await apiJson<{ capabilities: CapabilityRegistryItemView[] }>(gatewayBase, "/v1/capabilities")).capabilities;
}

export async function registerCapabilityView(input: unknown): Promise<{ created: boolean; capability: CapabilityRegistryItemView["capability"]; digest: string }> {
  return apiJson(gatewayBase, "/v1/capabilities", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}

export async function listAuthoringAgentsView(): Promise<AgentRegistryItemView[]> {
  return (await apiJson<{ agents: AgentRegistryItemView[] }>(controlBase, "/v1/authoring/agents")).agents;
}

export async function listAuthoringSkillsView(): Promise<SkillRegistryItemView[]> {
  return (await apiJson<{ skills: SkillRegistryItemView[] }>(controlBase, "/v1/authoring/skills")).skills;
}

export async function registerAuthoringSkillView(input: unknown): Promise<{ created: boolean } & SkillRegistryItemView> {
  return apiJson(controlBase, "/v1/authoring/skills", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}

export async function registerAuthoringAgentView(input: unknown): Promise<{ created: boolean } & AgentRegistryItemView> {
  return apiJson(controlBase, "/v1/authoring/agents", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
}

export async function importAuthoringAgentFromGithub(url: string): Promise<{ agent: { created: boolean } & AgentRegistryItemView; skills: Array<{ created: boolean } & SkillRegistryItemView> }> {
  return apiJson(controlBase, "/v1/authoring/import/github", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
}

export async function attachAuthoringAgentView(draftId: string, agentId: string, input: { expectedRevision: number; nodeId: string; mode: "replace" | "insert-after"; newNodeId?: string }): Promise<{ draft: AuthoringDraftView; attachedNodeId: string }> {
  const result = await apiJson<{ draft: RawAuthoringDraft; attachedNodeId: string }>(controlBase, `/v1/authoring/drafts/${encodeURIComponent(decodeURIComponent(draftId))}/agents/${encodeURIComponent(agentId)}/attach`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  return { draft: mapAuthoringDraft(result.draft), attachedNodeId: result.attachedNodeId };
}

export async function updateNodeCaseWritesView(draftId: string, nodeId: string, input: { expectedRevision: number; caseWrites: unknown[] }): Promise<AuthoringDraftView> {
  const draft = await apiJson<RawAuthoringDraft>(controlBase, `/v1/authoring/drafts/${encodeURIComponent(decodeURIComponent(draftId))}/nodes/${encodeURIComponent(nodeId)}/case-writes`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  });
  return mapAuthoringDraft(draft);
}
