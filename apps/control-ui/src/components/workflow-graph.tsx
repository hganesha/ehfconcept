"use client";

import React, { useState } from "react";
import {
  NodeExecutionState,
  NodePrimitive,
  PlanEdge,
  PlanNode,
} from "@/lib/types";
import { PrimitiveBadge } from "./primitives";
import {
  CheckCircle2,
  Loader2,
  XCircle,
  ShieldAlert,
  RotateCcw,
  FastForward,
  Clock,
  CircleDot,
} from "lucide-react";

export function WorkflowThumbnail({
  nodes,
  edges,
  harnessName,
}: {
  nodes: { id: string; name: string; primitive: NodePrimitive; x: number; y: number }[];
  edges: { from: string; to: string }[];
  harnessName: string;
}) {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const primitiveSummary = nodes
    .map((n) => `${n.name} (${n.primitive})`)
    .join(" → ");

  return (
    <div
      role="img"
      aria-label={`Workflow graph thumbnail for ${harnessName}: ${nodes.length} nodes and ${edges.length} edges (${primitiveSummary})`}
      className="relative h-24 w-full overflow-hidden rounded-lg border border-line bg-surface-2 px-2 py-1 sm:h-28"
    >
      <svg
        viewBox="0 0 1080 260"
        className="h-full w-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <marker
            id="thumb-arrow"
            markerWidth="7"
            markerHeight="7"
            refX="6"
            refY="3.5"
            orient="auto"
          >
            <polygon points="0 0, 7 3.5, 0 7" fill="#68746D" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const from = nodeMap.get(e.from);
          const to = nodeMap.get(e.to);
          if (!from || !to) return null;
          return (
            <line
              key={i}
              x1={from.x + 65}
              y1={from.y}
              x2={to.x - 65}
              y2={to.y}
              stroke="#8A968E"
              strokeWidth="2.2"
              markerEnd="url(#thumb-arrow)"
            />
          );
        })}
        {nodes.map((n) => {
          const isModel = n.primitive === "model";
          const isTool = n.primitive === "tool";
          const isEval = n.primitive === "evaluate";
          const isOutput = n.primitive === "output";

          return (
            <g key={n.id} transform={`translate(${n.x}, ${n.y})`}>
              {isEval ? (
                <polygon
                  points="0,-28 62,0 0,28 -62,0"
                  fill="#FEF8EC"
                  stroke="#A67C25"
                  strokeWidth="2.5"
                />
              ) : isModel ? (
                <polygon
                  points="-52,-24 52,-24 66,0 52,24 -52,24 -66,0"
                  fill="#EDF5EF"
                  stroke="#287A5B"
                  strokeWidth="2.5"
                />
              ) : (
                <rect
                  x="-60"
                  y="-22"
                  width="120"
                  height="44"
                  rx={isOutput || n.primitive === "input" ? "20" : "6"}
                  fill={isTool ? "#EAF3F8" : isOutput ? "#EDF5EF" : "#FFFFFF"}
                  stroke={
                    isTool
                      ? "#3E88B5"
                      : isOutput
                      ? "#287A5B"
                      : "#68746D"
                  }
                  strokeWidth="2.5"
                />
              )}
              <text
                x="0"
                y="4"
                textAnchor="middle"
                fontSize="12"
                fontWeight="600"
                fill="#26312B"
                fontFamily="ui-monospace, monospace"
              >
                {n.primitive.toUpperCase()}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function GraphLegend({ showExecutionStates = false }: { showExecutionStates?: boolean }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#DCE4D8] bg-[#F7F8F4] px-4 py-2.5 text-xs text-[#536059]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-[#26312B]">Primitives:</span>
        <span className="inline-flex items-center gap-1">
          <span className="font-mono-code font-bold text-[#26312B]">▷/◉</span> Input/Output (pill)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="font-mono-code font-bold text-[#287A5B]">⬡</span> Agent/Model (hexagon)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="font-mono-code font-bold text-[#3E88B5]">▣</span> Tool Capability (box)
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="font-mono-code font-bold text-[#A67C25]">⚖</span> Evaluate Gate (diamond)
        </span>
      </div>
      {showExecutionStates && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold text-[#26312B]">State overlay:</span>
          <span className="inline-flex items-center gap-1 text-[#1E5E45]">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Completed
          </span>
          <span className="inline-flex items-center gap-1 text-[#245E82]">
            <Loader2 className="h-3.5 w-3.5" aria-hidden="true" /> Executing (double border)
          </span>
          <span className="inline-flex items-center gap-1 text-[#8C6416]">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Retrying
          </span>
          <span className="inline-flex items-center gap-1 text-[#983B2E]">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" /> Denied / Failed
          </span>
          <span className="inline-flex items-center gap-1 text-[#536059]">
            <FastForward className="h-3.5 w-3.5" aria-hidden="true" /> Skipped (dashed)
          </span>
        </div>
      )}
    </div>
  );
}

function getStateVisuals(state?: NodeExecutionState) {
  switch (state) {
    case "completed":
    case "terminal":
      return {
        fill: "#EDF5EF",
        stroke: "#287A5B",
        strokeDasharray: undefined,
        badgeText: state === "terminal" ? "TERMINAL" : "COMPLETED",
        symbol: "✓",
      };
    case "executing":
      return {
        fill: "#EAF3F8",
        stroke: "#3E88B5",
        strokeDasharray: undefined,
        badgeText: "EXECUTING",
        symbol: "↻",
      };
    case "retrying":
      return {
        fill: "#FEF8EC",
        stroke: "#A67C25",
        strokeDasharray: "6 3",
        badgeText: "RETRYING",
        symbol: "↺",
      };
    case "denied":
      return {
        fill: "#FDF2F0",
        stroke: "#B55245",
        strokeDasharray: undefined,
        badgeText: "DENIED",
        symbol: "⊘",
      };
    case "failed":
      return {
        fill: "#FDF2F0",
        stroke: "#B55245",
        strokeDasharray: undefined,
        badgeText: "FAILED",
        symbol: "✕",
      };
    case "skipped":
      return {
        fill: "#F2F4F2",
        stroke: "#8A968E",
        strokeDasharray: "4 4",
        badgeText: "SKIPPED",
        symbol: "»",
      };
    case "queued":
      return {
        fill: "#FFFFFF",
        stroke: "#68746D",
        strokeDasharray: "3 3",
        badgeText: "QUEUED",
        symbol: "⋯",
      };
    case "not_reached":
    default:
      return {
        fill: "#FFFFFF",
        stroke: "#DCE4D8",
        strokeDasharray: undefined,
        badgeText: state ? "NOT REACHED" : undefined,
        symbol: "•",
      };
  }
}

export function WorkflowGraph({
  nodes,
  edges,
  selectedNodeId,
  onSelectNode,
  nodeStates,
}: {
  nodes: PlanNode[];
  edges: PlanEdge[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  nodeStates?: Record<string, NodeExecutionState>;
}) {
  const [showTextList, setShowTextList] = useState(false);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div className="card card-flush">
      <div className="panel-head">
        <div className="min-w-0">
          <h2 className="text-[13px] font-bold text-ink">
            Compiled execution DAG
          </h2>
          <p className="mono mt-0.5 text-[11.5px] text-ink-3">
            {nodes.length} nodes · {edges.length} edges · select a node to inspect
            contract &amp; authority
          </p>
        </div>
        <button
          type="button"
          aria-expanded={showTextList}
          onClick={() => setShowTextList(!showTextList)}
          className="btn btn-ghost btn-xs"
        >
          {showTextList ? "Hide node/edge table" : "Show node/edge table"}
        </button>
      </div>

      {/* Interactive SVG Canvas */}
      <div className="scroll-x w-full bg-surface p-3">
        <svg
          viewBox="0 0 1120 270"
          className="h-52 w-full min-w-[760px] sm:h-64 xl:h-72"
          role="group"
          aria-label="Interactive workflow execution graph"
        >
          <defs>
            <marker
              id="dag-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <polygon points="0 0, 8 4, 0 8" fill="#68746D" />
            </marker>
          </defs>

          {/* Edges */}
          {edges.map((edge) => {
            const from = nodeMap.get(edge.from);
            const to = nodeMap.get(edge.to);
            if (!from || !to) return null;
            const midX = (from.x + 78 + (to.x - 78)) / 2;
            const midY = (from.y + to.y) / 2;

            return (
              <g key={edge.id}>
                <path
                  d={`M ${from.x + 76} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${
                    to.x - 78
                  } ${to.y}`}
                  fill="none"
                  stroke="#68746D"
                  strokeWidth="1.8"
                  markerEnd="url(#dag-arrow)"
                />
                {edge.conditionLabel && (
                  <g transform={`translate(${midX}, ${midY - 8})`}>
                    <rect
                      x="-44"
                      y="-10"
                      width="88"
                      height="18"
                      rx="4"
                      fill="#F7F8F4"
                      stroke="#DCE4D8"
                    />
                    <text
                      x="0"
                      y="3"
                      textAnchor="middle"
                      fontSize="10"
                      fill="#536059"
                      fontFamily="ui-monospace, monospace"
                    >
                      {edge.conditionLabel}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Nodes */}
          {nodes.map((node) => {
            const isSelected = selectedNodeId === node.id;
            const state = nodeStates ? nodeStates[node.id] : undefined;
            const vis = getStateVisuals(state);

            const fill = state ? vis.fill : isSelected ? "#EDF5EF" : "#FFFFFF";
            const stroke = isSelected
              ? "#287A5B"
              : state
              ? vis.stroke
              : "#8A968E";

            const isHex = node.primitive === "model";
            const isDiamond = node.primitive === "evaluate";
            const isPill =
              node.primitive === "input" || node.primitive === "output";

            return (
              <g
                key={node.id}
                transform={`translate(${node.x}, ${node.y})`}
                role="button"
                tabIndex={0}
                aria-pressed={isSelected}
                aria-label={`${node.name} (${node.primitive})${
                  state ? `, status: ${state}` : ""
                }`}
                onClick={() => onSelectNode(node.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectNode(node.id);
                  }
                }}
                className="cursor-pointer focus:outline-none"
              >
                {/* Selection / Active outer halo */}
                {(isSelected || state === "executing") && (
                  <rect
                    x="-84"
                    y="-40"
                    width="168"
                    height="80"
                    rx="12"
                    fill="none"
                    stroke={state === "executing" ? "#3E88B5" : "#287A5B"}
                    strokeWidth="2"
                    strokeDasharray={state === "executing" ? "4 2" : undefined}
                  />
                )}

                {isDiamond ? (
                  <polygon
                    points="0,-36 80,0 0,36 -80,0"
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={isSelected ? "2.8" : "2"}
                    strokeDasharray={vis.strokeDasharray}
                  />
                ) : isHex ? (
                  <polygon
                    points="-66,-32 66,-32 78,0 66,32 -66,32 -78,0"
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={isSelected ? "2.8" : "2"}
                    strokeDasharray={vis.strokeDasharray}
                  />
                ) : (
                  <rect
                    x="-76"
                    y="-32"
                    width="152"
                    height="64"
                    rx={isPill ? "28" : "8"}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={isSelected ? "2.8" : "2"}
                    strokeDasharray={vis.strokeDasharray}
                  />
                )}

                {/* Primitive + State top row */}
                <text
                  x="0"
                  y="-11"
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight="700"
                  fill="#536059"
                  fontFamily="ui-monospace, monospace"
                >
                  {vis.badgeText
                    ? `${vis.symbol} ${vis.badgeText}`
                    : node.primitive.toUpperCase()}
                </text>

                {/* Node Name */}
                <text
                  x="0"
                  y="6"
                  textAnchor="middle"
                  fontSize="11.5"
                  fontWeight="600"
                  fill="#26312B"
                >
                  {node.name.length > 21
                    ? `${node.name.slice(0, 20)}…`
                    : node.name}
                </text>

                {/* Tier or Capability binding sub-label */}
                <text
                  x="0"
                  y="21"
                  textAnchor="middle"
                  fontSize="10"
                  fill="#68746D"
                  fontFamily="ui-monospace, monospace"
                >
                  {node.modelTier || node.capabilityId || node.id}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Keyboard & Screen Reader Quick Node Selector Bar */}
      <div className="scroll-x flex items-center gap-1.5 border-t border-line bg-surface px-4 py-2.5 md:flex-wrap">
        <span className="mr-1 shrink-0 text-[11.5px] font-semibold text-ink-2">
          Nodes:
        </span>
        {nodes.map((n) => {
          const isSelected = selectedNodeId === n.id;
          const st = nodeStates?.[n.id];
          return (
            <button
              key={n.id}
              type="button"
              onClick={() => onSelectNode(n.id)}
              className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
                isSelected
                  ? "border-[#bcd9c7] bg-mint text-evergreen"
                  : "border-line bg-surface-2 text-ink hover:bg-mint"
              }`}
            >
              <span className="font-mono-code text-[11px] opacity-80">
                [{n.primitive}]
              </span>
              <span>{n.name}</span>
              {st && (
                <span className="rounded bg-white px-1.5 py-0.2 font-mono-code text-[10px] uppercase border border-[#DCE4D8]">
                  {st}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Accessible Textual Node/Edge Table when toggled */}
      {showTextList && (
        <div className="border-t border-[#DCE4D8] bg-white p-4">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-[#536059] mb-2">
            Textual Graph Topology & Bindings
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[#DCE4D8] text-[#536059]">
                  <th className="py-1.5 pr-3">Node ID</th>
                  <th className="py-1.5 px-3">Name</th>
                  <th className="py-1.5 px-3">Primitive</th>
                  <th className="py-1.5 px-3">Binding</th>
                  <th className="py-1.5 px-3">Downstream Edges</th>
                  {nodeStates && <th className="py-1.5 pl-3">Execution State</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#DCE4D8]">
                {nodes.map((n) => {
                  const down = edges
                    .filter((e) => e.from === n.id)
                    .map((e) => e.to)
                    .join(", ");
                  return (
                    <tr key={n.id}>
                      <td className="py-1.5 pr-3 font-mono-code">{n.id}</td>
                      <td className="py-1.5 px-3 font-medium">{n.name}</td>
                      <td className="py-1.5 px-3">
                        <PrimitiveBadge primitive={n.primitive} />
                      </td>
                      <td className="py-1.5 px-3 font-mono-code">
                        {n.modelTier || n.capabilityId || "—"}
                      </td>
                      <td className="py-1.5 px-3 font-mono-code">
                        {down || "(terminal)"}
                      </td>
                      {nodeStates && (
                        <td className="py-1.5 pl-3 font-mono-code uppercase">
                          {nodeStates[n.id] || "not_reached"}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <GraphLegend showExecutionStates={Boolean(nodeStates)} />
    </div>
  );
}
