import { describe, expect, it } from "vitest";
import { aggregateValue, evaluateCondition, getPath, materializeTemplate, renderTemplate, transformValue } from "./index.js";

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
