import { parse, stringify } from "yaml";
import type { AgentRegistration, SkillRegistration } from "@ehf/contracts";

type JsonMap = Record<string, unknown>;
function object(value: unknown): value is JsonMap { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export function applyAgentToAuthoringSources(input: {
  packageSource: string; workflowSource: string; agent: AgentRegistration; skills: SkillRegistration[]; nodeId: string;
  mode: "replace" | "insert-after"; newNodeId?: string;
}): { packageSource: string; workflowSource: string; attachedNodeId: string } {
  const pkg = parse(input.packageSource) as JsonMap;
  const workflow = parse(input.workflowSource) as JsonMap;
  if (!object(pkg) || !object(workflow) || !object(workflow.spec)) throw new Error("authoring.agent_source_invalid");
  const nodes = Array.isArray(workflow.spec.nodes) ? workflow.spec.nodes as JsonMap[] : [];
  const edges = Array.isArray(workflow.spec.edges) ? workflow.spec.edges as JsonMap[] : [];
  const selectedIndex = nodes.findIndex((node) => node.id === input.nodeId);
  if (selectedIndex < 0) throw new Error("authoring.agent_node_not_found");
  const selected = nodes[selectedIndex]!;
  if (selected.kind === "input" && input.mode === "replace" || selected.kind === "output") throw new Error("authoring.agent_node_kind_protected");
  const attachedNodeId = input.mode === "replace" ? input.nodeId : (input.newNodeId?.trim() || `${input.nodeId}-${input.agent.name}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!attachedNodeId || input.mode === "insert-after" && nodes.some((node) => node.id === attachedNodeId)) throw new Error("authoring.agent_node_id_invalid");
  const priorConfig = input.mode === "replace" && object(selected.config) ? selected.config : {};
  const agentNode: JsonMap = {
    ...(input.mode === "replace" ? selected : {}), id: attachedNodeId, kind: "evaluate", name: input.agent.name,
    summary: input.agent.description, role: input.agent.role, prompt: input.agent.prompt,
    inputSchema: input.agent.inputSchema, outputSchema: input.agent.outputSchema,
    config: { caseWrites: input.agent.caseWrites, ...priorConfig, agentRef: input.agent.id, agentVersion: input.agent.version, skillRefs: input.agent.skillIds, modelProfileId: input.agent.modelProfileId, runtimeTarget: input.agent.runtimeTarget },
  };
  if (input.mode === "replace") nodes[selectedIndex] = agentNode;
  else {
    nodes.splice(selectedIndex + 1, 0, agentNode);
    const outgoing = edges.filter((edge) => edge.from === input.nodeId);
    outgoing.forEach((edge) => { edge.from = attachedNodeId; });
    edges.push({ id: `edge-${input.nodeId}-${attachedNodeId}`, from: input.nodeId, to: attachedNodeId, kind: "data" });
  }
  const modelProfiles = Array.isArray(pkg.modelProfiles) ? pkg.modelProfiles as unknown[] : [];
  if (!modelProfiles.includes(input.agent.modelProfileId)) pkg.modelProfiles = [...modelProfiles, input.agent.modelProfileId];
  const packageSkills = Array.isArray(pkg.skills) ? pkg.skills as JsonMap[] : [];
  const packageAgents = Array.isArray(pkg.agents) ? pkg.agents as JsonMap[] : [];
  const referencedSkills = input.agent.skillIds.map((skillId) => {
    const skill = input.skills.find((candidate) => candidate.id === skillId);
    if (!skill) throw new Error(`authoring.agent_skill_not_registered:${skillId}`);
    const { source: _source, status: _status, ...compiledSkill } = skill;
    return compiledSkill;
  });
  const { source: _source, status: _status, ...compiledAgent } = input.agent;
  const upsertById = (items: JsonMap[], additions: JsonMap[]) => {
    const additionIds = new Set(additions.map((item) => item.id));
    return [...items.filter((item) => !additionIds.has(item.id)), ...additions];
  };
  pkg.skills = upsertById(packageSkills, referencedSkills);
  pkg.agents = upsertById(packageAgents, [compiledAgent]);
  if (input.agent.primaryCapabilityId) {
    const bindings = object(pkg.bindings) ? pkg.bindings : {};
    pkg.bindings = { ...bindings, [attachedNodeId]: input.agent.primaryCapabilityId };
  }
  return { packageSource: stringify(pkg, { lineWidth: 120 }), workflowSource: stringify(workflow, { lineWidth: 120 }), attachedNodeId };
}

export function updateNodeCaseWrites(workflowSource: string, nodeId: string, caseWrites: unknown[]): string {
  const workflow = parse(workflowSource) as JsonMap;
  if (!object(workflow) || !object(workflow.spec)) throw new Error("authoring.agent_source_invalid");
  const nodes = Array.isArray(workflow.spec.nodes) ? workflow.spec.nodes as JsonMap[] : [];
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error("authoring.agent_node_not_found");
  const config = object(node.config) ? node.config : {};
  node.config = { ...config, caseWrites };
  return stringify(workflow, { lineWidth: 120 });
}
