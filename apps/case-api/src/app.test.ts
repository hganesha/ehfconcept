import { describe, expect, it } from "vitest";
import type { CaseStore } from "@ehf/case-store";
import { buildCaseApi } from "./app.js";

const EDGE_TOKEN = "edge-service-token-for-tests-0001";
const RUNTIME_TOKEN = "runtime-service-token-for-tests-01";

function stubStore(): CaseStore {
  return {
    db: { query: async () => ({ rowCount: 0, rows: [] }) },
    ownsDatabase: false,
    schemas: { core: "case_core", ledger: "case_ledger", evidence: "evidence" },
    artifactBackend: "postgres",
    evidenceRequireScan: false,
    evidenceMaxBytes: 1024,
  } as unknown as CaseStore;
}

function caseApi() {
  return buildCaseApi({
    store: stubStore(),
    env: { PLATFORM_MODE: "local" },
    serviceGrants: [
      { token: EDGE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" },
      { token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Case.Api.Access"], tenantId: "tenant_demo" },
    ],
  });
}

describe("case tenancy", () => {
  it("rejects an anonymous read that asserts a tenant header", async () => {
    const app = caseApi();
    // x-tenant-id used to be the only thing between a caller and a tenant's cases.
    const response = await app.inject({
      method: "GET", url: "/v1/cases", headers: { "x-tenant-id": "tenant_demo" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a delegated caller asking for a tenant it was not assigned", async () => {
    const app = caseApi();
    const response = await app.inject({
      method: "GET", url: "/v1/cases",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "x-actor-id": "analyst@example.test",
        "x-actor-roles": "Case.Analyst",
        "x-tenant-id": "tenant_other",
      },
    });
    // Authenticated, but the edge may narrow its assigned tenant, never widen it.
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.delegated_tenant_mismatch");
    await app.close();
  });

  it("rejects a command whose body names another tenant", async () => {
    const app = caseApi();
    const response = await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      payload: {
        commandId: "cmd_1", commandType: "AddSubject", commandVersion: "v1",
        tenantId: "tenant_other", caseId: "case_1",
        actor: { type: "AGENT", principalId: "node", roles: [] },
        authority: { planDigest: "a".repeat(64), permissionEnvelopeDigest: "a".repeat(64), policySnapshotDigest: "a".repeat(64) },
        payload: { subjectType: "individual" }, preconditions: { caseSequence: 0 },
        idempotencyKey: "k1",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.tenant_mismatch");
    await app.close();
  });

  it("denies a reader the write actions", async () => {
    const app = caseApi();
    const response = await app.inject({
      method: "POST", url: "/v1/evidence:register",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "x-actor-id": "reader@example.test",
        "x-actor-roles": "Harness.Reader",
      },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.role_missing");
    await app.close();
  });
});

describe("case write authority", () => {
  const ENVELOPE_SECRET = "case-envelope-secret-for-tests-0001";

  function api() {
    return buildCaseApi({
      store: stubStore(),
      env: { PLATFORM_MODE: "local" },
      executionSecret: ENVELOPE_SECRET,
      serviceGrants: [
        { token: EDGE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" },
        { token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Case.Api.Access"], tenantId: "tenant_demo" },
      ],
    });
  }

  const digest = "a".repeat(64);
  const command = (commandType: string) => ({
    commandId: "cmd_1", commandType, commandVersion: "v1",
    tenantId: "tenant_demo", caseId: "case_1",
    actor: { type: "AGENT", principalId: "node", executionId: "RUN-1", roles: [] },
    authority: { planDigest: digest, permissionEnvelopeDigest: digest, policySnapshotDigest: digest },
    payload: { subjectType: "individual" }, preconditions: { caseSequence: 0 },
    idempotencyKey: "k1",
  });

  async function envelope(caseWrites: string[]) {
    const { mintExecutionEnvelope } = await import("@ehf/execution-auth");
    return mintExecutionEnvelope({
      secret: ENVELOPE_SECRET, invocationId: "INV-1", runId: "RUN-1", nodeId: "node",
      attempt: 1, planDigest: digest, permissionDigest: digest,
      capabilities: [], effects: [], caseWrites: caseWrites as never, fencingEpoch: 1,
    });
  }

  it("rejects a workload case write with no execution envelope", async () => {
    const app = api();
    // A workload token says which service is calling. It does not say that this run's
    // node was granted authority to submit a canonical command.
    const response = await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      payload: command("AddSubject"),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("authorization.execution_envelope_required");
    await app.close();
  });

  it("rejects a command type the plan never declared for that node", async () => {
    const app = api();
    const response = await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: {
        authorization: `Bearer ${RUNTIME_TOKEN}`,
        "x-execution-envelope": await envelope(["LinkEvidence"]),
      },
      payload: command("FinalizeDisposition"),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.command_not_declared");
    await app.close();
  });

  it("rejects an envelope signed with another secret", async () => {
    const app = api();
    const { mintExecutionEnvelope } = await import("@ehf/execution-auth");
    const forged = await mintExecutionEnvelope({
      secret: "an-attackers-envelope-secret-0001", invocationId: "INV-1", runId: "RUN-1",
      nodeId: "node", attempt: 1, planDigest: digest, permissionDigest: digest,
      capabilities: [], effects: [], caseWrites: ["AddSubject"], fencingEpoch: 1,
    });
    const response = await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-execution-envelope": forged },
      payload: command("AddSubject"),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.execution_envelope_invalid");
    await app.close();
  });

  it("rejects a person recording a command as an agent", async () => {
    const app = api();
    const response = await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "x-actor-id": "analyst@example.test",
        "x-actor-roles": "Case.Analyst",
      },
      payload: command("AddSubject"),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.agent_actor_requires_execution");
    await app.close();
  });

  it("rejects a command claiming a plan the envelope did not authorize", async () => {
    const app = api();
    const response = await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: {
        authorization: `Bearer ${RUNTIME_TOKEN}`,
        "x-execution-envelope": await envelope(["AddSubject"]),
      },
      payload: { ...command("AddSubject"), authority: { planDigest: "b".repeat(64), permissionEnvelopeDigest: digest, policySnapshotDigest: digest } },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.command_plan_mismatch");
    await app.close();
  });
});
