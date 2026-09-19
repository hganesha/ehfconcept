import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPlanSchema } from "@ehf/contracts";
import {
  aggregateValue, evaluateCondition, getPath, invokeCapability, materializeTemplate,
  renderTemplate, transformValue, type RuntimeContext,
} from "./index.js";

describe("runtime primitives", () => {
  const state = { input: { name: "Ada", risk: "high" }, values: [1, 2] };
  it("selects paths and renders prompts", () => {
    expect(getPath(state, "input.name")).toBe("Ada");
    expect(renderTemplate("Review {{ input.name }}", state)).toBe("Review Ada");
  });
  it("evaluates the constrained condition language", () => {
    expect(evaluateCondition("input.risk == high", state)).toBe(true);
    expect(evaluateCondition("input.risk != low", state)).toBe(true);
  });
  it("runs deterministic transforms", () => {
    expect(transformValue({ operation: "select", path: "input.name" }, state)).toBe("Ada");
    expect(transformValue({ operation: "deduplicate", path: "id" }, [{ id: 2 }, { id: 1 }, { id: 2 }])).toEqual([{ id: 2 }, { id: 1 }]);
    expect(transformValue({ operation: "sort", path: "score", direction: "desc" }, [{ score: 2 }, { score: 5 }, { score: 1 }])).toEqual([{ score: 5 }, { score: 2 }, { score: 1 }]);
    expect(transformValue({ operation: "slice", start: 1, end: 3 }, ["a", "b", "c", "d"])).toEqual(["b", "c"]);
  });
  it("runs deterministic aggregators", () => {
    expect(aggregateValue({ operation: "collect" }, { left: 1, right: 2 })).toEqual([1, 2]);
    expect(aggregateValue({ operation: "merge" }, [{ a: 1 }, { b: 2 }])).toEqual({ a: 1, b: 2 });
    expect(aggregateValue({ operation: "concat" }, { left: [1, 2], right: [3] })).toEqual([1, 2, 3]);
    expect(aggregateValue({ operation: "vote", path: "decision" }, [{ decision: "approve" }, { decision: "deny" }, { decision: "approve" }])).toBe("approve");
  });
  it("materializes native case-write payload values", () => {
    expect(materializeTemplate({
      subjectRef: "{{ case.subjectId }}",
      findingRefs: "{{ output.findingRefs }}",
      evidenceRefs: ["{{ evidence.evidenceId }}"],
      rationale: "Decision for {{ case.subjectId }}",
    }, {
      case: { subjectId: "subject_1" },
      output: { findingRefs: ["finding_1"] },
      evidence: { evidenceId: "ev_1" },
    })).toEqual({
      subjectRef: "subject_1",
      findingRefs: ["finding_1"],
      evidenceRefs: ["ev_1"],
      rationale: "Decision for subject_1",
    });
  });
});

describe("capability invocation authority", () => {
  const plan = harnessPlanSchema.parse(JSON.parse(readFileSync(
    new URL("../../contracts/test-fixtures/cross-compiler.plan.json", import.meta.url),
    "utf8",
  )));

  function context(): RuntimeContext {
    return {
      db: null as unknown as RuntimeContext["db"],
      plan,
      runId: "RUN-1",
      runAttempt: 2,
      workerId: "worker-1",
      fencingEpoch: 4,
      gatewayUrl: "http://gateway",
      envelopeBrokerUrl: "http://control",
      executionGrant: "grant-token",
      serviceToken: "runtime-service-token",
    };
  }

  it("exchanges the grant for an envelope and presents both credentials", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> });
      if (String(url).includes("/v1/runtime/envelopes")) {
        return new Response(JSON.stringify({ envelope: "envelope-token", expiresInSeconds: 60, caseWrites: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        invocationId: "x", capabilityId: "vendor.lookup", status: "succeeded", output: {},
        errorCode: null, provider: "simulator", model: "vendor.lookup", providerRequestId: null,
        usage: { inputTokens: null, outputTokens: null, costUsd: 0 }, latencyMs: 1, receiptDigest: "a".repeat(64),
      }), { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const result = await invokeCapability(context(), "lookup", { vendorName: "acme" });
      expect(result.status).toBe("succeeded");
    } finally {
      globalThis.fetch = original;
    }
    // The runtime holds no signing key: authority is fetched, and the gateway receives
    // the workload credential and the envelope in separate headers.
    expect(calls[0]?.url).toContain("/v1/runtime/envelopes");
    expect(calls[0]?.headers["x-runtime-grant"]).toBe("grant-token");
    expect(calls[1]?.url).toContain("/v1/invoke");
    expect(calls[1]?.headers.authorization).toBe("Bearer runtime-service-token");
    expect(calls[1]?.headers["x-execution-envelope"]).toBe("envelope-token");
  });

  it("does not call the gateway when the broker refuses", async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ error: "broker.stale_fence" }), { status: 403 });
    }) as typeof globalThis.fetch;
    try {
      await expect(invokeCapability(context(), "lookup", { vendorName: "acme" })).rejects.toThrow("broker.stale_fence");
    } finally {
      globalThis.fetch = original;
    }
    expect(urls.filter((url) => url.includes("/v1/invoke"))).toEqual([]);
  });
});
