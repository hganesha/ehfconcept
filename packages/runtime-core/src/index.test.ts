import { describe, expect, it } from "vitest";
import { evaluateCondition, getPath, materializeTemplate, renderTemplate, transformValue } from "./index.js";

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
