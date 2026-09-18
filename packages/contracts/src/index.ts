import { createHash } from "node:crypto";
import { z } from "zod";

export const effectClassSchema = z.enum([
  "none",
  "read",
  "reversible",
  "paid",
  "external",
  "destructive",
]);

export const capabilityKindSchema = z.enum(["model", "tool", "deterministic"]);

export const capabilityDefinitionSchema = z.object({
  id: z.string().min(1),
  kind: capabilityKindSchema,
  effect: effectClassSchema,
  adapterBindingId: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  outputSchema: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().positive(),
  maxAttempts: z.number().int().positive().max(10).default(1),
  idempotent: z.boolean(),
}).strict();

export const permissionEnvelopeSchema = z.object({
  nodeId: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  effects: z.array(effectClassSchema),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const graphNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "input",
    "output",
    "agent",
    "tool",
    "transform",
    "condition",
    "evaluate",
    "join",
    "aggregator",
  ]),
  name: z.string().min(1),
  summary: z.string().optional(),
  prompt: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  outputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  config: z.record(z.string(), z.unknown()).default({}),
}).strict();

export const graphEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(["data", "dependency", "control"]),
  condition: z.string().optional(),
  sourcePath: z.string().optional(),
  targetPath: z.string().optional(),
}).strict();

export const compiledSkillSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().min(1),
  allowedCapabilityIds: z.array(z.string().min(1)).default([]),
  version: z.string().min(1),
}).strict();

export const compiledAgentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  role: z.string().min(1),
  prompt: z.string().min(1),
  modelProfileId: z.string().min(1),
  runtimeTarget: z.enum(["local_http", "azure_foundry"]),
  skillIds: z.array(z.string().min(1)).default([]),
  primaryCapabilityId: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  version: z.string().min(1),
}).strict();

export const harnessPlanSchema = z.object({
  apiVersion: z.literal("harness.factory/plan-v1"),
  kind: z.literal("HarnessPlan"),
  planId: z.string().min(1),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
  compiler: z.object({
    name: z.literal("harnessc"),
    version: z.string().min(1),
    lgirCoreRevision: z.string().min(7),
  }).strict(),
  metadata: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    domain: z.string().min(1),
    objective: z.string().min(1),
  }).strict(),
  execution: z.object({
    engine: z.object({
      kind: z.literal("langgraph-js"),
      adapterVersion: z.literal("harness-langgraph-v1"),
      profile: z.literal("poc-v1"),
    }).strict(),
    maxTransitions: z.number().int().positive().max(10_000),
    maxConcurrency: z.number().int().positive().max(32),
    durability: z.literal("sync"),
  }).strict(),
  budgets: z.object({
    maxDurationMs: z.number().int().positive(),
    maxCostUsd: z.number().nonnegative(),
    maxModelCalls: z.number().int().nonnegative(),
    maxCapabilityCalls: z.number().int().nonnegative(),
  }).strict(),
  schemas: z.object({
    input: z.record(z.string(), z.unknown()),
    output: z.record(z.string(), z.unknown()),
  }).strict(),
  modelProfiles: z.array(z.object({
    id: z.string().min(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()),
  skills: z.array(compiledSkillSchema).optional(),
  agents: z.array(compiledAgentSchema).optional(),
  capabilities: z.array(capabilityDefinitionSchema),
  permissionEnvelopes: z.array(permissionEnvelopeSchema),
  graph: z.object({
    apiVersion: z.literal("ladder.dev/v1alpha1"),
    name: z.string().min(1),
    nodes: z.array(graphNodeSchema),
    edges: z.array(graphEdgeSchema),
    nodeOrder: z.array(z.string()),
  }).strict(),
  dependencyManifest: z.array(z.object({
    path: z.string().min(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()),
}).strict();

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "retrying",
  "completed",
  "manual_review",
  "denied",
  "failed",
]);

export const runRequestSchema = z.object({
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  input: z.unknown(),
}).strict();

export const runRecordSchema = z.object({
  runId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  status: runStatusSchema,
  terminalOutcome: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown().nullable(),
  attempt: z.number().int().nonnegative(),
  fencingEpoch: z.number().int().nonnegative(),
  latestCheckpointId: z.string().nullable(),
  currentNodeId: z.string().nullable(),
  errorCode: z.string().nullable(),
  traceId: z.string().regex(/^[a-f0-9]{32}$/).nullable(),
  rootSpanId: z.string().regex(/^[a-f0-9]{16}$/).nullable(),
  traceFlags: z.number().int().min(0).max(255).nullable(),
  costUsd: z.number().nonnegative(),
  costComplete: z.boolean(),
  modelCalls: z.number().int().nonnegative(),
  capabilityCalls: z.number().int().nonnegative(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
}).strict();

export const runtimeEventSchema = z.object({
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  code: z.string().regex(/^[a-z0-9_.-]+$/),
  nodeId: z.string().nullable(),
  status: z.enum(["observed", "passed", "failed", "denied"]),
  values: z.record(z.string(), z.unknown()),
  occurredAt: z.string(),
}).strict();

export const runtimeProviderKindSchema = z.enum(["local_http", "azure_foundry"]);

export const runtimeInvocationSchema = z.object({
  contractVersion: z.literal("runtime.invocation.v1"),
  invocationId: z.string().min(1),
  runId: z.string().min(1),
  attempt: z.number().int().positive(),
  workerId: z.string().min(1),
  leaseId: z.string().min(1),
  fencingEpoch: z.number().int().positive(),
  deadlineAt: z.string().datetime(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  executionProfileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  plan: harnessPlanSchema,
  input: z.unknown(),
}).strict().superRefine((value, ctx) => {
  if (value.plan.planDigest !== value.planDigest) {
    ctx.addIssue({ code: "custom", path: ["plan", "planDigest"], message: "runtime.plan_digest_mismatch" });
  }
});

export const runtimeInvocationResultSchema = z.object({
  contractVersion: z.literal("runtime.result.v1"),
  invocationId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(["completed", "denied", "failed"]),
  output: z.unknown().nullable(),
  errorCode: z.string().min(1).nullable(),
  checkpointId: z.string().nullable(),
  providerMetadata: z.record(z.string(), z.string()).default({}),
}).strict();

const sha256DigestSchema = z.string().regex(/^(sha256:)?[a-f0-9]{64}$/);

export const kycCaseStatusSchema = z.enum([
  "INTAKE",
  "VALIDATING",
  "SCREENING",
  "INVESTIGATING",
  "READY_FOR_DECISION",
  "QA_REVIEW",
  "HUMAN_REVIEW",
  "NEEDS_INFORMATION",
  "SUSPENDED",
  "APPROVED",
  "DECLINED",
  "CLOSED",
]);

export const caseActorSchema = z.object({
  type: z.enum(["AGENT", "HUMAN", "SYSTEM", "INTEGRATION"]),
  principalId: z.string().min(1),
  executionId: z.string().min(1).optional(),
  roles: z.array(z.string().min(1)).default([]),
}).strict();

export const caseAuthoritySchema = z.object({
  planDigest: sha256DigestSchema,
  permissionEnvelopeDigest: sha256DigestSchema,
  policySnapshotDigest: sha256DigestSchema,
}).strict();

export const createKycCaseRequestSchema = z.object({
  tenantId: z.string().min(1),
  caseType: z.literal("kyc_onboarding").default("kyc_onboarding"),
  schemaVersion: z.literal("kyc.case.v1").default("kyc.case.v1"),
  jurisdiction: z.literal("US").default("US"),
  externalRef: z.string().min(1).optional(),
  policySnapshotDigest: sha256DigestSchema,
  harnessPlanDigest: sha256DigestSchema,
  classification: z.string().min(1).default("CONFIDENTIAL"),
  actor: caseActorSchema,
}).strict();

export const businessCommandTypeSchema = z.enum([
  "AddSubject",
  "LinkEvidence",
  "ProposeClaim",
  "AcceptClaimAsFact",
  "RecordScreeningFinding",
  "RecordAssumption",
  "RaiseContradiction",
  "ResolveContradiction",
  "ProposeWorkItem",
  "CompleteWorkItem",
  "LinkExecution",
  "SubmitDecisionRecommendation",
  "RecordGateResult",
  "RecordQAResult",
  "RecordReview",
  "RequestHumanReview",
  "TransitionCaseStatus",
  "FinalizeDisposition",
]);

export const businessCommandSchema = z.object({
  commandId: z.string().min(1),
  commandType: businessCommandTypeSchema,
  commandVersion: z.string().min(1),
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  actor: caseActorSchema,
  authority: caseAuthoritySchema,
  payload: z.record(z.string(), z.unknown()),
  preconditions: z.object({
    caseSequence: z.number().int().nonnegative(),
    subjectRevision: z.number().int().nonnegative().optional(),
  }).strict(),
  idempotencyKey: z.string().min(1).max(300),
  occurredAt: z.string().datetime().optional(),
}).strict();

export const evidenceSourceSchema = z.object({
  type: z.enum(["TOOL", "UPLOAD", "INTERNAL_SYSTEM", "HUMAN", "DERIVED"]),
  providerBindingDigest: sha256DigestSchema.optional(),
  dataset: z.string().min(1).optional(),
  datasetVersion: z.string().min(1).optional(),
  capability: z.string().min(1).optional(),
  retrievedAt: z.string().datetime(),
  sourceEffectiveAt: z.string().datetime().optional(),
}).strict();

export const registerEvidenceRequestSchema = z.object({
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  schemaVersion: z.literal("harness.evidence.v1").default("harness.evidence.v1"),
  type: z.string().min(1),
  mediaType: z.string().min(1),
  contentBase64: z.string().min(1),
  declaredDigest: sha256DigestSchema.optional(),
  source: evidenceSourceSchema,
  subjectRefs: z.array(z.string().min(1)).default([]),
  trust: z.object({
    tier: z.string().min(1),
    instructionTrust: z.enum(["TRUSTED", "UNTRUSTED_DATA", "UNTRUSTED_EXTERNAL"]),
  }).strict(),
  classification: z.string().min(1).default("CONFIDENTIAL"),
  retentionClass: z.string().min(1).default("KYC_REGULATED"),
  residency: z.string().min(1).default("US"),
  createdBy: caseActorSchema,
}).strict();

export const commandOutcomeSchema = z.enum(["ACCEPTED", "REJECTED", "CONFLICT", "IN_PROGRESS"]);

export const executionEnvelopeClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  jti: z.string().min(1),
  run_id: z.string().min(1),
  node_id: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  plan_digest: z.string().regex(/^[a-f0-9]{64}$/),
  permission_digest: z.string().regex(/^[a-f0-9]{64}$/),
  capabilities: z.array(z.string()),
  effects: z.array(effectClassSchema),
  fencing_epoch: z.number().int().nonnegative(),
  iat: z.number().int(),
  exp: z.number().int(),
}).strict();

export const capabilityRequestSchema = z.object({
  invocationId: z.string().min(1),
  capabilityId: z.string().min(1),
  effect: effectClassSchema,
  input: z.unknown(),
}).strict();

export const capabilityResultSchema = z.object({
  invocationId: z.string(),
  capabilityId: z.string(),
  status: z.enum(["succeeded", "failed", "denied"]),
  output: z.unknown().nullable(),
  errorCode: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  providerRequestId: z.string().nullable(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
  }).strict(),
  latencyMs: z.number().int().nonnegative(),
  receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const authoringStatusSchema = z.enum([
  "DRAFT",
  "COMPILED",
  "EVALUATED",
  "APPROVED",
  "PUBLISHED",
]);

export const authoringDraftInputSchema = z.object({
  packageSource: z.string().min(1),
  workflowSource: z.string().min(1),
}).strict();

export const capabilityRegistrationSchema = capabilityDefinitionSchema.extend({
  description: z.string().min(1),
  owner: z.string().min(1),
  dataClasses: z.array(z.string().min(1)).default([]),
  status: z.enum(["draft", "active", "deprecated"]).default("active"),
});

export const authoringSourceSchema = z.object({
  type: z.enum(["manual", "github"]),
  url: z.string().url().optional(),
  path: z.string().min(1).optional(),
  revision: z.string().min(1).optional(),
}).strict();

export const skillRegistrationSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().min(1),
  allowedCapabilityIds: z.array(z.string().min(1)).default([]),
  source: authoringSourceSchema.default({ type: "manual" }),
  version: z.string().min(1).default("0.1.0"),
  status: z.enum(["draft", "active", "deprecated"]).default("active"),
}).strict();

export const agentRegistrationSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  role: z.string().min(1),
  prompt: z.string().min(1),
  modelProfileId: z.string().min(1).default("model.standard.v1"),
  runtimeTarget: runtimeProviderKindSchema.default("local_http"),
  skillIds: z.array(z.string().min(1)).default([]),
  primaryCapabilityId: z.string().min(1).optional(),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: "object" }),
  outputSchema: z.record(z.string(), z.unknown()).default({ type: "object" }),
  source: authoringSourceSchema.default({ type: "manual" }),
  version: z.string().min(1).default("0.1.0"),
  status: z.enum(["draft", "active", "deprecated"]).default("active"),
}).strict();

export const evaluationReportSchema = z.object({
  passed: z.boolean(),
  evaluatedAt: z.string(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  checks: z.array(z.object({
    id: z.string(),
    label: z.string(),
    passed: z.boolean(),
    detail: z.string(),
  }).strict()),
}).strict();

export type EffectClass = z.infer<typeof effectClassSchema>;
export type CapabilityDefinition = z.infer<typeof capabilityDefinitionSchema>;
export type PermissionEnvelope = z.infer<typeof permissionEnvelopeSchema>;
export type HarnessPlan = z.infer<typeof harnessPlanSchema>;
export type RunRequest = z.infer<typeof runRequestSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export type RuntimeProviderKind = z.infer<typeof runtimeProviderKindSchema>;
export type RuntimeInvocation = z.infer<typeof runtimeInvocationSchema>;
export type RuntimeInvocationResult = z.infer<typeof runtimeInvocationResultSchema>;
export type KycCaseStatus = z.infer<typeof kycCaseStatusSchema>;
export type CaseActor = z.infer<typeof caseActorSchema>;
export type CaseAuthority = z.infer<typeof caseAuthoritySchema>;
export type CreateKycCaseRequest = z.infer<typeof createKycCaseRequestSchema>;
export type BusinessCommand = z.infer<typeof businessCommandSchema>;
export type BusinessCommandType = z.infer<typeof businessCommandTypeSchema>;
export type RegisterEvidenceRequest = z.infer<typeof registerEvidenceRequestSchema>;
export type CommandOutcome = z.infer<typeof commandOutcomeSchema>;
export type ExecutionEnvelopeClaims = z.infer<typeof executionEnvelopeClaimsSchema>;
export type CapabilityRequest = z.infer<typeof capabilityRequestSchema>;
export type CapabilityResult = z.infer<typeof capabilityResultSchema>;
export type AuthoringStatus = z.infer<typeof authoringStatusSchema>;
export type AuthoringDraftInput = z.infer<typeof authoringDraftInputSchema>;
export type CapabilityRegistration = z.infer<typeof capabilityRegistrationSchema>;
export type AuthoringSource = z.infer<typeof authoringSourceSchema>;
export type SkillRegistration = z.infer<typeof skillRegistrationSchema>;
export type AgentRegistration = z.infer<typeof agentRegistrationSchema>;
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function stableDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function verifyPlanDigest(plan: HarnessPlan): boolean {
  const { planDigest: _ignored, planId: _id, ...content } = plan;
  return stableDigest(content) === plan.planDigest;
}
