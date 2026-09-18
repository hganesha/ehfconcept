import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildAgentBundleFromFiles } from "./agent-import.js";
import { applyAgentToAuthoringSources } from "./authoring-agents.js";
import { defaultAuthoringSources } from "./authoring.js";

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
      { path: "agent.yaml", content: "name: Reviewer\nrole: Analyst\ndescription: Reviews risk\nprompt: Review risk.\n" },
    ]);
    const attached = applyAgentToAuthoringSources({ ...sources, agent: bundle.agent, nodeId: "intake", mode: "insert-after", newNodeId: "review" });
    const workflow = parse(attached.workflowSource);
    const node = workflow.spec.nodes.find((candidate: { id: string }) => candidate.id === "review");
    expect(node.config.agentRef).toBe(bundle.agent.id);
    expect(node.config.modelProfileId).toBe("model.standard.v1");
    expect(node.config.runtimeTarget).toBe("local_http");
    expect(node.prompt).toBe("Review risk.");
  });
});
