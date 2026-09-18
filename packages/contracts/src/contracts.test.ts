import { describe, expect, it } from "vitest";
import { businessCommandSchema, canonicalJson, createKycCaseRequestSchema, stableDigest } from "./index.js";

describe("canonical contracts", () => {
  it("sorts object keys while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [2, 1] })).toBe(
      '{"a":{"x":3,"y":2},"list":[2,1],"z":1}',
    );
  });

  it("produces stable SHA-256 digests", () => {
    expect(stableDigest({ b: 2, a: 1 })).toBe(stableDigest({ a: 1, b: 2 }));
    expect(stableDigest({ list: [1, 2] })).not.toBe(stableDigest({ list: [2, 1] }));
  });

  it("validates the KYC case and command authority boundary", () => {
    const digest = "a".repeat(64);
    expect(createKycCaseRequestSchema.parse({
      tenantId: "tenant_demo",
      policySnapshotDigest: digest,
      harnessPlanDigest: digest,
      actor: { type: "HUMAN", principalId: "analyst@example.test", roles: ["KYC.Analyst"] },
    }).schemaVersion).toBe("kyc.case.v1");
    expect(businessCommandSchema.parse({
      commandId: "cmd_1",
      commandType: "AddSubject",
      commandVersion: "kyc.command.add_subject.v1",
      tenantId: "tenant_demo",
      caseId: "case_1",
      actor: { type: "HUMAN", principalId: "analyst@example.test", roles: ["KYC.Analyst"] },
      authority: { planDigest: digest, permissionEnvelopeDigest: digest, policySnapshotDigest: digest },
      payload: { subjectType: "individual" },
      preconditions: { caseSequence: 1 },
      idempotencyKey: "tenant_demo:case_1:add-subject:primary",
    }).commandType).toBe("AddSubject");
  });
});
