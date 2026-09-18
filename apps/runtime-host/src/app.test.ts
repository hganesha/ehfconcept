import { describe, expect, it } from "vitest";
import { buildRuntimeHost } from "./app.js";

describe("runtime host", () => {
  it("rejects unauthenticated invocation", async () => {
    const app = buildRuntimeHost({ authToken: "secret", execute: async () => ({}) });
    const response = await app.inject({ method: "POST", url: "/invocations", payload: {} });
    expect(response.statusCode).toBe(401);
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
});
