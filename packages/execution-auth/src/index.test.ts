import { describe, expect, it } from "vitest";
import { mintExecutionEnvelope, verifyExecutionEnvelope } from "./index.js";

const secret = "a-local-test-secret-that-is-long-enough";

describe("execution envelope", () => {
  it("round trips scoped authority", async () => {
    const token = await mintExecutionEnvelope({
      secret,
      invocationId: "inv-1",
      runId: "run-1",
      nodeId: "screen",
      attempt: 1,
      planDigest: "a".repeat(64),
      permissionDigest: "b".repeat(64),
      capabilities: ["screening.sanctions.search"],
      effects: ["read"],
      fencingEpoch: 2,
    });
    const claims = await verifyExecutionEnvelope(token, secret);
    expect(claims).toMatchObject({
      jti: "inv-1",
      run_id: "run-1",
      node_id: "screen",
      capabilities: ["screening.sanctions.search"],
      fencing_epoch: 2,
    });
  });

  it("rejects a token under a different secret", async () => {
    const token = await mintExecutionEnvelope({
      secret,
      invocationId: "inv-2",
      runId: "run-1",
      nodeId: "screen",
      attempt: 1,
      planDigest: "a".repeat(64),
      permissionDigest: "b".repeat(64),
      capabilities: [],
      effects: [],
      fencingEpoch: 1,
    });
    await expect(verifyExecutionEnvelope(token, "another-secret-that-is-long-enough")).rejects.toThrow();
  });
});
