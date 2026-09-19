import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  mintExecutionEnvelope,
  mintRuntimeGrant,
  verifyExecutionEnvelope,
  verifyRuntimeGrant,
} from "./index.js";

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

  it("uses asymmetric keys for cloud execution envelopes and runtime grants", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const envelope = await mintExecutionEnvelope({
      secret: privateKey,
      invocationId: "inv-rsa",
      runId: "run-rsa",
      nodeId: "screen",
      attempt: 1,
      planDigest: "a".repeat(64),
      permissionDigest: "b".repeat(64),
      capabilities: ["screening.sanctions.search"],
      effects: ["read"],
      fencingEpoch: 4,
    });
    await expect(verifyExecutionEnvelope(envelope, publicKey)).resolves.toMatchObject({
      jti: "inv-rsa",
      run_id: "run-rsa",
      fencing_epoch: 4,
    });

    const grant = await mintRuntimeGrant({
      secret: privateKey,
      grantId: "grant-rsa",
      runId: "run-rsa",
      attempt: 1,
      workerId: "worker-1",
      planDigest: "a".repeat(64),
      fencingEpoch: 4,
      ttlSeconds: 60,
    });
    await expect(verifyRuntimeGrant(grant, publicKey)).resolves.toMatchObject({
      jti: "grant-rsa",
      worker_id: "worker-1",
      fencing_epoch: 4,
    });
    await expect(verifyExecutionEnvelope(envelope, secret)).rejects.toThrow();
  });
});
