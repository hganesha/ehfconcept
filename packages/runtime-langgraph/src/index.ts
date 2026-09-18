import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { HarnessPlan } from "@ehf/contracts";
import {
  evaluateCondition,
  aggregateValue,
  executeCaseWrites,
  executeObservedNode,
  getPath,
  invokeCapability,
  renderTemplate,
  transformValue,
  type RuntimeContext,
} from "@ehf/runtime-core";

const stateSchema = Annotation.Root({
  input: Annotation<unknown>(),
  values: Annotation<Record<string, unknown>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
  output: Annotation<unknown>(),
  settlements: Annotation<Record<string, SettledResult>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
});
export type HarnessState = typeof stateSchema.State;
export type SettledResult =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; reason: { code: string; message: string } };

function joinMode(node: HarnessPlan["graph"]["nodes"][number] | undefined): string {
  return String(node?.config.mode ?? node?.config.operation ?? "all");
}

export function allSettledInput(plan: HarnessPlan, nodeId: string, state: HarnessState): Record<string, SettledResult> {
  const incoming = plan.graph.edges.filter((edge) => edge.to === nodeId && edge.kind !== "control");
  return Object.fromEntries(incoming.map((edge) => [
    edge.targetPath?.replace(/^\//, "") || edge.from,
    state.settlements[edge.from] ?? { status: "fulfilled", value: getPath(state.values[edge.from], edge.sourcePath) },
  ]));
}

function nodeInput(plan: HarnessPlan, nodeId: string, state: HarnessState): unknown {
  const target = plan.graph.nodes.find((node) => node.id === nodeId);
  const incoming = plan.graph.edges.filter((edge) => edge.to === nodeId && edge.kind !== "control");
  if (!incoming.length) return state.input;
  if (target?.kind === "join" && joinMode(target) === "allSettled") return allSettledInput(plan, nodeId, state);
  if (target && ["agent", "tool", "evaluate"].includes(target.kind)) {
    const root = state.input && typeof state.input === "object"
      ? state.input as Record<string, unknown>
      : { input: state.input };
    return { ...root, evidence: state.values };
  }
  if (incoming.length === 1) {
    const edge = incoming[0]!;
    return getPath(state.values[edge.from], edge.sourcePath);
  }
  return Object.fromEntries(incoming.map((edge) => [
    edge.targetPath?.replace(/^\//, "") || edge.from,
    getPath(state.values[edge.from], edge.sourcePath),
  ]));
}

function routeFor(plan: HarnessPlan, nodeId: string, state: HarnessState): string {
  const edges = plan.graph.edges.filter((edge) => edge.from === nodeId && edge.kind === "control");
  const node = plan.graph.nodes.find((item) => item.id === nodeId);
  const expression = typeof node?.config.expression === "string" ? node.config.expression : undefined;
  const routedValue = expression ? getPath({ ...state, ...state.values }, expression) : undefined;
  return edges.find((edge) => edge.condition === String(routedValue)
    || evaluateCondition(edge.condition, { ...state, ...state.values }))?.to ?? END;
}

export function lowerHarnessPlan(plan: HarnessPlan, context: RuntimeContext, checkpointer?: unknown) {
  if (plan.execution.engine.adapterVersion !== "harness-langgraph-v1") {
    throw new Error("langgraph.adapter_version_unsupported");
  }
  // Plan node identifiers are intentionally dynamic; LangGraph's fluent builder
  // models statically-known string literals, so the adapter owns this cast boundary.
  const graph: any = new StateGraph(stateSchema);
  const nodes = new Map(plan.graph.nodes.map((node) => [node.id, node]));
  const allSettledJoins = new Set(plan.graph.nodes.filter((node) => node.kind === "join" && joinMode(node) === "allSettled").map((node) => node.id));
  const settledSourceIds = new Set(plan.graph.edges.filter((edge) => allSettledJoins.has(edge.to) && edge.kind !== "control").map((edge) => edge.from));
  for (const sourceId of settledSourceIds) {
    const hasMixedFanout = plan.graph.edges.some((edge) => edge.from === sourceId && !allSettledJoins.has(edge.to));
    if (hasMixedFanout) throw new Error(`langgraph.all_settled_mixed_fanout_unsupported:${sourceId}`);
  }

  for (const node of plan.graph.nodes) {
    graph.addNode(node.id, async (state: HarnessState) => {
      try {
        const update = await executeObservedNode(context, node.id, nodeInput(plan, node.id, state), async () => {
          const input = nodeInput(plan, node.id, state);
          let value: unknown;
          if (node.kind === "input") value = state.input;
          else if (node.kind === "output") value = input;
          else if (["agent", "tool", "evaluate"].includes(node.kind)) {
            const enriched = node.prompt
              ? { input, prompt: renderTemplate(node.prompt, { ...state, ...state.values }) }
              : input;
            const result = await invokeCapability(context, node.id, enriched);
            if (result.status !== "succeeded") throw new Error(result.errorCode ?? "runtime.capability_failed");
            value = result.output;
          } else if (node.kind === "transform") value = transformValue(node.config, input);
          else if (node.kind === "aggregator") value = aggregateValue(node.config, input);
          else if (node.kind === "condition") value = input;
          else if (node.kind === "join") value = input;
          else throw new Error(`langgraph.node_kind_unsupported:${node.kind}`);
          await executeCaseWrites(context, node.id, state.input, input, value, state.values);
          return {
            values: { [node.id]: value },
            ...(node.kind === "output" ? { output: value } : {}),
          };
        });
        return settledSourceIds.has(node.id)
          ? { ...update, settlements: { [node.id]: { status: "fulfilled", value: update.values[node.id] } satisfies SettledResult } }
          : update;
      } catch (error) {
        if (!settledSourceIds.has(node.id)) throw error;
        const code = error instanceof Error ? error.message : "runtime.node_failed";
        return { settlements: { [node.id]: { status: "rejected", reason: { code, message: code } } satisfies SettledResult } };
      }
    });
  }

  const incomingCount = new Map(plan.graph.nodes.map((node) => [node.id, 0]));
  for (const edge of plan.graph.edges) incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
  const starts = plan.graph.nodeOrder.filter((id) => incomingCount.get(id) === 0);
  if (starts.length !== 1) throw new Error("langgraph.single_entry_required");
  graph.addEdge(START, starts[0]!);

  const barrierTargets = new Set<string>();
  for (const join of plan.graph.nodes.filter((node) => node.kind === "join")) {
    const sources = plan.graph.edges.filter((edge) => edge.to === join.id && edge.kind !== "control").map((edge) => edge.from);
    if (sources.length > 1) {
      graph.addEdge(sources, join.id);
      barrierTargets.add(join.id);
    }
  }

  for (const node of plan.graph.nodes) {
    const outgoing = plan.graph.edges.filter((edge) => edge.from === node.id);
    const controls = outgoing.filter((edge) => edge.kind === "control");
    if (controls.length) {
      const destinations = Object.fromEntries(controls.map((edge) => [edge.to, edge.to]));
      graph.addConditionalEdges(node.id, (state: HarnessState) => routeFor(plan, node.id, state), destinations);
    } else if (!outgoing.length || node.kind === "output") {
      graph.addEdge(node.id, END);
    } else {
      for (const edge of outgoing) {
        if (!nodes.has(edge.to)) throw new Error(`langgraph.edge_target_missing:${edge.to}`);
        if (barrierTargets.has(edge.to) && edge.kind !== "control") continue;
        graph.addEdge(node.id, edge.to);
      }
    }
  }

  return graph.compile({ ...(checkpointer ? { checkpointer: checkpointer as never } : {}) });
}
