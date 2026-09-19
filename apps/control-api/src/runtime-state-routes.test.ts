import { describe, expect, it } from "vitest";
import { mintRuntimeGrant } from "@ehf/execution-auth";
import type { Database } from "@ehf/persistence";
import { authorizeStateWrite, parseStateRequest, RuntimeStateAuthorityError } from "./runtime-state-routes.js";

const GRANT_SECRET = "runtime-state-grant-secret-000001";
const run = { runId: "RUN-1", attempt: 2, workerId: "worker-1", fencingEpoch: 4 };

function database(overrides: { status?: string; epoch?: number } = {}): Database {
  return {
    query: async (text: string) => {
      if (text.includes("select fencing_epoch")) {
        return overrides.status && overrides.status !== "running"
          ? { rows: [], rowCount: 0 }
          : { rows: [{ fencing_epoch: overrides.epoch ?? 4 }], rowCount: 1 };
      }
      return {
        rowCount: 1,
        rows: [{
          run_id: "RUN-1", idempotency_key: "k", plan_digest: "a".repeat(64),
          status: overrides.status ?? "running", terminal_outcome: null, input: {}, output: null,
          attempt: 2, fencing_epoch: overrides.epoch ?? 4, latest_checkpoint_id: null,
          current_node_id: null, error_code: null, trace_id: null, root_span_id: null,
          trace_flags: null, cost_usd: 0, cost_complete: true, model_calls: 0, capability_calls: 0,
          created_at: new Date(), started_at: null, completed_at: null, updated_at: new Date(),
        }],
      };
    },
  } as unknown as Database;
}

const grant = (overrides: Partial<{ workerId: string; epoch: number; attempt: number }> = {}) => mintRuntimeGrant({
  secret: GRANT_SECRET, grantId: "INV-1", runId: "RUN-1",
  attempt: overrides.attempt ?? 2, workerId: overrides.workerId ?? "worker-1",
  planDigest: "a".repeat(64), fencingEpoch: overrides.epoch ?? 4, ttlSeconds: 120,
});

describe("runtime state authority", () => {
  it("accepts the worker that still owns the run", async () => {
    await expect(authorizeStateWrite(database(), await grant(), GRANT_SECRET, run)).resolves.toBeUndefined();
  });

  it("refuses a write with no grant", async () => {
    await expect(authorizeStateWrite(database(), undefined, GRANT_SECRET, run))
      .rejects.toThrow("runtime_state.grant_missing");
  });

  it("refuses a worker whose fence has been superseded", async () => {
    // The whole point of the boundary: a runtime that lost its lease keeps a valid grant
    // and must not be able to journal over the attempt that replaced it.
    await expect(authorizeStateWrite(database({ epoch: 9 }), await grant({ epoch: 4 }), GRANT_SECRET, { ...run, fencingEpoch: 4 }))
      .rejects.toThrow("runtime_state.stale_fence");
  });

  it("refuses a grant issued to a different worker", async () => {
    await expect(authorizeStateWrite(database(), await grant({ workerId: "other-worker" }), GRANT_SECRET, run))
      .rejects.toThrow("runtime_state.worker_mismatch");
  });

  it("refuses once the run is no longer running", async () => {
    await expect(authorizeStateWrite(database({ status: "failed" }), await grant(), GRANT_SECRET, run))
      .rejects.toBeInstanceOf(RuntimeStateAuthorityError);
  });

  it("separates the fenced run from the operation payload", () => {
    const parsed = parseStateRequest("node-started", { run, nodeId: "lookup", inputDigest: "b".repeat(64) });
    expect(parsed.run).toEqual(run);
    expect(parsed.payload).toEqual({ nodeId: "lookup", inputDigest: "b".repeat(64) });
  });
});
