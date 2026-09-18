import { parse, stringify } from "yaml";
import type { AgentRegistration, SkillRegistration } from "@ehf/contracts";

type JsonMap = Record<string, unknown>;
function object(value: unknown): value is JsonMap { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

function compiledSkill(skill: SkillRegistration): JsonMap {
  const { source: _source, status: _status, ...contract } = skill;
  return contract;
}

function compiledAgent(agent: AgentRegistration): JsonMap {
  const { source: _source, status: _status, ...contract } = agent;
  return contract;
}

function upsertById(items: JsonMap[], additions: JsonMap[]): JsonMap[] {
  const additionIds = new Set(additions.map((item) => item.id));
  return [...items.filter((item) => !additionIds.has(item.id)), ...additions];
}

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
    return compiledSkill(skill);
  });
  pkg.skills = upsertById(packageSkills, referencedSkills);
  pkg.agents = upsertById(packageAgents, [compiledAgent(input.agent)]);
  if (input.agent.primaryCapabilityId) {
    const bindings = object(pkg.bindings) ? pkg.bindings : {};
    pkg.bindings = { ...bindings, [attachedNodeId]: input.agent.primaryCapabilityId };
  }
  return { packageSource: stringify(pkg, { lineWidth: 120 }), workflowSource: stringify(workflow, { lineWidth: 120 }), attachedNodeId };
}

export function materializeRegisteredContracts(input: {
  packageSource: string; workflowSource: string; agents: AgentRegistration[]; skills: SkillRegistration[];
}): { packageSource: string; workflowSource: string; materialized: boolean } {
  const pkg = parse(input.packageSource) as JsonMap;
  const workflow = parse(input.workflowSource) as JsonMap;
  if (!object(pkg) || !object(workflow) || !object(workflow.spec)) throw new Error("authoring.agent_source_invalid");
  const nodes = Array.isArray(workflow.spec.nodes) ? workflow.spec.nodes as JsonMap[] : [];
  const packageAgents = Array.isArray(pkg.agents) ? pkg.agents as JsonMap[] : [];
  const packageSkills = Array.isArray(pkg.skills) ? pkg.skills as JsonMap[] : [];
  const embeddedAgentIds = new Set(packageAgents.map((agent) => agent.id).filter((id): id is string => typeof id === "string"));
  const embeddedSkillIds = new Set(packageSkills.map((skill) => skill.id).filter((id): id is string => typeof id === "string"));
  const registryAgents = new Map(input.agents.map((agent) => [agent.id, agent]));
  const registrySkills = new Map(input.skills.map((skill) => [skill.id, skill]));
  const missingAgentIds = new Set<string>();
  const requiredSkillIds = new Set<string>();

  for (const node of nodes) {
    const config = object(node.config) ? node.config : {};
    const agentRef = typeof config.agentRef === "string" ? config.agentRef : null;
    if (agentRef && !embeddedAgentIds.has(agentRef)) missingAgentIds.add(agentRef);
    if (Array.isArray(config.skillRefs)) {
      config.skillRefs.forEach((skillId) => { if (typeof skillId === "string") requiredSkillIds.add(skillId); });
    }
  }

  const agents = [...missingAgentIds].flatMap((agentId) => {
    const agent = registryAgents.get(agentId);
    if (!agent) return [];
    agent.skillIds.forEach((skillId) => requiredSkillIds.add(skillId));
    return [agent];
  });
  const skills = [...requiredSkillIds].flatMap((skillId) => {
    if (embeddedSkillIds.has(skillId)) return [];
    const skill = registrySkills.get(skillId);
    return skill ? [skill] : [];
  });
  if (!agents.length && !skills.length) return { packageSource: input.packageSource, workflowSource: input.workflowSource, materialized: false };

  pkg.agents = upsertById(packageAgents, agents.map(compiledAgent));
  pkg.skills = upsertById(packageSkills, skills.map(compiledSkill));
  const modelProfiles = Array.isArray(pkg.modelProfiles) ? pkg.modelProfiles as unknown[] : [];
  pkg.modelProfiles = [...new Set([...modelProfiles, ...agents.map((agent) => agent.modelProfileId)])];
  const bindings = object(pkg.bindings) ? pkg.bindings : {};
  for (const node of nodes) {
    const config = object(node.config) ? node.config : {};
    const agentRef = typeof config.agentRef === "string" ? config.agentRef : null;
    const agent = agentRef ? agents.find((candidate) => candidate.id === agentRef) : undefined;
    if (!agent) continue;
    node.inputSchema = object(node.inputSchema) ? node.inputSchema : agent.inputSchema;
    node.outputSchema = object(node.outputSchema) ? node.outputSchema : agent.outputSchema;
    node.role = typeof node.role === "string" ? node.role : agent.role;
    node.prompt = typeof node.prompt === "string" ? node.prompt : agent.prompt;
    node.config = {
      ...config,
      caseWrites: Array.isArray(config.caseWrites) ? config.caseWrites : agent.caseWrites,
      skillRefs: Array.isArray(config.skillRefs) ? config.skillRefs : agent.skillIds,
      modelProfileId: typeof config.modelProfileId === "string" ? config.modelProfileId : agent.modelProfileId,
      runtimeTarget: typeof config.runtimeTarget === "string" ? config.runtimeTarget : agent.runtimeTarget,
    };
    if (agent.primaryCapabilityId && typeof bindings[String(node.id)] !== "string") bindings[String(node.id)] = agent.primaryCapabilityId;
  }
  pkg.bindings = bindings;
  return {
    packageSource: stringify(pkg, { lineWidth: 120 }),
    workflowSource: stringify(workflow, { lineWidth: 120 }),
    materialized: true,
  };
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
