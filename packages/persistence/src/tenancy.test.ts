import { describe, expect, it } from "vitest";
import { createRun, listEvents, listGatewayReceipts, type Database } from "./index.js";

const runRow = {
  run_id: "RUN-1", idempotency_key: "idem-1", plan_digest: "a".repeat(64), status: "queued",
  terminal_outcome: null, input: { value: 1 }, output: null, attempt: 0, fencing_epoch: 0,
  latest_checkpoint_id: null, current_node_id: null, error_code: null, trace_id: null,
  root_span_id: null, trace_flags: null, cost_usd: 0, cost_complete: true, model_calls: 0,
  capability_calls: 0, created_at: new Date("2026-01-01T00:00:00Z"), started_at: null,
  completed_at: null, updated_at: new Date("2026-01-01T00:00:00Z"),
};

describe("control-plane tenant integrity", () => {
  it("scopes run idempotency to tenant and binds it to the request digest", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db = { query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rowCount: 1, rows: [runRow] };
    } } as unknown as Database;

    await createRun(db, { tenantId: "tenant-a", idempotencyKey: "idem-1", planDigest: "a".repeat(64), runInput: { value: 1 } });
    expect(calls[0]?.text).toContain("on conflict (tenant_id, idempotency_key)");
    expect(calls[0]?.text).toContain("request_digest = excluded.request_digest");
    expect(calls[0]?.values[4]).toBe("tenant-a");
    expect(calls[0]?.values[5]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed when an idempotency key is reused for different content", async () => {
    const db = { query: async () => ({ rowCount: 0, rows: [] }) } as unknown as Database;
    await expect(createRun(db, {
      tenantId: "tenant-a", idempotencyKey: "idem-1", planDigest: "a".repeat(64), runInput: { value: 2 },
    })).rejects.toThrow("run.idempotency_conflict");
  });

  it("joins events to their tenant-owned run", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db = { query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    } } as unknown as Database;
    await listEvents(db, "RUN-1", "tenant-a", 7);
    expect(calls[0]?.text).toContain("run.tenant_id = $2");
    expect(calls[0]?.text).toContain("event.status");
    expect(calls[0]?.values).toEqual(["RUN-1", "tenant-a", 7]);
  });

  it("requires a tenant for receipt listings", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db = { query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    } } as unknown as Database;
    await listGatewayReceipts(db, "tenant-a", { runId: "RUN-1", decision: "denied" });
    expect(calls[0]?.text).toContain("where tenant_id = $1");
    expect(calls[0]?.values.slice(0, 3)).toEqual(["tenant-a", "RUN-1", "denied"]);
  });
});
