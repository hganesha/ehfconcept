import {
  businessCommandSchema,
  capabilityResultSchema,
  registerEvidenceRequestSchema,
  stableDigest,
  type BusinessCommand,
  type HarnessPlan,
  type CapabilityResult,
} from "@ehf/contracts";
import {
  appendEvent,
  beginNodeAttempt,
  finishNodeAttempt,
  updateRunNode,
  type Database,
} from "@ehf/persistence";
import {
  SpanKind,
  injectTraceContext,
  traceReference,
  withSpan,
} from "@ehf/telemetry";

export type RuntimeContext = {
  db: Database;
  plan: HarnessPlan;
  runId: string;
  runAttempt: number;
  workerId: string;
  fencingEpoch: number;
  gatewayUrl: string;
  caseApiUrl?: string;
  /** Control-plane endpoint that exchanges the runtime grant for a node-scoped envelope. */
  envelopeBrokerUrl: string;
  /**
   * Authority for this invocation, issued by the dispatcher. The runtime holds no signing
   * key: it cannot mint an envelope, only ask for one and be refused.
   */
  executionGrant: string;
  /**
   * Credential proving which workload is calling the internal services. It answers a
   * different question than the execution envelope, which says what this run, node and
   * attempt may do; both are required at the gateway.
   */
  serviceToken: string;
};

type IssuedEnvelope = { envelope: string; expiresInSeconds: number; caseWrites: string[] };

/**
 * Ask the control plane for authority to act as one node of this run.
 *
 * Every call re-derives the grant against durable run state, so an envelope cannot
 * outlive the lease it was issued under.
 */
async function requestExecutionEnvelope(
  context: RuntimeContext,
  nodeId: string,
  invocationId: string,
): Promise<IssuedEnvelope> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${context.serviceToken}`,
    "x-runtime-grant": context.executionGrant,
    "content-type": "application/json",
  };
  injectTraceContext(headers);
  const response = await fetch(`${context.envelopeBrokerUrl}/v1/runtime/envelopes`, {
    method: "POST",
    headers,
    body: JSON.stringify({ runId: context.runId, nodeId, attempt: context.runAttempt, invocationId }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? "runtime.envelope_denied"));
  const envelope = typeof body.envelope === "string" ? body.envelope : "";
  if (!envelope) throw new Error("runtime.envelope_invalid");
  return {
    envelope,
    expiresInSeconds: Number(body.expiresInSeconds ?? 0),
    caseWrites: Array.isArray(body.caseWrites) ? body.caseWrites.map(String) : [],
  };
}

type CaseWriteScope = {
  case: Record<string, unknown>;
  nodeInput: unknown;
  output: unknown;
  values: Record<string, unknown>;
  run: { runId: string; attempt: number; planDigest: string; nodeId: string };
  evidence?: { evidenceId: string };
};

export function getPath(value: unknown, path?: string): unknown {
  if (!path || path === "/" || path === "$") return value;
  const parts = path.replace(/^\$\.?/, "").split(/[./]/).filter(Boolean);
  return parts.reduce<unknown>((current, key) => current && typeof current === "object"
    ? (current as Record<string, unknown>)[key]
    : undefined, value);
}

export function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, path: string) => {
    const value = getPath(values, path.trim());
    return typeof value === "string" ? value : JSON.stringify(value ?? null);
  });
}

export function materializeTemplate(value: unknown, values: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([^}]+)\s*\}\}$/);
    if (exact) return getPath(values, exact[1]!.trim());
    return renderTemplate(value, values);
  }
  if (Array.isArray(value)) return value.map((item) => materializeTemplate(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, materializeTemplate(item, values)]));
  }
  return value;
}

export function evaluateCondition(expression: string | undefined, state: Record<string, unknown>): boolean {
  if (!expression || expression === "always") return true;
  const match = expression.match(/^([\w./$-]+)\s*(==|!=)\s*(.+)$/);
  if (!match) return Boolean(getPath(state, expression));
  const [, path, operator, raw] = match;
  let expected: unknown = raw;
  try { expected = JSON.parse(raw!); } catch { expected = raw!.replace(/^['"]|['"]$/g, ""); }
  const actual = getPath(state, path);
  return operator === "==" ? actual === expected : actual !== expected;
}

export function transformValue(config: Record<string, unknown>, input: unknown): unknown {
  const operation = String(config.operation ?? "identity");
  if (operation === "identity") return input;
  if (operation === "select") return getPath(input, String(config.path ?? "/"));
  if (operation === "project") {
    const fields = Array.isArray(config.fields) ? config.fields.map(String) : [];
    return Object.fromEntries(fields.map((field) => [field, getPath(input, field)]));
  }
  if (operation === "merge") return Object.assign({}, ...(Array.isArray(input) ? input : [input]));
  if (operation === "deduplicate") {
    if (!Array.isArray(input)) throw new Error("runtime.transform_deduplicate_array_required");
    const path = typeof config.path === "string" ? config.path : undefined;
    const seen = new Set<string>();
    return input.filter((item) => {
      const key = stableDigest((path ? getPath(item, path) : item) ?? null);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (operation === "sort") {
    if (!Array.isArray(input)) throw new Error("runtime.transform_sort_array_required");
    const path = typeof config.path === "string" ? config.path : undefined;
    const direction = config.direction === "desc" ? -1 : 1;
    const comparable = (value: unknown): string | number => typeof value === "number" ? value : JSON.stringify(value ?? null);
    return input.toSorted((left, right) => {
      const a = comparable(path ? getPath(left, path) : left);
      const b = comparable(path ? getPath(right, path) : right);
      if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
      return (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0) * direction;
    });
  }
  if (operation === "slice") {
    if (!Array.isArray(input) && typeof input !== "string") throw new Error("runtime.transform_slice_sequence_required");
    const start = Number.isInteger(config.start) ? Number(config.start) : 0;
    const end = Number.isInteger(config.end) ? Number(config.end) : undefined;
    return input.slice(start, end);
  }
  throw new Error(`runtime.transform_unsupported:${operation}`);
}

function collectedValues(input: unknown): unknown[] {
  if (Array.isArray(input)) return [...input];
  if (input && typeof input === "object") return Object.values(input as Record<string, unknown>);
  return [input];
}

export function aggregateValue(config: Record<string, unknown>, input: unknown): unknown {
  const operation = String(config.operation ?? "collect");
  const values = collectedValues(input);
  if (operation === "collect") return values;
  if (operation === "merge") {
    if (!values.every((value) => value && typeof value === "object" && !Array.isArray(value))) {
      throw new Error("runtime.aggregator_merge_objects_required");
    }
    return Object.assign({}, ...values as Record<string, unknown>[]);
  }
  if (operation === "concat") {
    if (!values.every(Array.isArray)) throw new Error("runtime.aggregator_concat_arrays_required");
    return (values as unknown[][]).flat();
  }
  if (operation === "vote") {
    if (!values.length) return null;
    const path = typeof config.path === "string" ? config.path : undefined;
    const counts = new Map<string, { value: unknown; count: number; first: number }>();
    values.forEach((item, index) => {
      const value = path ? getPath(item, path) : item;
      const key = stableDigest(value ?? null);
      const current = counts.get(key);
      counts.set(key, current ? { ...current, count: current.count + 1 } : { value, count: 1, first: index });
    });
    return [...counts.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0]?.value ?? null;
  }
  throw new Error(`runtime.aggregator_unsupported:${operation}`);
}

export async function invokeCapability(
  context: RuntimeContext,
  nodeId: string,
  input: unknown,
): Promise<CapabilityResult> {
  const binding = context.plan.graph.nodes.find((node) => node.id === nodeId);
  const capabilityId = String(binding?.config.capabilityId ?? "");
  const capability = context.plan.capabilities.find((item) => item.id === capabilityId);
  const permission = context.plan.permissionEnvelopes.find((item) => item.nodeId === nodeId);
  if (!capability || !permission) throw new Error("runtime.capability_binding_missing");
  // Stable across worker crashes so a resumed checkpoint replays the gateway receipt
  // instead of repeating a paid or externally-visible operation.
  const invocationId = `${context.runId}:${nodeId}:${stableDigest(input).slice(0, 24)}`;
  const issued = await requestExecutionEnvelope(context, nodeId, invocationId);
  return withSpan("capability.request", {
    kind: SpanKind.CLIENT,
    attributes: {
      "server.address": "capability-gateway",
      "http.request.method": "POST",
      "harness.execution.id": context.runId,
      "harness.node.id": nodeId,
      "harness.capability.id": capabilityId,
      "harness.capability.effect": capability.effect,
      "harness.plan.digest_prefix": context.plan.planDigest.slice(0, 12),
    },
  }, async (span) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${context.serviceToken}`,
      "x-execution-envelope": issued.envelope,
      "content-type": "application/json",
    };
    injectTraceContext(headers);
    const response = await fetch(`${context.gatewayUrl}/v1/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({ invocationId, capabilityId, effect: capability.effect, input }),
      signal: AbortSignal.timeout(capability.timeoutMs + 2_000),
    });
    span.setAttribute("http.response.status_code", response.status);
    const body = await response.json();
    if (!response.ok) throw new Error(String((body as { error?: string }).error ?? "runtime.gateway_failed"));
    const result = capabilityResultSchema.parse(body);
    span.setAttributes({
      "harness.outcome": result.status.toUpperCase(),
      "harness.provider": result.provider ?? "unknown",
      "harness.model.profile": capability.kind === "model" ? capability.adapterBindingId.replace(/^openrouter:/, "") : "none",
    });
    return result;
  });
}

async function caseRequest(
  context: RuntimeContext,
  operation: string,
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  if (!context.caseApiUrl) throw new Error("runtime.case_api_url_missing");
  return withSpan(operation, {
    kind: SpanKind.CLIENT,
    attributes: {
      "server.address": "case-api",
      "http.request.method": init.method ?? "GET",
      "url.path": path,
      "harness.execution.id": context.runId,
      "harness.plan.digest_prefix": context.plan.planDigest.slice(0, 12),
    },
  }, async (span) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${context.serviceToken}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> ?? {}),
    };
    injectTraceContext(headers);
    const response = await fetch(`${context.caseApiUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
    span.setAttribute("http.response.status_code", response.status);
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(String(body.error ?? "runtime.case_api_failed"));
    return body;
  });
}

async function currentCaseSequence(context: RuntimeContext, tenantId: string, caseId: string): Promise<number> {
  const view = await caseRequest(context, "case.read", `/v1/cases/${encodeURIComponent(caseId)}`, {
    method: "GET",
    headers: { "x-tenant-id": tenantId },
  });
  const caseRecord = view.case;
  if (!caseRecord || typeof caseRecord !== "object") throw new Error("runtime.case_view_invalid");
  const sequence = Number((caseRecord as Record<string, unknown>).caseSequence);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error("runtime.case_sequence_invalid");
  return sequence;
}

export async function executeCaseWrites(
  context: RuntimeContext,
  nodeId: string,
  rootInput: unknown,
  nodeInput: unknown,
  output: unknown,
  values: Record<string, unknown>,
): Promise<void> {
  const node = context.plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  const writes = Array.isArray(node?.config.caseWrites)
    ? node.config.caseWrites.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
    : [];
  if (!writes.length) return;
  const caseInput = rootInput && typeof rootInput === "object" && !Array.isArray(rootInput)
    ? rootInput as Record<string, unknown>
    : {};
  const tenantId = String(caseInput.tenantId ?? "");
  const caseId = String(caseInput.caseId ?? "");
  const policySnapshotDigest = String(caseInput.policySnapshotDigest ?? "");
  if (!tenantId || !caseId || !policySnapshotDigest) throw new Error("runtime.case_context_missing");
  const permission = context.plan.permissionEnvelopes.find((candidate) => candidate.nodeId === nodeId);
  if (!permission) throw new Error("runtime.case_write_permission_missing");
  const scope: CaseWriteScope = {
    case: caseInput,
    nodeInput,
    output,
    values,
    run: { runId: context.runId, attempt: context.runAttempt, planDigest: context.plan.planDigest, nodeId },
  };
  const actor = {
    type: "AGENT" as const,
    principalId: typeof node?.config.agentRef === "string" ? node.config.agentRef : nodeId,
    executionId: context.runId,
    roles: [],
  };
  const capture = node?.config.evidenceCapture;
  if (capture && typeof capture === "object" && !Array.isArray(capture)) {
    const captureConfig = capture as Record<string, unknown>;
    const retrievedAt = typeof (output as Record<string, unknown> | null)?.retrievedAt === "string"
      ? String((output as Record<string, unknown>).retrievedAt)
      : "2026-01-01T00:00:00.000Z";
    const evidenceRequest = registerEvidenceRequestSchema.parse({
      tenantId,
      caseId,
      type: String(captureConfig.type ?? `${nodeId}.output`),
      mediaType: "application/json",
      contentBase64: Buffer.from(JSON.stringify(output)).toString("base64"),
      source: {
        type: String(captureConfig.sourceType ?? "DERIVED"),
        capability: typeof node?.config.capabilityId === "string" ? node.config.capabilityId : undefined,
        retrievedAt,
      },
      subjectRefs: caseInput.subjectId ? [String(caseInput.subjectId)] : [],
      trust: {
        tier: String(captureConfig.trustTier ?? "POC_PROVIDER"),
        instructionTrust: String(captureConfig.instructionTrust ?? "UNTRUSTED_DATA"),
      },
      classification: String(caseInput.classification ?? "CONFIDENTIAL"),
      retentionClass: String(captureConfig.retentionClass ?? "KYC_REGULATED"),
      residency: String(caseInput.residency ?? caseInput.country ?? "US"),
      createdBy: actor,
    });
    const registered = await caseRequest(context, "evidence.register", "/v1/evidence:register", {
      method: "POST",
      headers: { "idempotency-key": `${context.runId}:${context.runAttempt}:${nodeId}:evidence` },
      body: JSON.stringify(evidenceRequest),
    });
    const evidence = registered.evidence;
    if (!evidence || typeof evidence !== "object" || typeof (evidence as Record<string, unknown>).evidenceId !== "string") {
      throw new Error("runtime.evidence_registration_invalid");
    }
    scope.evidence = { evidenceId: String((evidence as Record<string, unknown>).evidenceId) };
  }

  for (const [index, write] of writes.entries()) {
    const when = String(write.when ?? "success");
    if (when !== "success" && !evaluateCondition(when, scope as unknown as Record<string, unknown>)) continue;
    const commandType = String(write.commandType ?? "");
    const payload = materializeTemplate(write.payload ?? {}, scope as unknown as Record<string, unknown>);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("runtime.case_write_payload_invalid");
    const sequence = await currentCaseSequence(context, tenantId, caseId);
    const command: BusinessCommand = businessCommandSchema.parse({
      commandId: `cmd_${stableDigest(`${context.runId}:${nodeId}:${index}`).slice(0, 24)}`,
      commandType,
      commandVersion: "harness.case-write.v1",
      tenantId,
      caseId,
      actor,
      authority: {
        planDigest: context.plan.planDigest,
        permissionEnvelopeDigest: permission.digest,
        policySnapshotDigest,
      },
      payload,
      preconditions: { caseSequence: sequence },
      idempotencyKey: `${tenantId}:${caseId}:${context.runId}:${context.runAttempt}:${nodeId}:${index}`,
    });
    await caseRequest(context, "case.command", `/v1/cases/${encodeURIComponent(caseId)}/commands`, {
      method: "POST",
      body: JSON.stringify(command),
    });
    await appendEvent(context.db, {
      runId: context.runId,
      eventKey: `case-write:${nodeId}:${context.runAttempt}:${index}`,
      code: "case.write.completed",
      nodeId,
      status: "passed",
      values: { commandType },
    });
  }
}

export async function executeObservedNode<T>(
  context: RuntimeContext,
  nodeId: string,
  input: unknown,
  execute: () => Promise<T>,
): Promise<T> {
  const node = context.plan.graph.nodes.find((item) => item.id === nodeId);
  return withSpan("workflow.transition", {
    kind: SpanKind.INTERNAL,
    attributes: {
      "harness.execution.id": context.runId,
      "harness.node.id": nodeId,
      "harness.node.kind": node?.kind ?? "unknown",
      "harness.execution.attempt": context.runAttempt,
      "harness.fencing.epoch": context.fencingEpoch,
      "harness.plan.digest_prefix": context.plan.planDigest.slice(0, 12),
    },
  }, async (span) => {
    const spanRef = traceReference(span);
    await updateRunNode(context.db, {
      runId: context.runId, workerId: context.workerId,
      fencingEpoch: context.fencingEpoch, nodeId,
    });
    await beginNodeAttempt(context.db, {
      runId: context.runId, nodeId, attempt: context.runAttempt,
      fencingEpoch: context.fencingEpoch, value: input,
      traceId: spanRef.traceId, spanId: spanRef.spanId,
    });
    await appendEvent(context.db, {
      runId: context.runId, eventKey: `node:${nodeId}:${context.runAttempt}:started`,
      code: "node.started", nodeId, status: "observed", values: {},
    });
    try {
      const result = await execute();
      span.setAttribute("harness.outcome", "COMPLETED");
      await finishNodeAttempt(context.db, { runId: context.runId, nodeId, attempt: context.runAttempt, status: "completed", value: result });
      await appendEvent(context.db, {
        runId: context.runId, eventKey: `node:${nodeId}:${context.runAttempt}:completed`,
        code: "node.completed", nodeId, status: "passed", values: {},
      });
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.message : "runtime.node_failed";
      await finishNodeAttempt(context.db, { runId: context.runId, nodeId, attempt: context.runAttempt, status: "failed", errorCode: code });
      await appendEvent(context.db, {
        runId: context.runId, eventKey: `node:${nodeId}:${context.runAttempt}:failed`,
        code: "node.failed", nodeId, status: "failed", values: { errorCode: code },
      });
      throw error;
    }
  });
}
