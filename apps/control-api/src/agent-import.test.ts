import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildAgentBundleFromFiles } from "./agent-import.js";
import { applyAgentToAuthoringSources, materializeRegisteredContracts, updateNodeCaseWrites } from "./authoring-agents.js";
import { analyzeAuthoringSources, defaultAuthoringSources } from "./authoring.js";

describe("agent authoring", () => {
  it("imports a manifest and SKILL.md into provider-neutral registry contracts", () => {
    const bundle = buildAgentBundleFromFiles({ owner: "acme", repo: "kyc-agent" }, "main", [
      { path: "agent.yaml", content: "name: Evidence Reviewer\nrole: KYC analyst\ndescription: Reviews evidence\nmodel: anthropic/claude\nprompt: Return a recommendation.\n" },
      { path: "skills/screening/SKILL.md", content: "---\nname: Screening review\ndescription: Interpret screening results\n---\nCheck evidence provenance before deciding.\n" },
    ]);
    expect(bundle.agent.modelProfileId).toBe("model.standard.v1");
    expect(bundle.agent.skillIds).toEqual([bundle.skills[0]?.id]);
    expect(bundle.skills[0]?.source.type).toBe("github");
  });

  it("attaches an agent by updating portable workflow YAML", () => {
    const sources = defaultAuthoringSources();
    const bundle = buildAgentBundleFromFiles({ owner: "acme", repo: "reviewer" }, "main", [
      { path: "agent.yaml", content: "name: Reviewer\nrole: Analyst\ndescription: Reviews risk\nprompt: Review risk.\ninputSchema:\n  type: object\n  properties:\n    evidenceId: { type: string }\noutputSchema:\n  type: object\n  properties:\n    outcome: { type: string }\ncaseWrites:\n  - commandType: SubmitDecisionRecommendation\n    when: success\n    payload: {}\n    payloadSchema:\n      type: object\n      properties:\n        outcome: { type: string }\n" },
    ]);
    const attached = applyAgentToAuthoringSources({ ...sources, agent: bundle.agent, skills: bundle.skills, nodeId: "intake", mode: "insert-after", newNodeId: "review" });
    const pkg = parse(attached.packageSource);
    const workflow = parse(attached.workflowSource);
    const node = workflow.spec.nodes.find((candidate: { id: string }) => candidate.id === "review");
    expect(node.config.agentRef).toBe(bundle.agent.id);
    expect(node.config.modelProfileId).toBe("model.standard.v1");
    expect(node.config.runtimeTarget).toBe("local_http");
    expect(node.config.caseWrites).toEqual([expect.objectContaining({ commandType: "SubmitDecisionRecommendation", when: "success" })]);
    expect(node.inputSchema.properties).toHaveProperty("evidenceId");
    expect(node.outputSchema.properties).toHaveProperty("outcome");
    expect(node.config.caseWrites[0].payloadSchema.properties).toHaveProperty("outcome");
    expect(node.prompt).toBe("Review risk.");
    expect(pkg.agents).toEqual([expect.objectContaining({ id: bundle.agent.id, skillIds: [] })]);
    expect(pkg.agents[0]).not.toHaveProperty("source");
    expect(pkg.agents[0]).not.toHaveProperty("status");
    expect(analyzeAuthoringSources(attached.packageSource, attached.workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("embeds referenced skills and preserves case writes when replacing a node", () => {
    const sources = defaultAuthoringSources();
    const workflow = parse(sources.workflowSource);
    workflow.spec.nodes.splice(1, 0, {
      id: "review", kind: "transform", name: "Review",
      config: { caseWrites: [{ commandType: "SubmitDecisionRecommendation", payload: { outcome: "{{ output.outcome }}" }, payloadSchema: { type: "object" } }] },
    });
    workflow.spec.edges = [
      { id: "e1", from: "intake", to: "review", kind: "data" },
      { id: "e2", from: "review", to: "result", kind: "data" },
    ];
    const bundle = buildAgentBundleFromFiles({ owner: "acme", repo: "reviewer" }, "main", [
      { path: "agent.yaml", content: "name: Reviewer\nrole: Analyst\ndescription: Reviews risk\nprompt: Review risk.\n" },
      { path: "skills/review/SKILL.md", content: "---\nname: Risk review\ndescription: Review risk evidence\n---\nCheck the evidence.\n" },
    ]);
    const attached = applyAgentToAuthoringSources({
      packageSource: sources.packageSource, workflowSource: JSON.stringify(workflow), agent: bundle.agent, skills: bundle.skills,
      nodeId: "review", mode: "replace",
    });
    const pkg = parse(attached.packageSource);
    const replaced = parse(attached.workflowSource).spec.nodes.find((candidate: { id: string }) => candidate.id === "review");
    expect(pkg.skills).toEqual([expect.objectContaining({ id: bundle.skills[0]?.id, instructions: "Check the evidence." })]);
    expect(pkg.agents).toEqual([expect.objectContaining({ id: bundle.agent.id, skillIds: [bundle.skills[0]?.id] })]);
    expect(replaced.config.caseWrites).toHaveLength(1);
    expect(analyzeAuthoringSources(attached.packageSource, attached.workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("updates case-write contracts directly on a canvas node", () => {
    const sources = defaultAuthoringSources();
    const workflowSource = updateNodeCaseWrites(sources.workflowSource, "intake", [{
      commandType: "LinkEvidence", when: "success", payload: { evidenceId: "{{ output.id }}" }, payloadSchema: { type: "object" },
    }]);
    const workflow = parse(workflowSource);
    expect(workflow.spec.nodes[0].config.caseWrites).toEqual([expect.objectContaining({ commandType: "LinkEvidence" })]);
    expect(analyzeAuthoringSources(sources.packageSource, workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("materializes legacy registry references before compilation", () => {
    const sources = defaultAuthoringSources();
    const bundle = buildAgentBundleFromFiles({ owner: "acme", repo: "reviewer" }, "main", [
      { path: "agent.yaml", content: "id: domain-agent1\nname: Reviewer\nrole: Analyst\ndescription: Reviews risk\nprompt: Review risk.\ncaseWrites:\n  - commandType: LinkEvidence\n    payload: {}\n    payloadSchema: { type: object }\n" },
      { path: "skills/review/SKILL.md", content: "---\nname: Risk review\ndescription: Review risk evidence\n---\nCheck the evidence.\n" },
    ]);
    const workflow = parse(sources.workflowSource);
    workflow.spec.nodes.splice(1, 0, {
      id: "review", kind: "evaluate", name: "Reviewer",
      config: { agentRef: bundle.agent.id, skillRefs: bundle.agent.skillIds },
    });
    workflow.spec.edges = [
      { id: "e1", from: "intake", to: "review", kind: "data" },
      { id: "e2", from: "review", to: "result", kind: "data" },
    ];
    const materialized = materializeRegisteredContracts({
      packageSource: sources.packageSource, workflowSource: JSON.stringify(workflow), agents: [bundle.agent], skills: bundle.skills, capabilities: [],
    });
    const pkg = parse(materialized.packageSource);
    const node = parse(materialized.workflowSource).spec.nodes.find((candidate: { id: string }) => candidate.id === "review");
    expect(materialized.materialized).toBe(true);
    expect(pkg.agents).toEqual([expect.objectContaining({ id: bundle.agent.id })]);
    expect(pkg.skills).toEqual([expect.objectContaining({ id: bundle.skills[0]?.id })]);
    expect(node.config.caseWrites).toEqual([expect.objectContaining({ commandType: "LinkEvidence" })]);
    expect(analyzeAuthoringSources(materialized.packageSource, materialized.workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });
});
