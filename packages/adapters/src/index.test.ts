import { describe, expect, it } from "vitest";
import { invokeModel, invokeSimulator, modelCallCost } from "./index.js";

const recordedProfile = {
  id: "model.standard.v1",
  provider: "openrouter" as const,
  model: "openai/gpt-4.1-mini",
  maxOutputTokens: 1024,
  timeoutMs: 30_000,
  maxConcurrency: 1,
};

describe("adapters", () => {
  it("extracts nested provider cost", () => {
    expect(modelCallCost({ openrouter: { usage: { total_cost_usd: "0.012" } } })).toBe(0.012);
    expect(modelCallCost({ usage: {} })).toBeNull();
  });

  it("returns deterministic screening fixtures", async () => {
    await expect(invokeSimulator("screening.sanctions.search", { name: "Blocked Person" }))
      .resolves.toMatchObject({ output: { match: true } });
  });

  it("returns a versioned PolicyDB fixture", async () => {
    await expect(invokeSimulator("policy.kyc.lookup", {
      country: "US",
      customerType: "individual",
      riskTier: "high",
    })).resolves.toMatchObject({
      output: {
        policyId: "kyc-us-individual",
        policyVersion: "2026.09-poc",
        source: "mock-policydb-v1",
      },
    });
  });

  it("returns provenance and a bounded finding from the mock web search", async () => {
    await expect(invokeSimulator("investigation.web.search", {
      name: "Blocked Official",
      country: "US",
    })).resolves.toMatchObject({
      output: {
        provider: "mock-web-search-v1",
        findings: [{ classification: "REVIEW", evidenceRefs: ["ev_mock_public_001"] }],
      },
    });
  });

  it("returns the KYC decision contract when OpenRouter is not configured", async () => {
    await expect(invokeModel({
      profile: recordedProfile,
      input: {
        prompt: "Act as a KYC analyst and cite policy rule IDs and finding IDs.",
        input: { name: "Clear Person", evidence: {} },
      },
    })).resolves.toMatchObject({
      provider: "recorded",
      output: {
        recommendationId: "recommendation_fixture_001",
        outcome: "APPROVE",
        requiresHumanReview: false,
      },
    });
  });
});

describe("model credential handling", () => {
  const profile = {
    id: "model.standard.v1", provider: "openrouter" as const, model: "test/model",
    maxOutputTokens: 256, timeoutMs: 1000, maxConcurrency: 1,
  };

  it("falls back to the recorded adapter when that is permitted", async () => {
    const result = await invokeModel({ profile, input: { prompt: "kyc decision" } });
    expect(result.provider).toBe("recorded");
  });

  it("fails closed when a real provider is expected", async () => {
    // A silent fallback lets a deployment report model calls it never made.
    await expect(invokeModel({ profile, input: {}, allowRecordedFallback: false }))
      .rejects.toThrow("adapter.model_credential_missing");
  });
});
