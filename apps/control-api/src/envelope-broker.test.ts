import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPlanSchema, verifyPlanDigest, type HarnessPlan } from "@ehf/contracts";
import { mintRuntimeGrant, verifyExecutionEnvelope } from "@ehf/execution-auth";
import type { Database } from "@ehf/persistence";
import { declaredCaseWrites, EnvelopeBrokerError, issueExecutionEnvelope } from "./envelope-broker.js";

const ENVELOPE_SECRET = "broker-envelope-secret-for-tests-01";
const GRANT_SECRET = "broker-grant-secret-for-tests-000001";

/** Checked-in plan emitted by harnessc, so the test needs no build output. */
function fixturePlan(): HarnessPlan {
  return harnessPlanSchema.parse(JSON.parse(readFileSync(
    new URL("../../../packages/contracts/test-fixtures/cross-compiler.plan.json", import.meta.url),
    "utf8",
  )));
}

/** Minimal stand-in for the run/plan reads the broker performs. */
function database(plan: HarnessPlan, overrides: { status?: string; epoch?: number } = {}): Database {
  return {
    query: async (text: string) => {
      if (text.includes("from harness_control.plans")) return { rows: [{ plan }], rowCount: 1 };
      if (text.includes("select fencing_epoch")) {
        return overrides.status && overrides.status !== "running"
          ? { rows: [], rowCount: 0 }
          : { rows: [{ fencing_epoch: overrides.epoch ?? 4 }], rowCount: 1 };
      }
      return {
        rowCount: 1,
        rows: [{
          run_id: "RUN-1", idempotency_key: "k", plan_digest: plan.planDigest,
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

function grant(plan: HarnessPlan, overrides: Partial<{ runId: string; attempt: number; epoch: number }> = {}) {
  return mintRuntimeGrant({
    secret: GRANT_SECRET, grantId: "INV-1",
    runId: overrides.runId ?? "RUN-1", attempt: overrides.attempt ?? 2,
    workerId: "worker-1", planDigest: plan.planDigest,
    fencingEpoch: overrides.epoch ?? 4, ttlSeconds: 120,
  });
}

const request = { runId: "RUN-1", nodeId: "lookup", attempt: 2, invocationId: "INV-1" };

describe("execution envelope broker", () => {
  it("issues an envelope whose authority comes from the admitted plan", async () => {
    const plan = fixturePlan();
    expect(verifyPlanDigest(plan)).toBe(true);
    const result = await issueExecutionEnvelope(
      { db: database(plan), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET },
      await grant(plan),
      request,
    );
    const claims = await verifyExecutionEnvelope(result.envelope, ENVELOPE_SECRET);
    const permission = plan.permissionEnvelopes.find((item) => item.nodeId === "lookup");
    expect(claims.permission_digest).toBe(permission?.digest);
    expect(claims.capabilities).toEqual(permission?.capabilities);
    expect(claims.fencing_epoch).toBe(4);
    // Case-write authority is the plan's declaration, not anything the caller asserted.
    expect(claims.case_writes).toEqual(["LinkEvidence", "ProposeClaim"]);
    expect(declaredCaseWrites(plan, "lookup")).toEqual(["LinkEvidence", "ProposeClaim"]);
  });

  it("refuses a grant signed with the wrong secret", async () => {
    const plan = fixturePlan();
    const forged = await mintRuntimeGrant({
      secret: "an-attackers-grant-secret-value-01", grantId: "INV-1", runId: "RUN-1",
      attempt: 2, workerId: "worker-1", planDigest: plan.planDigest, fencingEpoch: 4, ttlSeconds: 120,
    });
    await expect(issueExecutionEnvelope(
      { db: database(plan), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET }, forged, request,
    )).rejects.toThrow("broker.grant_invalid");
  });

  it("refuses to sign for a node the plan does not permit", async () => {
    const plan = fixturePlan();
    await expect(issueExecutionEnvelope(
      { db: database(plan), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET },
      await grant(plan),
      { ...request, nodeId: "intake" },
    )).rejects.toThrow("broker.node_not_permitted");
  });

  it("refuses a grant whose fence has moved on", async () => {
    // A runtime that lost its lease keeps a syntactically valid grant. The fence is read
    // from durable state at issue time precisely so that grant stops buying authority.
    const plan = fixturePlan();
    await expect(issueExecutionEnvelope(
      { db: database(plan, { epoch: 9 }), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET },
      await grant(plan, { epoch: 4 }),
      request,
    )).rejects.toThrow("broker.stale_fence");
  });

  it("refuses once the run is no longer running", async () => {
    const plan = fixturePlan();
    await expect(issueExecutionEnvelope(
      { db: database(plan, { status: "completed" }), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET },
      await grant(plan),
      request,
    )).rejects.toThrow("broker.run_not_running");
  });

  it("refuses a grant issued for a different run", async () => {
    const plan = fixturePlan();
    await expect(issueExecutionEnvelope(
      { db: database(plan), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET },
      await grant(plan, { runId: "RUN-OTHER" }),
      request,
    )).rejects.toBeInstanceOf(EnvelopeBrokerError);
  });
});
