import { z } from "zod";
import { verifyRuntimeGrant } from "@ehf/execution-auth";
import { currentFencingEpoch, getRun, type Database } from "@ehf/persistence";
import { createPostgresRuntimeStateStore } from "@ehf/persistence/runtime-state";
import {
  checkpointSchema,
  fencedRunSchema,
  nodeFinishedSchema,
  nodeStartedSchema,
  runtimeEventSchema,
  type FencedRun,
} from "@ehf/runtime-state";

export class RuntimeStateAuthorityError extends Error {
  constructor(readonly code: string, readonly httpStatus = 403) {
    super(code);
  }
}

/**
 * Confirm the caller is still the worker that owns this run before recording anything.
 *
 * A stale runtime -- one whose lease expired while it was working -- keeps a valid grant
 * and keeps trying to journal. Re-reading the fence here is what stops it writing over
 * the attempt that replaced it. The grant alone is not sufficient authority.
 */
export async function authorizeStateWrite(
  db: Database,
  grantToken: string | undefined,
  grantSecret: string,
  run: FencedRun,
): Promise<void> {
  if (!grantToken) throw new RuntimeStateAuthorityError("runtime_state.grant_missing", 401);
  let grant;
  try {
    grant = await verifyRuntimeGrant(grantToken, grantSecret);
  } catch {
    throw new RuntimeStateAuthorityError("runtime_state.grant_invalid", 401);
  }
  if (grant.run_id !== run.runId) throw new RuntimeStateAuthorityError("runtime_state.run_mismatch");
  if (grant.attempt !== run.attempt) throw new RuntimeStateAuthorityError("runtime_state.attempt_mismatch");
  if (grant.worker_id !== run.workerId) throw new RuntimeStateAuthorityError("runtime_state.worker_mismatch");
  if (grant.fencing_epoch !== run.fencingEpoch) throw new RuntimeStateAuthorityError("runtime_state.grant_fence_mismatch");

  const record = await getRun(db, run.runId);
  if (!record) throw new RuntimeStateAuthorityError("runtime_state.run_not_found", 404);
  if (record.status !== "running") throw new RuntimeStateAuthorityError("runtime_state.run_not_running");
  const epoch = await currentFencingEpoch(db, run.runId);
  if (epoch === null || epoch !== run.fencingEpoch) throw new RuntimeStateAuthorityError("runtime_state.stale_fence");
}

const bodySchemas = {
  "node-started": nodeStartedSchema,
  "node-finished": nodeFinishedSchema,
  events: runtimeEventSchema,
  checkpoint: checkpointSchema,
} as const;

export type RuntimeStateOperation = keyof typeof bodySchemas;

export const runtimeStateOperations = Object.keys(bodySchemas) as RuntimeStateOperation[];

/** Split the fenced-run envelope from the operation payload. */
export function parseStateRequest<K extends RuntimeStateOperation>(
  operation: K,
  body: unknown,
): { run: FencedRun; payload: z.infer<(typeof bodySchemas)[K]> } {
  const envelope = z.object({ run: fencedRunSchema }).passthrough().parse(body);
  const { run: _run, ...rest } = envelope as Record<string, unknown> & { run: FencedRun };
  return { run: envelope.run, payload: bodySchemas[operation].parse(rest) as z.infer<(typeof bodySchemas)[K]> };
}

export async function applyStateWrite(
  db: Database,
  operation: RuntimeStateOperation,
  run: FencedRun,
  payload: unknown,
): Promise<void> {
  const store = createPostgresRuntimeStateStore(db);
  if (operation === "node-started") return store.nodeStarted(run, payload as never);
  if (operation === "node-finished") return store.nodeFinished(run, payload as never);
  if (operation === "events") return store.appendEvent(run, payload as never);
  return store.markCheckpoint(run, payload as never);
}
