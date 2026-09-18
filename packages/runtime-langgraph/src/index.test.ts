import { describe, expect, it } from "vitest";
import type { HarnessPlan } from "@ehf/contracts";
import { allSettledInput, type HarnessState } from "./index.js";

describe("LangGraph lowering helpers", () => {
  it("builds keyed fulfilled and rejected envelopes for allSettled joins", () => {
    const plan = {
      graph: {
        nodes: [{ id: "settled", kind: "join", config: { mode: "allSettled" } }],
        edges: [
          { id: "a", from: "left", to: "settled", kind: "data" },
          { id: "b", from: "right", to: "settled", kind: "data", targetPath: "/research" },
        ],
      },
    } as unknown as HarnessPlan;
    const state = {
      input: {}, output: undefined, values: { left: { score: 1 } },
      settlements: { right: { status: "rejected", reason: { code: "vendor.timeout", message: "vendor.timeout" } } },
    } satisfies HarnessState;
    expect(allSettledInput(plan, "settled", state)).toEqual({
      left: { status: "fulfilled", value: { score: 1 } },
      research: { status: "rejected", reason: { code: "vendor.timeout", message: "vendor.timeout" } },
    });
  });
});
