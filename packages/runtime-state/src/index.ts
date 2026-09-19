import { z } from "zod";
import { injectTraceContext } from "@ehf/telemetry";

/**
 * The run, attempt and fence a runtime is acting under.
 *
 * Every state write names its fence so a runtime that lost its lease cannot journal
 * over the work of the worker that replaced it.
 */
export type FencedRun = {
  runId: string;
  attempt: number;
  workerId: string;
  fencingEpoch: number;
};

export const nodeStartedSchema = z.object({
  nodeId: z.string().min(1),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  traceId: z.string().regex(/^[a-f0-9]{32}$/).optional(),
  spanId: z.string().regex(/^[a-f0-9]{16}$/).optional(),
}).strict();

export const nodeFinishedSchema = z.object({
  nodeId: z.string().min(1),
  status: z.enum(["completed", "failed"]),
  outputDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  errorCode: z.string().min(1).optional(),
}).strict();

export const runtimeEventSchema = z.object({
  eventKey: z.string().min(1),
  code: z.string().regex(/^[a-z0-9_.-]+$/),
  nodeId: z.string().min(1).nullable(),
  status: z.enum(["observed", "passed", "failed", "denied"]),
  values: z.record(z.string(), z.unknown()),
}).strict();

export const checkpointSchema = z.object({
  checkpointId: z.string().min(1).nullable(),
  nodeId: z.string().min(1).nullable(),
}).strict();

export type NodeStarted = z.infer<typeof nodeStartedSchema>;
export type NodeFinished = z.infer<typeof nodeFinishedSchema>;
export type RuntimeStateEvent = z.infer<typeof runtimeEventSchema>;
export type CheckpointMark = z.infer<typeof checkpointSchema>;

/**
 * Durable run journal, as seen by the runtime.
 *
 * The runtime used to hold a PostgreSQL connection and write run state, node attempts
 * and the event stream directly. That is a much wider grant than the "checkpoints only"
 * the repository documented, and it is not a grant a hosted agent running outside the
 * platform's trust boundary can be given at all. The runtime now describes what
 * happened; the control plane decides whether to record it.
 *
 * Implementations only ever receive digests and bounded operational values -- never node
 * inputs, outputs, prompts or case payloads.
 */
export interface RuntimeStateStore {
  nodeStarted(run: FencedRun, input: NodeStarted): Promise<void>;
  nodeFinished(run: FencedRun, input: NodeFinished): Promise<void>;
  appendEvent(run: FencedRun, input: RuntimeStateEvent): Promise<void>;
  markCheckpoint(run: FencedRun, input: CheckpointMark): Promise<void>;
}

export type HttpRuntimeStateStoreOptions = {
  baseUrl: string;
  /** Workload credential identifying the runtime to the control plane. */
  serviceToken: string;
  /** Per-invocation grant; the control plane re-checks it against the live fence. */
  executionGrant: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export class RuntimeStateError extends Error {}

/** Journals through the control plane, so the runtime needs no database credential. */
export class HttpRuntimeStateStore implements RuntimeStateStore {
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(private readonly options: HttpRuntimeStateStoreOptions) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  nodeStarted(run: FencedRun, input: NodeStarted): Promise<void> {
    return this.post("node-started", run, input);
  }

  nodeFinished(run: FencedRun, input: NodeFinished): Promise<void> {
    return this.post("node-finished", run, input);
  }

  appendEvent(run: FencedRun, input: RuntimeStateEvent): Promise<void> {
    return this.post("events", run, input);
  }

  markCheckpoint(run: FencedRun, input: CheckpointMark): Promise<void> {
    return this.post("checkpoint", run, input);
  }

  private async post(path: string, run: FencedRun, body: unknown): Promise<void> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.serviceToken}`,
      "x-runtime-grant": this.options.executionGrant,
      "content-type": "application/json",
    };
    injectTraceContext(headers);
    const response = await this.fetchImpl(`${this.options.baseUrl}/v1/runtime/state/${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ run, ...(body as Record<string, unknown>) }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
    });
    if (response.ok) return;
    const detail = await response.json().catch(() => ({})) as { error?: string };
    throw new RuntimeStateError(detail.error ?? `runtime_state.http_${response.status}`);
  }
}

export const fencedRunSchema = z.object({
  runId: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  workerId: z.string().min(1),
  fencingEpoch: z.number().int().nonnegative(),
}).strict();
