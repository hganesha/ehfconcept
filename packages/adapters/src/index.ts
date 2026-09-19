import { readFile } from "node:fs/promises";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject, generateText, jsonSchema } from "ai";
import { z } from "zod";

const modelProfileSchema = z.object({
  id: z.string(),
  provider: z.literal("openrouter"),
  model: z.string(),
  maxOutputTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  maxConcurrency: z.number().int().positive(),
}).strict();

const registrySchema = z.object({
  apiVersion: z.literal("harness.factory/model-profiles-v1"),
  profiles: z.array(modelProfileSchema),
}).strict();

export type ModelProfile = z.infer<typeof modelProfileSchema>;

export async function loadModelProfiles(path: string): Promise<ModelProfile[]> {
  const registry = registrySchema.parse(JSON.parse(await readFile(path, "utf8")));
  return registry.profiles;
}

export function modelCallCost(providerMetadata: unknown): number | null {
  if (!providerMetadata || typeof providerMetadata !== "object") return null;
  const pending: unknown[] = [providerMetadata];
  const keys = new Set(["cost", "costusd", "totalcost", "totalcostusd", "total_cost", "total_cost_usd"]);
  while (pending.length) {
    const current = pending.shift();
    if (!current || typeof current !== "object") continue;
    for (const [name, value] of Object.entries(current)) {
      const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
      if (keys.has(name.toLowerCase()) && typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0) return parsed;
      if (value && typeof value === "object") pending.push(value);
    }
  }
  return null;
}

export type ModelInvocation = {
  profile: ModelProfile;
  input: unknown;
  outputSchema?: Record<string, unknown>;
  apiKey?: string;
  siteUrl?: string;
  appName?: string;
  /**
   * Whether an absent credential may be answered by the deterministic recorded adapter.
   *
   * The recorded adapter is what makes the POC runnable offline, but silently standing in
   * for a real provider means a deployment can report model calls it never made. Callers
   * that expect a real provider pass false and get a failure instead.
   */
  allowRecordedFallback?: boolean;
};

export type AdapterResult = {
  output: unknown;
  provider: string;
  model: string;
  providerRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
};

function promptFor(input: unknown): string {
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const instruction = typeof record.prompt === "string" ? record.prompt : "Analyze the structured input.";
    return `${instruction}\n\nReturn only a JSON object.\n\nInput:\n${JSON.stringify(record.input ?? input)}`;
  }
  return `Analyze the input and return only a JSON object.\n\nInput:\n${String(input)}`;
}

function parseModelOutput(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    return { text: text.trim() };
  }
}

function recordedModel(profile: ModelProfile, input: unknown): AdapterResult {
  const envelope = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const payload = input && typeof input === "object" && "input" in input
    ? envelope.input
    : input;
  const serialized = JSON.stringify(payload).toLowerCase();
  const instruction = typeof envelope.prompt === "string" ? envelope.prompt.toLowerCase() : "";
  const needsReview = serialized.includes("match\":true")
    || serialized.includes("mismatch\":true")
    || serialized.includes("risk\":\"high")
    || serialized.includes("manual_review");
  const isKycDecision = instruction.includes("kyc")
    || instruction.includes("policy rule ids")
    || instruction.includes("finding ids");
  const output = isKycDecision
    ? {
        recommendationId: "recommendation_fixture_001",
        outcome: needsReview ? "REVIEW" : "APPROVE",
        rationale: needsReview
          ? "Recorded decision adapter found a material or uncertain signal that requires human review."
          : "Recorded decision adapter found the required policy and investigation evidence with no material risk signal.",
        policyRuleRefs: ["KYC-ID-001", "KYC-SCR-004"],
        findingRefs: ["finding_public_001"],
        evidenceRefs: ["ev_mock_public_001"],
        confidence: needsReview ? 0.66 : 0.91,
        requiresHumanReview: needsReview,
        fixture: true,
      }
    : {
        recommendation: needsReview ? "manual_review" : "clear",
        rationale: needsReview
          ? "Recorded adapter found a fixture signal requiring review."
          : "Recorded adapter found no fixture signal requiring review.",
        fixture: true,
      };
  return {
    output,
    provider: "recorded",
    model: profile.id,
    providerRequestId: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: 0,
  };
}

export async function invokeModel(input: ModelInvocation): Promise<AdapterResult> {
  if (!input.apiKey) {
    if (input.allowRecordedFallback === false) throw new Error("adapter.model_credential_missing");
    return recordedModel(input.profile, input.input);
  }
  const provider = createOpenRouter({
    apiKey: input.apiKey,
    ...(input.siteUrl ? { headers: { "HTTP-Referer": input.siteUrl } } : {}),
    ...(input.appName ? { extraBody: { app_name: input.appName } } : {}),
  });
  if (input.outputSchema) {
    const result = await generateObject({
      model: provider(input.profile.model),
      schema: jsonSchema(input.outputSchema),
      prompt: promptFor(input.input),
      maxOutputTokens: input.profile.maxOutputTokens,
      abortSignal: AbortSignal.timeout(input.profile.timeoutMs),
    });
    return {
      output: result.object,
      provider: "openrouter",
      model: input.profile.model,
      providerRequestId: result.response.id ?? null,
      inputTokens: result.usage.inputTokens ?? null,
      outputTokens: result.usage.outputTokens ?? null,
      costUsd: modelCallCost(result.providerMetadata),
    };
  }
  const result = await generateText({
    model: provider(input.profile.model),
    prompt: promptFor(input.input),
    maxOutputTokens: input.profile.maxOutputTokens,
    abortSignal: AbortSignal.timeout(input.profile.timeoutMs),
  });
  const step = result.steps.at(-1);
  return {
    output: parseModelOutput(result.text),
    provider: "openrouter",
    model: input.profile.model,
    providerRequestId: step?.response?.id ?? null,
    inputTokens: step?.usage.inputTokens ?? null,
    outputTokens: step?.usage.outputTokens ?? null,
    costUsd: modelCallCost(step?.providerMetadata),
  };
}

export async function invokeSimulator(capabilityId: string, input: unknown): Promise<AdapterResult> {
  const envelope = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const record = envelope.input && typeof envelope.input === "object"
    ? envelope.input as Record<string, unknown>
    : envelope;
  const subject = String(record.name ?? record.vendorName ?? record.subject ?? "").toLowerCase();
  let output: unknown;
  if (capabilityId === "screening.sanctions.search") {
    output = { match: /sanction|blocked/.test(subject), source: "fixture-sanctions-v1", subject };
  } else if (capabilityId === "screening.pep.search") {
    output = { match: /public|minister|official/.test(subject), source: "fixture-pep-v1", subject };
  } else if (capabilityId === "vendor.lookup") {
    output = { found: !/unknown/.test(subject), active: !/inactive/.test(subject), vendor: subject };
  } else if (capabilityId === "purchase_order.lookup") {
    const expectedAmount = typeof record.expectedAmount === "number" ? record.expectedAmount : record.amount;
    output = { found: Boolean(record.purchaseOrderId), expectedAmount: expectedAmount ?? null };
  } else if (capabilityId === "policy.kyc.lookup") {
    const country = String(record.country ?? "US").toUpperCase();
    const customerType = String(record.customerType ?? "individual");
    const riskTier = String(record.riskTier ?? "standard");
    output = {
      policyId: `kyc-${country.toLowerCase()}-${customerType}`,
      policyVersion: "2026.09-poc",
      policySnapshotDigest: String(record.policySnapshotDigest ?? `sha256:${"a".repeat(64)}`),
      jurisdiction: country,
      rules: [
        { ruleId: "KYC-ID-001", obligation: "verified_identity_evidence", severity: "required" },
        { ruleId: "KYC-SCR-004", obligation: "sanctions_and_pep_screening", severity: "required" },
        { ruleId: "KYC-EDD-009", obligation: riskTier === "high" ? "enhanced_due_diligence" : "risk_based_review", severity: riskTier === "high" ? "required" : "conditional" },
      ],
      requiredEvidence: ["identity_document", "sanctions_screen", "public_source_research"],
      reviewThresholds: { sanctionsPossibleMatch: "HUMAN_REVIEW", materialContradiction: "HUMAN_REVIEW", minimumConfidence: 0.8 },
      source: "mock-policydb-v1",
    };
  } else if (capabilityId === "investigation.web.search") {
    const risky = /sanction|blocked|minister|official|fraud/.test(subject);
    const retrievedAt = new Date().toISOString();
    output = {
      query: `${record.name ?? record.subject ?? "subject"} ${record.country ?? ""} sanctions PEP adverse media`.trim(),
      retrievedAt,
      sources: [
        { sourceId: "src_public_001", title: "Mock public screening index", url: "https://example.test/public-screening", publisher: "POC Research Provider", retrievedAt, instructionTrust: "UNTRUSTED_EXTERNAL" },
      ],
      findings: [{
        findingId: "finding_public_001",
        type: risky ? "POSSIBLE_SANCTIONS_MATCH" : "NO_MATERIAL_MATCH",
        classification: risky ? "REVIEW" : "CLEAR",
        reason: risky ? "Mock public-source index returned a potentially material name signal." : "Mock public-source research returned no material risk signal.",
        evidenceRefs: ["ev_mock_public_001"],
      }],
      contradictions: [],
      confidence: risky ? 0.66 : 0.91,
      provider: "mock-web-search-v1",
    };
  } else {
    throw new Error("adapter.capability_unsupported");
  }
  return {
    output,
    provider: "simulator",
    model: capabilityId,
    providerRequestId: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: 0,
  };
}
