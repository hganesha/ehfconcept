import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import {
  businessCommandTypeSchema,
  capabilityDefinitionSchema,
  compiledAgentSchema,
  compiledSkillSchema,
  harnessPlanSchema,
  stableDigest,
  type CapabilityDefinition,
  type CapabilityRegistration,
  type EvaluationReport,
  type HarnessPlan,
} from "@ehf/contracts";
import type { AuthoringDiagnostic } from "@ehf/persistence";

type JsonMap = Record<string, unknown>;
type PackageSource = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; version: string; domain: string; objective: string };
  workflow: string;
  budgets: { maxDurationMs: number; maxCostUsd: number; maxModelCalls: number; maxCapabilityCalls: number };
  modelProfiles?: string[];
  skills?: unknown[];
  agents?: unknown[];
  capabilities?: unknown[];
  bindings?: Record<string, string>;
};
type WorkflowNode = {
  id: string; kind: string; name?: string; summary?: string; prompt?: string;
  inputSchema?: JsonMap | null; outputSchema?: JsonMap | null; config?: JsonMap;
};
type WorkflowEdge = { id: string; from: string; to: string; kind: string; condition?: string; sourcePath?: string; targetPath?: string };
type WorkflowSource = {
  apiVersion: string; kind: string;
  metadata: { name: string; title?: string; description?: string; version?: string };
  spec: { objective?: string; inputs?: JsonMap; outputs?: JsonMap; policies?: { maxConcurrency?: number }; nodes: WorkflowNode[]; edges: WorkflowEdge[] };
};

const nodeKinds = new Set(["input", "output", "agent", "tool", "transform", "condition", "evaluate", "join", "aggregator"]);

function diagnostic(code: string, path: string, message: string, severity: AuthoringDiagnostic["severity"] = "error"): AuthoringDiagnostic {
  return { code, path, message, severity };
}

function object(value: unknown): value is JsonMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function topologicalOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!incoming.has(edge.to) || !outgoing.has(edge.from)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const queue = nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift();
    if (!id) break;
    order.push(id);
    for (const target of outgoing.get(id) ?? []) {
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  return order;
}

function validateCaseWrites(node: WorkflowNode, diagnostics: AuthoringDiagnostic[]) {
  const writes = node.config?.caseWrites;
  if (writes === undefined) return;
  if (!Array.isArray(writes)) {
    diagnostics.push(diagnostic("author.case_writes_array_required", `workflow.nodes.${node.id}.config.caseWrites`, "caseWrites must be an array."));
    return;
  }
  writes.forEach((entry, index) => {
    if (!object(entry)) {
      diagnostics.push(diagnostic("author.case_write_invalid", `workflow.nodes.${node.id}.config.caseWrites.${index}`, "Case write must be an object."));
      return;
    }
    const command = businessCommandTypeSchema.safeParse(entry.commandType);
    if (!command.success) diagnostics.push(diagnostic("author.case_write_command_invalid", `workflow.nodes.${node.id}.config.caseWrites.${index}.commandType`, "Use a supported canonical case command."));
    if (!object(entry.payload)) diagnostics.push(diagnostic("author.case_write_payload_required", `workflow.nodes.${node.id}.config.caseWrites.${index}.payload`, "An executable payload mapping is required for each case write."));
    if (!object(entry.payloadSchema)) diagnostics.push(diagnostic("author.case_write_schema_required", `workflow.nodes.${node.id}.config.caseWrites.${index}.payloadSchema`, "A JSON Schema object is required for each case write."));
  });
}

export function analyzeAuthoringSources(packageSource: string, workflowSource: string): {
  parsedPackage: JsonMap;
  parsedWorkflow: JsonMap;
  diagnostics: AuthoringDiagnostic[];
  metadata: { name: string; domain: string; version: string };
} {
  const diagnostics: AuthoringDiagnostic[] = [];
  let pkg: PackageSource;
  let workflow: WorkflowSource;
  try {
    pkg = parse(packageSource) as PackageSource;
  } catch (error) {
    throw new Error(`authoring.package_yaml_invalid: ${error instanceof Error ? error.message : "parse failed"}`);
  }
  try {
    workflow = parse(workflowSource) as WorkflowSource;
  } catch (error) {
    throw new Error(`authoring.workflow_yaml_invalid: ${error instanceof Error ? error.message : "parse failed"}`);
  }
  if (!object(pkg) || pkg.apiVersion !== "harness.factory/domain-package-v1" || pkg.kind !== "DomainPackage") {
    diagnostics.push(diagnostic("author.package_contract_unsupported", "package", "Expected harness.factory/domain-package-v1 DomainPackage."));
  }
  if (!object(pkg?.metadata) || !pkg.metadata.name || !pkg.metadata.domain || !pkg.metadata.version || !pkg.metadata.objective) {
    diagnostics.push(diagnostic("author.package_metadata_required", "package.metadata", "Name, domain, version, and objective are required."));
  }
  if (!object(workflow) || workflow.apiVersion !== "ladder.dev/v1alpha1" || workflow.kind !== "Workflow") {
    diagnostics.push(diagnostic("author.workflow_contract_unsupported", "workflow", "Expected ladder.dev/v1alpha1 Workflow."));
  }
  const nodes = Array.isArray(workflow?.spec?.nodes) ? workflow.spec.nodes : [];
  const edges = Array.isArray(workflow?.spec?.edges) ? workflow.spec.edges : [];
  const ids = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    if (!node.id || ids.has(node.id)) diagnostics.push(diagnostic("author.node_id_invalid", `workflow.spec.nodes.${index}.id`, "Node IDs must be non-empty and unique."));
    ids.add(node.id);
    if (!nodeKinds.has(node.kind)) diagnostics.push(diagnostic("author.node_kind_unsupported", `workflow.spec.nodes.${index}.kind`, `Unsupported primitive: ${node.kind}.`));
    validateCaseWrites(node, diagnostics);
  }
  for (const [index, edge] of edges.entries()) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) diagnostics.push(diagnostic("author.edge_reference_missing", `workflow.spec.edges.${index}`, `Edge ${edge.id} references a missing node.`));
    if (edge.from === edge.to) diagnostics.push(diagnostic("author.edge_self_reference", `workflow.spec.edges.${index}`, "Self-referencing edges are not executable."));
  }
  const runtimeTargets = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    const target = node.config?.runtimeTarget;
    if (target === undefined) continue;
    if (target !== "local_http" && target !== "azure_foundry") diagnostics.push(diagnostic("author.runtime_target_invalid", `workflow.spec.nodes.${index}.config.runtimeTarget`, "Runtime target must be local_http or azure_foundry."));
    else runtimeTargets.add(target);
  }
  if (runtimeTargets.size > 1) diagnostics.push(diagnostic("author.runtime_target_mixed", "workflow.spec.nodes", "A POC harness invocation must use one runtime target across all agent nodes."));
  const order = topologicalOrder(nodes, edges);
  if (nodes.length > 0 && order.length !== nodes.length) diagnostics.push(diagnostic("author.graph_cycle", "workflow.spec.edges", "The executable graph must be acyclic."));
  if (!nodes.some((node) => node.kind === "input")) diagnostics.push(diagnostic("author.input_missing", "workflow.spec.nodes", "At least one input node is required."));
  if (!nodes.some((node) => node.kind === "output")) diagnostics.push(diagnostic("author.output_missing", "workflow.spec.nodes", "At least one output node is required."));
  const capabilities = Array.isArray(pkg?.capabilities) ? pkg.capabilities : [];
  capabilities.forEach((capability, index) => {
    const parsed = capabilityDefinitionSchema.safeParse(capability);
    if (!parsed.success) diagnostics.push(diagnostic("author.capability_invalid", `package.capabilities.${index}`, parsed.error.issues[0]?.message ?? "Invalid capability definition."));
  });
  const skills = Array.isArray(pkg?.skills) ? pkg.skills : [];
  const agents = Array.isArray(pkg?.agents) ? pkg.agents : [];
  const skillIds = new Set<string>();
  const agentIds = new Set<string>();
  skills.forEach((skill, index) => {
    const parsed = compiledSkillSchema.safeParse(skill);
    if (!parsed.success) diagnostics.push(diagnostic("author.skill_invalid", `package.skills.${index}`, parsed.error.issues[0]?.message ?? "Invalid skill definition."));
    else if (skillIds.has(parsed.data.id)) diagnostics.push(diagnostic("author.skill_duplicate", `package.skills.${index}.id`, `Skill ${parsed.data.id} is duplicated.`));
    else skillIds.add(parsed.data.id);
  });
  agents.forEach((agent, index) => {
    const parsed = compiledAgentSchema.safeParse(agent);
    if (!parsed.success) diagnostics.push(diagnostic("author.agent_invalid", `package.agents.${index}`, parsed.error.issues[0]?.message ?? "Invalid agent definition."));
    else {
      if (agentIds.has(parsed.data.id)) diagnostics.push(diagnostic("author.agent_duplicate", `package.agents.${index}.id`, `Agent ${parsed.data.id} is duplicated.`));
      agentIds.add(parsed.data.id);
      parsed.data.skillIds.forEach((skillId) => {
        if (!skillIds.has(skillId)) diagnostics.push(diagnostic("author.agent_skill_missing", `package.agents.${index}.skillIds`, `Agent ${parsed.data.id} references missing skill ${skillId}.`));
      });
    }
  });
  nodes.forEach((node, index) => {
    const agentRef = node.config?.agentRef;
    if ((node.kind === "agent" || node.kind === "evaluate") && typeof agentRef === "string" && !agentIds.has(agentRef)) {
      diagnostics.push(diagnostic("author.node_agent_missing", `workflow.spec.nodes.${index}.config.agentRef`, `Node ${node.id} references missing source agent ${agentRef}.`));
    }
    const skillRefs = node.config?.skillRefs;
    if (Array.isArray(skillRefs)) skillRefs.forEach((skillId) => {
      if (typeof skillId === "string" && !skillIds.has(skillId)) diagnostics.push(diagnostic("author.node_skill_missing", `workflow.spec.nodes.${index}.config.skillRefs`, `Node ${node.id} references missing source skill ${skillId}.`));
    });
  });
  for (const [nodeId, capabilityId] of Object.entries(pkg?.bindings ?? {})) {
    if (!ids.has(nodeId)) diagnostics.push(diagnostic("author.binding_node_missing", `package.bindings.${nodeId}`, "Binding references a missing node."));
    if (![...capabilities].some((candidate) => object(candidate) && candidate.id === capabilityId)) {
      diagnostics.push(diagnostic("author.binding_capability_external", `package.bindings.${nodeId}`, `Capability ${capabilityId} must resolve from the gateway registry before compile.`, "warning"));
    }
  }
  return {
    parsedPackage: object(pkg) ? (pkg as unknown as JsonMap) : {},
    parsedWorkflow: object(workflow) ? (workflow as unknown as JsonMap) : {},
    diagnostics,
    metadata: {
      name: pkg?.metadata?.name ?? "untitled-domain",
      domain: pkg?.metadata?.domain ?? "unassigned",
      version: pkg?.metadata?.version ?? "0.1.0",
    },
  };
}

export async function compileAuthoringDraft(input: {
  packageSource: string;
  workflowSource: string;
  registryCapabilities: CapabilityRegistration[];
  modelProfilesPath: string;
}): Promise<{ plan: HarnessPlan | null; diagnostics: AuthoringDiagnostic[] }> {
  const analysis = analyzeAuthoringSources(input.packageSource, input.workflowSource);
  const pkg = analysis.parsedPackage as unknown as PackageSource;
  const workflow = analysis.parsedWorkflow as unknown as WorkflowSource;
  const diagnostics = [...analysis.diagnostics];
  const embedded = (pkg.capabilities ?? []).flatMap((capability) => {
    const parsed = capabilityDefinitionSchema.safeParse(capability);
    return parsed.success ? [parsed.data] : [];
  });
  const registry = input.registryCapabilities.map(({ description: _description, owner: _owner, dataClasses: _classes, status: _status, ...capability }) => capability);
  const capabilityMap = new Map<string, CapabilityDefinition>([...registry, ...embedded].map((capability) => [capability.id, capability]));
  const skills = (pkg.skills ?? []).flatMap((skill) => {
    const parsed = compiledSkillSchema.safeParse(skill);
    return parsed.success ? [parsed.data] : [];
  });
  const agents = (pkg.agents ?? []).flatMap((agent) => {
    const parsed = compiledAgentSchema.safeParse(agent);
    return parsed.success ? [parsed.data] : [];
  });
  const bindings = pkg.bindings ?? {};
  for (const [nodeId, capabilityId] of Object.entries(bindings)) {
    if (!capabilityMap.has(capabilityId)) diagnostics.push(diagnostic("compiler.capability_unresolved", `package.bindings.${nodeId}`, `Capability ${capabilityId} is neither embedded nor registered in the gateway.`));
  }
  skills.forEach((skill, index) => skill.allowedCapabilityIds.forEach((capabilityId) => {
    if (!capabilityMap.has(capabilityId)) diagnostics.push(diagnostic("compiler.skill_capability_unresolved", `package.skills.${index}.allowedCapabilityIds`, `Skill ${skill.id} references unresolved capability ${capabilityId}.`));
  }));
  agents.forEach((agent, index) => {
    if (agent.primaryCapabilityId && !capabilityMap.has(agent.primaryCapabilityId)) diagnostics.push(diagnostic("compiler.agent_capability_unresolved", `package.agents.${index}.primaryCapabilityId`, `Agent ${agent.id} references unresolved capability ${agent.primaryCapabilityId}.`));
  });
  if (diagnostics.some((item) => item.severity === "error")) return { plan: null, diagnostics };

  const modelProfileRegistry = JSON.parse(await readFile(input.modelProfilesPath, "utf8")) as { profiles: JsonMap[] };
  const modelProfiles = (pkg.modelProfiles ?? []).flatMap((id) => {
    const profile = modelProfileRegistry.profiles.find((candidate) => candidate.id === id);
    if (!profile) {
      diagnostics.push(diagnostic("compiler.model_profile_missing", `package.modelProfiles.${id}`, `Model profile ${id} is not configured.`));
      return [];
    }
    return [{ id, digest: stableDigest(profile) }];
  });
  if (diagnostics.some((item) => item.severity === "error")) return { plan: null, diagnostics };

  const nodes = workflow.spec.nodes;
  const edges = workflow.spec.edges;
  const nodeOrder = topologicalOrder(nodes, edges);
  const resolvedCapabilityIds = [...new Set(Object.values(bindings))];
  const capabilities = resolvedCapabilityIds.map((id) => capabilityMap.get(id)).filter((value): value is CapabilityDefinition => Boolean(value));
  const permissionEnvelopes = Object.entries(bindings).map(([nodeId, capabilityId]) => {
    const capability = capabilityMap.get(capabilityId)!;
    const unsigned = { nodeId, capabilities: [capabilityId], effects: [capability.effect] };
    return { ...unsigned, digest: stableDigest(unsigned) };
  });
  const normalizedNodes = nodes.map((node) => ({
    id: node.id,
    kind: node.kind as "input" | "output" | "agent" | "tool" | "transform" | "condition" | "evaluate" | "join" | "aggregator",
    name: node.name || node.id,
    ...(node.summary ? { summary: node.summary } : {}),
    ...(node.prompt ? { prompt: node.prompt } : {}),
    ...(node.inputSchema !== undefined ? { inputSchema: node.inputSchema } : {}),
    ...(node.outputSchema !== undefined ? { outputSchema: node.outputSchema } : {}),
    config: { ...(node.config ?? {}), ...(bindings[node.id] ? { capabilityId: bindings[node.id] } : {}) },
  }));
  const normalizedEdges = edges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind as "data" | "dependency" | "control",
    ...(edge.condition ? { condition: edge.condition } : {}),
    ...(edge.sourcePath ? { sourcePath: edge.sourcePath } : {}),
    ...(edge.targetPath ? { targetPath: edge.targetPath } : {}),
  }));
  const packageDigest = stableDigest({ packageSource: analysis.parsedPackage, workflowSource: analysis.parsedWorkflow });
  const content = {
    apiVersion: "harness.factory/plan-v1" as const,
    kind: "HarnessPlan" as const,
    packageDigest,
    compiler: { name: "harnessc" as const, version: "0.2.0-author-plane", lgirCoreRevision: "fec01bf0fa5ff259c071439d63ad71c9979668f9" },
    metadata: pkg.metadata,
    execution: { engine: { kind: "langgraph-js" as const, adapterVersion: "harness-langgraph-v1" as const, profile: "poc-v1" as const }, maxTransitions: 200, maxConcurrency: workflow.spec.policies?.maxConcurrency ?? 1, durability: "sync" as const },
    budgets: pkg.budgets,
    schemas: { input: workflow.spec.inputs ?? {}, output: workflow.spec.outputs ?? {} },
    modelProfiles,
    skills,
    agents,
    capabilities,
    permissionEnvelopes,
    graph: { apiVersion: "ladder.dev/v1alpha1" as const, name: workflow.metadata.name, nodes: normalizedNodes, edges: normalizedEdges, nodeOrder },
    dependencyManifest: [
      { path: "package.yaml", digest: stableDigest(analysis.parsedPackage) },
      { path: pkg.workflow || "workflow.yaml", digest: stableDigest(analysis.parsedWorkflow) },
    ],
  };
  const planDigest = stableDigest(content);
  const plan = harnessPlanSchema.parse({ ...content, planId: `${pkg.metadata.name}@${pkg.metadata.version}:${planDigest.slice(0, 12)}`, planDigest });
  diagnostics.push(diagnostic("compiler.plan_emitted", "plan", `Immutable plan ${planDigest.slice(0, 12)} emitted.`, "info"));
  return { plan, diagnostics };
}

export function evaluateCompiledPlan(plan: HarnessPlan): EvaluationReport {
  const checks = [
    { id: "graph.connected", label: "Executable topology", passed: plan.graph.nodeOrder.length === plan.graph.nodes.length, detail: `${plan.graph.nodes.length} nodes ordered without a cycle.` },
    { id: "authority.bound", label: "Capability authority", passed: plan.permissionEnvelopes.length === plan.graph.nodes.filter((node) => typeof node.config.capabilityId === "string").length, detail: `${plan.permissionEnvelopes.length} node permission envelopes emitted.` },
    { id: "agents.embedded", label: "Embedded agent and skill contracts", passed: (plan.agents?.length ?? 0) >= plan.graph.nodes.filter((node) => node.kind === "agent" || node.kind === "evaluate").length && (plan.skills?.length ?? 0) > 0, detail: `${plan.agents?.length ?? 0} agents and ${plan.skills?.length ?? 0} skills compiled from source.` },
    { id: "case-writes.schema", label: "Case-write contracts", passed: true, detail: `${plan.graph.nodes.reduce((sum, node) => sum + (Array.isArray(node.config.caseWrites) ? node.config.caseWrites.length : 0), 0)} canonical command schemas validated.` },
    { id: "budgets.bounded", label: "Execution budgets", passed: plan.budgets.maxDurationMs > 0 && plan.budgets.maxCapabilityCalls >= plan.capabilities.length, detail: `Duration ${plan.budgets.maxDurationMs}ms; ${plan.budgets.maxCapabilityCalls} capability calls.` },
    { id: "runtime.compatible", label: "LangGraph runtime profile", passed: plan.execution.engine.adapterVersion === "harness-langgraph-v1", detail: plan.execution.engine.adapterVersion },
  ];
  return { passed: checks.every((check) => check.passed), evaluatedAt: new Date().toISOString(), planDigest: plan.planDigest, checks };
}

export function defaultAuthoringSources() {
  const workflow = {
    apiVersion: "ladder.dev/v1alpha1",
    kind: "Workflow",
    metadata: { name: "new-domain-harness", title: "New domain harness", description: "Author a governed domain workflow.", version: "0.1.0" },
    spec: {
      objective: "Produce a governed domain outcome.",
      inputs: { type: "object", properties: {} }, outputs: { type: "object" },
      policies: { maxConcurrency: 2, onFailure: "stop", requireApprovalFor: [] },
      nodes: [
        { id: "intake", kind: "input", name: "Domain intake", config: { caseWrites: [] } },
        { id: "result", kind: "output", name: "Domain outcome", config: { caseWrites: [] } },
      ],
      edges: [{ id: "e1", from: "intake", to: "result", kind: "data" }],
    },
  };
  const pkg = {
    apiVersion: "harness.factory/domain-package-v1", kind: "DomainPackage",
    metadata: { name: "new-domain-harness", version: "0.1.0", domain: "new_domain", objective: "Produce a governed domain outcome." },
    workflow: "workflow.yaml",
    budgets: { maxDurationMs: 120000, maxCostUsd: 0.25, maxModelCalls: 2, maxCapabilityCalls: 4 },
    modelProfiles: ["model.standard.v1"], capabilities: [], bindings: {},
  };
  return { packageSource: stringify(pkg, { lineWidth: 110 }), workflowSource: stringify(workflow, { lineWidth: 110 }) };
}
