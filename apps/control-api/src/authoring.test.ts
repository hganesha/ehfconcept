import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeAuthoringSources, compileAuthoringDraft, evaluateCompiledPlan } from "./authoring.js";

describe("authoring compiler", () => {
  it("compiles the checked-in KYC domain into the runtime plan contract", async () => {
    const packageSource = await readFile(new URL("../../../domains/kyc/package.yaml", import.meta.url), "utf8");
    const workflowSource = await readFile(new URL("../../../domains/kyc/workflow.yaml", import.meta.url), "utf8");
    const result = await compileAuthoringDraft({
      packageSource,
      workflowSource,
      registryCapabilities: [],
      modelProfilesPath: new URL("../../../config/model-profiles.json", import.meta.url).pathname,
    });
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(result.plan?.graph.nodes).toHaveLength(5);
    expect(result.plan?.agents?.map((agent) => agent.id)).toEqual([
      "agent.kyc.policy.v1",
      "agent.kyc.investigation.v1",
      "agent.kyc.decision.v1",
    ]);
    expect(result.plan?.skills).toHaveLength(3);
    expect(result.plan?.permissionEnvelopes).toHaveLength(3);
    expect(
      result.plan?.graph.nodes.find((node) => node.id === "decision-agent")?.config.caseWrites,
    ).toHaveLength(3);
    expect(result.plan && evaluateCompiledPlan(result.plan).passed).toBe(true);
  });

  it("rejects cyclic graphs and invalid case-write commands", () => {
    const packageSource = `
apiVersion: harness.factory/domain-package-v1
kind: DomainPackage
metadata: { name: bad, version: 0.1.0, domain: test, objective: Test }
workflow: workflow.yaml
budgets: { maxDurationMs: 1000, maxCostUsd: 0, maxModelCalls: 0, maxCapabilityCalls: 0 }
capabilities: []
bindings: {}
`;
    const workflowSource = `
apiVersion: ladder.dev/v1alpha1
kind: Workflow
metadata: { name: bad }
spec:
  inputs: { type: object }
  outputs: { type: object }
  nodes:
    - { id: input, kind: input, config: { caseWrites: [{ commandType: DirectSqlWrite, payload: {}, payloadSchema: { type: object } }] } }
    - { id: output, kind: output }
  edges:
    - { id: a, from: input, to: output, kind: data }
    - { id: b, from: output, to: input, kind: data }
`;
    const analysis = analyzeAuthoringSources(packageSource, workflowSource);
    expect(analysis.diagnostics.map((item) => item.code)).toContain("author.graph_cycle");
    expect(analysis.diagnostics.map((item) => item.code)).toContain("author.case_write_command_invalid");
  });

  it("returns diagnostics for structurally empty YAML instead of crashing the editor", () => {
    const analysis = analyzeAuthoringSources("null\n", "null\n");
    expect(analysis.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "author.package_contract_unsupported",
        "author.package_metadata_required",
        "author.workflow_contract_unsupported",
        "author.input_missing",
        "author.output_missing",
      ]),
    );
  });

  it("accepts the complete deterministic transform, aggregator, and join profile", () => {
    const packageSource = `
apiVersion: harness.factory/domain-package-v1
kind: DomainPackage
metadata: { name: primitives, version: 0.1.0, domain: test, objective: Test }
workflow: workflow.yaml
budgets: { maxDurationMs: 1000, maxCostUsd: 0, maxModelCalls: 0, maxCapabilityCalls: 0 }
capabilities: []
bindings: {}
`;
    const workflowSource = `
apiVersion: ladder.dev/v1alpha1
kind: Workflow
metadata: { name: primitives }
spec:
  inputs: { type: object }
  outputs: { type: object }
  nodes:
    - { id: input, kind: input }
    - { id: dedupe, kind: transform, config: { operation: deduplicate } }
    - { id: aggregate, kind: aggregator, config: { operation: vote } }
    - { id: settled, kind: join, config: { mode: allSettled } }
    - { id: output, kind: output }
  edges:
    - { id: a, from: input, to: dedupe, kind: data }
    - { id: b, from: dedupe, to: aggregate, kind: data }
    - { id: c, from: aggregate, to: settled, kind: data }
    - { id: d, from: settled, to: output, kind: data }
`;
    expect(analyzeAuthoringSources(packageSource, workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("rejects unsupported deterministic primitive modes during authoring", () => {
    const packageSource = `
apiVersion: harness.factory/domain-package-v1
kind: DomainPackage
metadata: { name: primitives, version: 0.1.0, domain: test, objective: Test }
workflow: workflow.yaml
budgets: { maxDurationMs: 1000, maxCostUsd: 0, maxModelCalls: 0, maxCapabilityCalls: 0 }
capabilities: []
bindings: {}
`;
    const workflowSource = `
apiVersion: ladder.dev/v1alpha1
kind: Workflow
metadata: { name: primitives }
spec:
  inputs: { type: object }
  outputs: { type: object }
  nodes:
    - { id: input, kind: input }
    - { id: bad-transform, kind: transform, config: { operation: execute-javascript } }
    - { id: bad-aggregate, kind: aggregator, config: { operation: average } }
    - { id: bad-join, kind: join, config: { mode: first } }
    - { id: output, kind: output }
  edges:
    - { id: a, from: input, to: bad-transform, kind: data }
    - { id: b, from: bad-transform, to: bad-aggregate, kind: data }
    - { id: c, from: bad-aggregate, to: bad-join, kind: data }
    - { id: d, from: bad-join, to: output, kind: data }
`;
    expect(analyzeAuthoringSources(packageSource, workflowSource).diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "author.transform_operation_unsupported", "author.aggregator_operation_unsupported", "author.join_mode_unsupported",
    ]));
  });

  it("rejects mixed runtime targets within one invocation", () => {
    const packageSource = `
apiVersion: harness.factory/domain-package-v1
kind: DomainPackage
metadata: { name: mixed, version: 0.1.0, domain: test, objective: Test }
workflow: workflow.yaml
budgets: { maxDurationMs: 1000, maxCostUsd: 0, maxModelCalls: 0, maxCapabilityCalls: 0 }
capabilities: []
bindings: {}
`;
    const workflowSource = `
apiVersion: ladder.dev/v1alpha1
kind: Workflow
metadata: { name: mixed }
spec:
  inputs: { type: object }
  outputs: { type: object }
  nodes:
    - { id: input, kind: input }
    - { id: local, kind: agent, config: { runtimeTarget: local_http } }
    - { id: azure, kind: agent, config: { runtimeTarget: azure_foundry } }
    - { id: output, kind: output }
  edges:
    - { id: a, from: input, to: local, kind: data }
    - { id: b, from: local, to: azure, kind: data }
    - { id: c, from: azure, to: output, kind: data }
`;
    const analysis = analyzeAuthoringSources(packageSource, workflowSource);
    expect(analysis.diagnostics.map((item) => item.code)).toContain("author.runtime_target_mixed");
  });
});
