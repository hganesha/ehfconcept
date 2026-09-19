import { describe, expect, it } from "vitest";
import {
  actionsForRoles,
  AuthorizationError,
  assertPlatformInvariants,
  connectionStringHasPassword,
  createAuthorizer,
  createAzureAccessTokenProvider,
  createPrincipalResolverFromEnv,
  createPostgresAccessTokenProvider,
  evaluate,
  LocalHeaderPrincipalResolver,
  PlatformConfigError,
  type Principal,
} from "./index.js";

const author: Principal = {
  subjectId: "author@example.test", tenantId: "tenant_demo", actorType: "human",
  roles: ["Harness.Author"], source: "local",
};
const approver: Principal = { ...author, subjectId: "approver@example.test", roles: ["Harness.Approver"] };

describe("authorization", () => {
  it("denies an unauthenticated caller with a 401-shaped reason", () => {
    const decision = evaluate(null, "plan.read", { kind: "plan" });
    expect(decision.outcome).toBe("denied");
    expect(new AuthorizationError(decision).httpStatus).toBe(401);
  });

  it("keeps authoring and approval as distinct grants", () => {
    // Separation of duties only means something if Harness.Author is not a superset of
    // Harness.Approver; the self-approval check alone would be cosmetic.
    expect(actionsForRoles(["Harness.Author"]).has("draft.approve")).toBe(false);
    expect(actionsForRoles(["Harness.Approver"]).has("draft.write")).toBe(false);
    expect(evaluate(author, "draft.approve", { kind: "draft" }).reasonCode).toBe("authorization.role_missing");
    expect(evaluate(approver, "draft.approve", { kind: "draft" }).outcome).toBe("allowed");
  });

  it("refuses to act outside the principal's assigned tenant", () => {
    const analyst: Principal = { ...author, roles: ["Case.Analyst"] };
    expect(evaluate(analyst, "case.write", { kind: "case", tenantId: "tenant_demo" }).outcome).toBe("allowed");
    expect(evaluate(analyst, "case.write", { kind: "case", tenantId: "tenant_other" }).reasonCode)
      .toBe("authorization.tenant_mismatch");
  });

  it("does not let a workload role stand in for a human one", () => {
    const workload: Principal = { ...author, actorType: "workload", roles: ["Control.Api.Access"] };
    expect(evaluate(workload, "draft.publish", { kind: "draft" }).outcome).toBe("denied");
  });

  it("records a bounded decision without leaking the request", () => {
    const decisions: unknown[] = [];
    const authorizer = createAuthorizer((decision) => decisions.push(decision));
    authorizer.require(approver, "draft.approve", { kind: "draft", id: "draft_1" });
    expect(decisions).toEqual([{
      outcome: "allowed", reasonCode: "authorization.role_granted", action: "draft.approve",
      subjectId: "approver@example.test", actorType: "human", tenantId: "tenant_demo",
      resourceKind: "draft", resourceId: "draft_1",
    }]);
  });
});

describe("local header resolver", () => {
  it("rejects a request that asserts no actor instead of defaulting one", async () => {
    // The previous control API read String(headers["x-actor-id"] ?? "local-author"),
    // so an anonymous request became an authenticated author.
    const resolver = new LocalHeaderPrincipalResolver({ tenantId: "tenant_demo", roles: ["Harness.Reader"] }, {});
    await expect(resolver.resolve({ headers: {} })).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("reads actor, roles, and tenant from headers in local mode", async () => {
    const resolver = new LocalHeaderPrincipalResolver({ tenantId: "tenant_demo", roles: ["Harness.Reader"] }, {});
    const principal = await resolver.resolve({
      headers: { "x-actor-id": "analyst@example.test", "x-actor-roles": "Case.Analyst, Case.Reviewer" },
    });
    expect(principal).toEqual({
      subjectId: "analyst@example.test", tenantId: "tenant_demo", actorType: "human",
      roles: ["Case.Analyst", "Case.Reviewer"], source: "local",
    });
  });

  it("cannot be constructed or selected in Azure mode", () => {
    expect(() => new LocalHeaderPrincipalResolver({ tenantId: "t", roles: [] }, { PLATFORM_MODE: "azure" }))
      .toThrow("identity.local_resolver_forbidden_in_azure_mode");
    expect(() => createPrincipalResolverFromEnv({ PLATFORM_MODE: "azure", IDENTITY_PROVIDER: "local_headers" }))
      .toThrow("identity.local_headers_forbidden_in_azure_mode");
  });
});

describe("platform invariants", () => {
  it("passes everything in local mode", () => {
    expect(() => assertPlatformInvariants(
      { forbidden: ["EXECUTION_ENVELOPE_SECRET"], databaseUrls: ["DATABASE_URL"] },
      { EXECUTION_ENVELOPE_SECRET: "shared", DATABASE_URL: "postgresql://postgres:postgres@postgres:5432/ehf" },
    )).not.toThrow();
  });

  it("refuses to boot in Azure mode with a shared secret or a password connection string", () => {
    expect(() => assertPlatformInvariants(
      { forbidden: ["EXECUTION_ENVELOPE_SECRET"], databaseUrls: ["DATABASE_URL"], required: ["ENTRA_TENANT_ID"] },
      {
        PLATFORM_MODE: "azure",
        EXECUTION_ENVELOPE_SECRET: "shared",
        DATABASE_URL: "postgresql://app:hunter2@db.postgres.database.azure.com:5432/ehf",
      },
    )).toThrow(PlatformConfigError);
  });

  it("detects passwords in both URL and keyword connection strings", () => {
    expect(connectionStringHasPassword("postgresql://app:secret@host:5432/db")).toBe(true);
    expect(connectionStringHasPassword("host=db.postgres.database.azure.com;Password=secret")).toBe(true);
    expect(connectionStringHasPassword("postgresql://app@host:5432/db")).toBe(false);
  });
});

describe("managed-identity database authentication", () => {
  it("requests a fresh PostgreSQL access token for each connection", async () => {
    let calls = 0;
    const password = createPostgresAccessTokenProvider({
      getToken: async (scope: string | string[]) => {
        calls += 1;
        expect(scope).toBe("https://ossrdbms-aad.database.windows.net/.default");
        return { token: `token-${calls}`, expiresOnTimestamp: Date.now() + 60_000 };
      },
    });
    await expect(password()).resolves.toBe("token-1");
    await expect(password()).resolves.toBe("token-2");
  });

  it("requests internal API tokens for the configured audience", async () => {
    const token = createAzureAccessTokenProvider("api://ehf-internal/.default", {
      getToken: async (scope: string | string[]) => {
        expect(scope).toBe("api://ehf-internal/.default");
        return { token: "managed-token", expiresOnTimestamp: Date.now() + 60_000 };
      },
    });
    await expect(token()).resolves.toBe("managed-token");
  });
});
