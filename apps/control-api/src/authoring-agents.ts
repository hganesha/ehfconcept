import { parse, stringify } from "yaml";
import type { AgentRegistration } from "@ehf/contracts";

type JsonMap = Record<string, unknown>;
function object(value: unknown): value is JsonMap { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

export function applyAgentToAuthoringSources(input: {
  packageSource: string; workflowSource: string; agent: AgentRegistration; nodeId: string;
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
    config: { ...priorConfig, agentRef: input.agent.id, agentVersion: input.agent.version, skillRefs: input.agent.skillIds, modelProfileId: input.agent.modelProfileId, runtimeTarget: input.agent.runtimeTarget },
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
  if (input.agent.primaryCapabilityId) {
    const bindings = object(pkg.bindings) ? pkg.bindings : {};
    pkg.bindings = { ...bindings, [attachedNodeId]: input.agent.primaryCapabilityId };
  }
  return { packageSource: stringify(pkg, { lineWidth: 120 }), workflowSource: stringify(workflow, { lineWidth: 120 }), attachedNodeId };
}
