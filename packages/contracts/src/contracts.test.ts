import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { businessCommandSchema, canonicalJson, createKycCaseRequestSchema, graphNodeSchema, harnessPlanSchema, stableDigest, verifyPlanDigest } from "./index.js";

describe("canonical contracts", () => {
  it("sorts object keys while preserving array order", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 }, list: [2, 1] })).toBe(
      '{"a":{"x":3,"y":2},"list":[2,1],"z":1}',
    );
  });

  it("orders keys by code unit rather than locale collation", () => {
    // localeCompare would emit _leading,a_b,aB,apple,Apple,Zebra here, which is not the
    // order the Rust compiler's BTreeMap produces. The plan digest depends on this.
    expect(canonicalJson({ Zebra: 1, apple: 2, Apple: 3, a_b: 4, aB: 5, _leading: 6 })).toBe(
      '{"Apple":3,"Zebra":1,"_leading":6,"aB":5,"a_b":4,"apple":2}',
    );
  });

  it("re-verifies a plan digest produced by the Rust compiler", () => {
    // Regenerate with: make fixtures
    // The fixture's schema property names are deliberately mixed-case and
    // underscore-bearing so any divergence between the two canonicalizations fails here
    // rather than silently rejecting a legitimately compiled plan at admission.
    const plan = harnessPlanSchema.parse(JSON.parse(
      readFileSync(new URL("../test-fixtures/cross-compiler.plan.json", import.meta.url), "utf8"),
    ));
    expect(Object.keys(plan.schemas.input.properties as Record<string, unknown>)).toEqual([
      "VendorId", "Zebra", "apple", "taxId", "tax_id", "vendorName",
    ]);
    expect(verifyPlanDigest(plan)).toBe(true);
  });

  it("parses a compiled plan without coercing it", () => {
    // A plan must have exactly one canonical form. zod applies schema defaults during
    // parsing, so a compiler that omits a defaulted key produces a document whose digest
    // no longer matches the value every consumer actually works with -- and admission
    // then rejects a legitimately compiled plan. Parsing has to be a no-op.
    const document = JSON.parse(
      readFileSync(new URL("../test-fixtures/cross-compiler.plan.json", import.meta.url), "utf8"),
    );
    expect(harnessPlanSchema.parse(document)).toEqual(document);
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

  it("admits only implemented transform, aggregator, and join modes", () => {
    expect(graphNodeSchema.parse({ id: "dedupe", kind: "transform", name: "Dedupe", config: { operation: "deduplicate" } }).kind).toBe("transform");
    expect(graphNodeSchema.parse({ id: "vote", kind: "aggregator", name: "Vote", config: { operation: "vote" } }).kind).toBe("aggregator");
    expect(graphNodeSchema.parse({ id: "settled", kind: "join", name: "Settled", config: { mode: "allSettled" } }).kind).toBe("join");
    expect(graphNodeSchema.safeParse({ id: "first", kind: "join", name: "First", config: { mode: "first" } }).success).toBe(false);
  });
});
