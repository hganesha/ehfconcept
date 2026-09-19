import { describe, expect, it } from "vitest";
import { buildGateway } from "./app.js";
import type { Database } from "@ehf/persistence";

const SERVICE_TOKEN = "edge-service-token-for-tests-0001";
const RUNTIME_TOKEN = "runtime-service-token-for-tests-01";

function stubDatabase(): Database {
  return { query: async () => ({ rowCount: 0, rows: [] }), end: async () => {} } as unknown as Database;
}

function gateway() {
  return buildGateway({
    db: stubDatabase(),
    executionSecret: "test-execution-envelope-secret-value",
    env: { PLATFORM_MODE: "local" },
    serviceGrants: [
      { token: SERVICE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" },
      { token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Capability.Invoke"], tenantId: "tenant_demo" },
    ],
  });
}

describe("capability registration authorization", () => {
  it("rejects an unauthenticated registration", async () => {
    const app = gateway();
    // This route previously accepted anonymous writes, and a registered capability is
    // what a compiled plan is allowed to bind to.
    const response = await app.inject({
      method: "POST", url: "/v1/capabilities", payload: { id: "tool.x" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a forged actor header with no edge credential", async () => {
    const app = gateway();
    const response = await app.inject({
      method: "POST", url: "/v1/capabilities",
      headers: { "x-actor-id": "attacker@example.test", "x-actor-roles": "Harness.Author" },
      payload: { id: "tool.x" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("authorization.principal_unauthenticated");
    await app.close();
  });

  it("rejects a reader delegated through the edge", async () => {
    const app = gateway();
    const response = await app.inject({
      method: "POST", url: "/v1/capabilities",
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "x-actor-id": "reader@example.test",
        "x-actor-roles": "Harness.Reader",
      },
      payload: { id: "tool.x" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.role_missing");
    await app.close();
  });

  it("will not let a runtime workload token stand in for an author", async () => {
    // Authenticated but not permitted to speak for a person: 403, not 401.
    const app = gateway();
    const response = await app.inject({
      method: "POST", url: "/v1/capabilities",
      headers: {
        authorization: `Bearer ${RUNTIME_TOKEN}`,
        "x-actor-id": "reader@example.test",
        "x-actor-roles": "Harness.Author",
      },
      payload: { id: "tool.x" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.delegation_not_permitted");
    await app.close();
  });
});

describe("capability invocation authorization", () => {
  it("requires a workload credential before looking at the envelope", async () => {
    const app = gateway();
    const response = await app.inject({
      method: "POST", url: "/v1/invoke",
      headers: { "x-execution-envelope": "not-a-token" },
      payload: { invocationId: "INV-1", capabilityId: "tool.x", effect: "read", input: {} },
    });
    // The invoke path reports denials as bounded business outcomes rather than platform
    // failures, so an unauthenticated caller is a recorded 403 denial.
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.principal_unauthenticated");
    await app.close();
  });

  it("requires an execution envelope even with a valid workload credential", async () => {
    const app = gateway();
    // A workload token proves which service is calling. It says nothing about which run,
    // node or attempt may spend a capability, which is what the envelope carries.
    const response = await app.inject({
      method: "POST", url: "/v1/invoke",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      payload: { invocationId: "INV-1", capabilityId: "tool.x", effect: "read", input: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("gateway.execution_envelope_missing");
    await app.close();
  });
});
