export type RunStatus =
  | "queued"
  | "running"
  | "retrying"
  | "completed"
  | "manual_review"
  | "denied"
  | "failed";

export type NodeExecutionState =
  | "not_reached"
  | "queued"
  | "executing"
  | "completed"
  | "skipped"
  | "retrying"
  | "denied"
  | "failed"
  | "terminal";

export type NodePrimitive =
  | "input"
  | "transform"
  | "agent"
  | "model"
  | "tool"
  | "condition"
  | "evaluate"
  | "join"
  | "aggregator"
  | "output";

export type CostView = {
  reportedUsd: number;
  complete: boolean;
};

export type NativeTraceSpan = {
  spanId: string;
  parentSpanId: string | null;
  operationName: string;
  serviceName: string;
  startTime: string;
  startOffsetMs: number;
  durationMs: number;
  depth: number;
  status: "ok" | "error";
  tags: Record<string, unknown>;
};

export type NativeTraceView = {
  generatedAt: string;
  traceId: string;
  startedAt: string;
  durationMs: number;
  spanCount: number;
  services: string[];
  rawViewerUrl: string;
  spans: NativeTraceSpan[];
};

export type PlanNode = {
  id: string;
  name: string;
  primitive: NodePrimitive;
  purpose: string;
  x: number;
  y: number;
  modelTier?: string;
  capabilityId?: string;
  effectClass: "none" | "read_only" | "external_mutation" | "ledger_hold";
  allowedEffects: string[];
  permissionEnvelopeDigest: string;
  timeoutMs: number;
  maxRetries: number;
  maxCostUsd: number;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  caseWrites: {
    commandType: string;
    when?: string;
    payloadSchema: Record<string, unknown>;
  }[];
};

export type PlanEdge = {
  id: string;
  from: string;
  to: string;
  conditionLabel?: string;
  mappingSummary: string;
};

export type PlanBudgets = {
  maxDurationMs: number;
  maxModelCalls: number;
  maxCapabilityCalls: number;
  maxCostUsd: number;
  maxRetries: number;
  maxConcurrency: number;
};

export type PlanDependency = {
  packageId: string;
  version: string;
  digest: string;
  kind: "schema" | "adapter" | "policy_envelope" | "evaluator";
};

export type CompiledHarnessPlan = {
  schemaVersion: string;
  planDigest: string;
  name: string;
  packageVersion: string;
  domain: string;
  objective: string;
  compilerVersion: string;
  admittedAt: string;
  inputSchema: {
    type: "object";
    required?: string[];
    properties: Record<
      string,
      {
        type: string;
        title?: string;
        description?: string;
        default?: unknown;
        enum?: string[];
      }
    >;
  };
  outputSchema: Record<string, unknown>;
  terminalOutcomes: {
    code: string;
    label: string;
    description: string;
    category: "completed" | "manual_review" | "denied";
  }[];
  failurePolicy: {
    defaultAction: string;
    retryBackoff: string;
    fencingMode: string;
    effectSafeGuard: string;
  };
  budgets: PlanBudgets;
  dependencies: PlanDependency[];
  nodes: PlanNode[];
  edges: PlanEdge[];
};

export type HarnessSummary = {
  planDigest: string;
  name: string;
  packageVersion: string;
  domain: string;
  objective: string;
  compilerVersion: string;
  admittedAt: string;
  nodeCount: number;
  edgeCount: number;
  modelTiers: string[];
  capabilityCount: number;
  effectfulCapabilityCount: number;
  runs: number;
  completedRuns: number;
  completionRatePct: number | null;
  meanReportedCost: CostView;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  lastRunAt: string | null;
  nodesPreview: { id: string; name: string; primitive: NodePrimitive; x: number; y: number }[];
  edgesPreview: { from: string; to: string }[];
};

export type HarnessDetail = HarnessSummary & {
  plan: CompiledHarnessPlan;
  fixture: boolean;
};

export type RunSummary = {
  runId: string;
  planDigest: string;
  harnessName: string;
  packageVersion: string;
  domain: string;
  status: RunStatus;
  terminalOutcome: string | null;
  currentNodeId: string | null;
  attempt: number;
  fencingEpoch: number;
  modelTiers: string[];
  modelCalls: number;
  capabilityCalls: number;
  cost: CostView;
  durationMs: number | null;
  startedAt: string;
  updatedAt: string;
  fixture: boolean;
  traceId: string | null;
  rootSpanId: string | null;
  traceViewerUrl: string | null;
  needsAttention: boolean;
  recentEventsPreview?: {
    sequence: number;
    code: string;
    summary: string;
    occurredAt: string;
  }[];
};

export type NodeAttemptView = {
  nodeId: string;
  nodeName: string;
  primitive: NodePrimitive;
  state: NodeExecutionState;
  attempt: number;
  fencingEpoch: number;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  retryClassification: string | null;
  inputSchemaValid: boolean;
  outputSchemaValid: boolean | null;
  redactedInput: Record<string, unknown>;
  validatedOutput: Record<string, unknown> | null;
  validationDiagnostics: string[];
  authority: {
    planDigest: string;
    permissionEnvelopeDigest: string;
    executionEnvelopeId: string;
    audience: string;
    issuedAt: string;
    expiresAt: string;
    capabilityScope: string[];
    effectScope: string[];
    attempt: number;
    fencingEpoch: number;
  };
  usage: {
    requestedTier: string;
    resolvedOpenRouterModel: string;
    adapterVersion: string;
    providerRequestId: string;
    temperature: number;
    maxOutputTokens: number;
    inputTokens: number;
    outputTokens: number;
    reportedCost: CostView;
    latencyMs: number;
  } | null;
  capabilityCalls: GatewayDecisionView[];
};

export type FailureBannerInfo = {
  errorCode: string;
  title: string;
  explanation: string;
  failingNodeId: string;
  failingNodeName: string;
  attempt: number;
  fencingEpoch: number;
  retryPermitted: boolean;
  externalEffectOccurred: boolean;
  lastCommittedCheckpoint: string;
  suggestedOperatorAction: string;
};

export type RunEventView = {
  id: string;
  runId: string;
  sequence: number;
  occurredAt: string;
  code: string;
  nodeId: string | null;
  attempt: number;
  fencingEpoch: number;
  status: string;
  durationMs: number | null;
  summary: string;
  details: Record<string, unknown>;
  isKnownCode: boolean;
};

export type RunDetail = RunSummary & {
  idempotencyKey: string;
  inputPayload: Record<string, unknown>;
  plan: CompiledHarnessPlan;
  nodeAttempts: Record<string, NodeAttemptView>;
  failureInfo: FailureBannerInfo | null;
  events: RunEventView[];
};

export type GatewayDecisionView = {
  receiptId: string;
  occurredAt: string;
  runId: string;
  nodeId: string;
  attempt: number;
  fencingEpoch: number;
  capabilityId: string;
  effect: string;
  decision: "allowed" | "denied";
  reasonCode: string;
  adapterBindingId: string | null;
  latencyMs: number;
  resultStatus: string | null;
  envelopeDigest: string;
  requestDigest: string;
  resultDigest: string | null;
  idempotencyKey: string;
  traceId: string | null;
  spanId: string | null;
};

export type ModelTierProfileView = {
  tierId: string;
  version: string;
  purpose: string;
  profileDigest: string;
  resolvedOpenRouterModel: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  concurrencyLimit: number;
  enabled: boolean;
  credentialState: "Configured" | "Missing";
  lastSuccessAt: string | null;
};

export type ToolCapabilityView = {
  capabilityId: string;
  effectClass: "read_only" | "external_mutation" | "ledger_hold";
  adapterBindingId: string;
  adapterVersion: string;
  requestSchemaVersion: string;
  resultSchemaVersion: string;
  timeoutMs: number;
  retryPolicy: string;
  credentialState: "Configured" | "Missing" | "Not required";
  health: "Healthy" | "Degraded" | "Unreachable";
};

export type GatewayStatusView = {
  readiness: "Ready" | "Degraded" | "Unavailable";
  openRouterState: "Configured" | "Missing" | "Unreachable";
  runtimeMode: "OpenRouter" | "Recorded";
  lastConnectionTestAt: string | null;
  lastConnectionLatencyMs: number | null;
  lastConnectionMessage: string | null;
  envelopeVerifierStatus: string;
  calls24h: number;
  denials24h: number;
  generatedAt: string;
  telemetryFreshThrough: string;
};

export type ServiceReadinessItem = {
  id: string;
  name: string;
  status: "Ready" | "Degraded" | "Unavailable";
  detail: string;
  latencyMs: number;
};

export type OverviewIssueItem = {
  id: string;
  category:
    | "gateway_denial"
    | "invalid_output"
    | "budget_exhaustion"
    | "stale_fencing_attempt"
    | "worker_unavailable";
  code: string;
  title: string;
  runId: string;
  harnessName: string;
  nodeId: string;
  occurredAt: string;
  summary: string;
};

export type OverviewView = {
  window: string;
  admittedHarnessesCount: number;
  activeRunsCount: number;
  queuedCount: number;
  runningCount: number;
  retryingCount: number;
  needsAttentionCount: number;
  failedCount: number;
  deniedCount: number;
  staleLeaseCount: number;
  reportedCost24h: CostView;
  activeRuns: RunSummary[];
  recentIssues: OverviewIssueItem[];
  serviceStatus: ServiceReadinessItem[];
  modelTiers: ModelTierProfileView[];
  runtimeMode: "OpenRouter" | "Recorded";
  fixture: boolean;
  globalReadiness: "Ready" | "Degraded" | "Unavailable";
  generatedAt: string;
  telemetryFreshThrough: string;
};

export type SystemView = {
  globalReadiness: "Ready" | "Degraded" | "Unavailable";
  runtimeMode: "OpenRouter" | "Recorded";
  environment: "local";
  fixture: boolean;
  componentReadiness: ServiceReadinessItem[];
  runtimeIsolation: {
    scope: "harness_invocation";
    defaultProvider: "local_http" | "azure_foundry";
    selectionAuthority: string;
    mixedTargetsAllowed: false;
    providers: {
      id: "local_http" | "azure_foundry";
      name: string;
      boundary: string;
      authentication: string;
      configured: boolean;
    }[];
  };
  buildMetadata: {
    uiVersion: string;
    apiVersion: string;
    runtimeVersion: string;
    compilerVersion: string;
    adapterBundleVersion: string;
    commitSha: string;
    builtAt: string;
  };
  queueWorkState: {
    ready: number;
    leased: number;
    retrying: number;
    stale: number;
    activeWorkers: number;
    fencingAuthority: string;
  };
  databaseMigrationVersion: string;
  supportedPrimitives: {
    primitive: NodePrimitive;
    profileVersion: string;
    deterministicReplay: boolean;
    description: string;
  }[];
  knownPocLimitations: {
    id: string;
    area: string;
    explanation: string;
  }[];
  generatedAt: string;
  telemetryFreshThrough: string;
};

export type ExplorerGraphNode = {
  id: string;
  label: string;
  subtitle: string;
  category: string;
  status?: string;
  data: Record<string, unknown>;
};

export type ExplorerGraphEdge = {
  id: string;
  from: string;
  to: string;
  label: string;
};

export type CaseSummaryView = {
  tenantId: string;
  caseId: string;
  caseType: string;
  jurisdiction: string;
  status: string;
  caseSequence: number;
  externalRef: string;
  harnessPlanDigest: string;
  classification: string;
  createdAt: string;
  updatedAt: string;
};

export type CaseActivityView = {
  eventId: string;
  sequence: number;
  eventType: string;
  occurredAt: string;
  actorLabel: string;
  evidenceRefs: string[];
  eventDigest: string;
  previousEventDigest: string | null;
  payload: Record<string, unknown>;
  authority: Record<string, unknown>;
};

export type CaseDetailView = {
  generatedAt: string;
  viewSchema: string;
  etag: string;
  case: CaseSummaryView;
  counts: Record<string, number>;
  graph: {
    nodes: ExplorerGraphNode[];
    edges: ExplorerGraphEdge[];
    categories: string[];
  };
  activities: CaseActivityView[];
  executionRefs: Record<string, unknown>[];
  ledger: {
    eventCount: number;
    latestSequence: number;
    headDigest: string | null;
  };
};

export type AuthoringStatus = "DRAFT" | "COMPILED" | "EVALUATED" | "APPROVED" | "PUBLISHED";

export type AuthoringDiagnostic = {
  code: string;
  severity: "error" | "warning" | "info";
  path: string;
  message: string;
};

export type AuthoringEvent = {
  eventId: string;
  revision: number;
  eventType: string;
  actor: string;
  details: Record<string, unknown>;
  occurredAt: string;
};

export type EvaluationReportView = {
  passed: boolean;
  evaluatedAt: string;
  planDigest: string;
  checks: { id: string; label: string; passed: boolean; detail: string }[];
};

export type AuthoringDraftView = {
  draftId: string;
  name: string;
  domain: string;
  version: string;
  status: AuthoringStatus;
  revision: number;
  packageSource: string;
  workflowSource: string;
  parsedPackage: Record<string, unknown>;
  parsedWorkflow: Record<string, unknown>;
  compiledPlan: CompiledHarnessPlan | null;
  diagnostics: AuthoringDiagnostic[];
  evaluationReport: EvaluationReportView | null;
  approvedBy: string | null;
  publishedPlanDigest: string | null;
  createdAt: string;
  updatedAt: string;
  events?: AuthoringEvent[];
};

export type CapabilityRegistrationView = {
  id: string;
  kind: "model" | "tool" | "deterministic";
  effect: "none" | "read" | "reversible" | "paid" | "external" | "destructive";
  adapterBindingId: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  timeoutMs: number;
  maxAttempts: number;
  idempotent: boolean;
  description: string;
  owner: string;
  dataClasses: string[];
  status: "draft" | "active" | "deprecated";
};

export type CapabilityRegistryItemView = {
  capability: CapabilityRegistrationView;
  digest: string;
  createdAt: string;
  updatedAt: string;
};

export type AuthoringSourceView = { type: "manual" | "github"; url?: string; path?: string; revision?: string };
export type SkillRegistrationView = {
  id: string; name: string; description: string; instructions: string; allowedCapabilityIds: string[];
  source: AuthoringSourceView; version: string; status: "draft" | "active" | "deprecated";
};
export type SkillRegistryItemView = { skill: SkillRegistrationView; digest: string; createdAt: string; updatedAt: string };
export type AgentRegistrationView = {
  id: string; name: string; description: string; role: string; prompt: string; modelProfileId: string;
  runtimeTarget: "local_http" | "azure_foundry";
  skillIds: string[]; caseWrites: Array<{ commandType: string; when?: string; payload: Record<string, unknown>; payloadSchema: Record<string, unknown> }>;
  primaryCapabilityId?: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  source: AuthoringSourceView; version: string; status: "draft" | "active" | "deprecated";
};
export type AgentRegistryItemView = { agent: AgentRegistrationView; digest: string; createdAt: string; updatedAt: string };
