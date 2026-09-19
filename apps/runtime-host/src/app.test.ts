import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPlanSchema } from "@ehf/contracts";
import { buildRuntimeHost } from "./app.js";

/** A schema-valid invocation built on the checked-in compiled plan. */
function invocationPayload() {
  const plan = harnessPlanSchema.parse(JSON.parse(readFileSync(
    new URL("../../../packages/contracts/test-fixtures/cross-compiler.plan.json", import.meta.url),
    "utf8",
  )));
  return {
    contractVersion: "runtime.invocation.v1",
    invocationId: "INV-1",
    runId: "RUN-1",
    attempt: 1,
    workerId: "worker-1",
    leaseId: "RUN-1:1:1",
    fencingEpoch: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    planDigest: plan.planDigest,
    executionProfileDigest: "a".repeat(64),
    executionGrant: "grant-token",
    plan,
    input: {},
  };
}

describe("runtime host", () => {
  it("rejects unauthenticated invocation", async () => {
    const app = buildRuntimeHost({ authToken: "secret", execute: async () => ({}) });
    const response = await app.inject({ method: "POST", url: "/invocations", payload: {} });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("supports an asynchronous workload-identity verifier", async () => {
    const app = buildRuntimeHost({
      authorize: async (authorization) => authorization === "Bearer entra-token",
      execute: async () => ({}),
    });
    expect((await app.inject({ method: "GET", url: "/invocations/INV-1" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET", url: "/invocations/INV-1", headers: { authorization: "Bearer entra-token" },
    })).statusCode).toBe(200);
    await app.close();
  });

  it("rejects malformed invocation before execution", async () => {
    let called = false;
    const app = buildRuntimeHost({ authToken: "secret", execute: async () => { called = true; } });
    const response = await app.inject({
      method: "POST",
      url: "/invocations",
      headers: { authorization: "Bearer secret" },
      payload: { contractVersion: "runtime.invocation.v1" },
    });
    expect(response.statusCode).toBe(400);
    expect(called).toBe(false);
    await app.close();
  });

  it("accepts and returns the Foundry message envelope", async () => {
    const invocation = invocationPayload();
    const app = buildRuntimeHost({
      authToken: "secret",
      execute: async () => ({
        contractVersion: "runtime.result.v1",
        invocationId: invocation.invocationId,
        runId: invocation.runId,
        status: "completed",
        output: { ok: true },
        errorCode: null,
        checkpointId: null,
        providerMetadata: { host: "azure_foundry" },
      }),
    });
    const response = await app.inject({
      method: "POST", url: "/invocations",
      headers: { authorization: "Bearer secret" },
      payload: { message: invocation },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toMatchObject({ status: "completed", output: { ok: true } });
    await app.close();
  });
});

describe("invocation lifecycle", () => {
  it("reports an unseen invocation as unknown", async () => {
    const app = buildRuntimeHost({ authToken: "secret", execute: async () => ({}) });
    const response = await app.inject({
      method: "GET", url: "/invocations/INV-unseen", headers: { authorization: "Bearer secret" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("unknown");
    await app.close();
  });

  it("refuses status and cancellation without the host credential", async () => {
    const app = buildRuntimeHost({ authToken: "secret", execute: async () => ({}) });
    expect((await app.inject({ method: "GET", url: "/invocations/INV-1" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/invocations/INV-1/cancel" })).statusCode).toBe(401);
    await app.close();
  });

  it("cancels an in-flight invocation through its signal", async () => {
    let observed: AbortSignal | undefined;
    let signalStarted = (): void => {};
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const app = buildRuntimeHost({
      authToken: "secret",
      execute: async (request, signal) => {
        observed = signal;
        signalStarted();
        await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
        return {
          contractVersion: "runtime.result.v1",
          invocationId: (request as { invocationId: string }).invocationId,
          runId: (request as { runId: string }).runId,
          status: "failed", output: null, errorCode: "runtime.cancelled",
          checkpointId: null, providerMetadata: {},
        };
      },
    });
    const invocation = app.inject({
      method: "POST", url: "/invocations",
      headers: { authorization: "Bearer secret" },
      payload: invocationPayload(),
    });
    await started;
    const cancelled = await app.inject({
      method: "POST", url: "/invocations/INV-1/cancel", headers: { authorization: "Bearer secret" },
    });
    expect(cancelled.statusCode).toBe(202);
    expect(observed?.aborted).toBe(true);
    expect((await invocation).json().errorCode).toBe("runtime.cancelled");
    await app.close();
  });
});
