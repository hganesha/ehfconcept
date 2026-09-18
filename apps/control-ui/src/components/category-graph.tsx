"use client";

import { useId, useMemo, useState } from "react";
import { Eye, EyeOff, LocateFixed } from "lucide-react";
import type { ExplorerGraphEdge, ExplorerGraphNode } from "@/lib/types";

const CATEGORY_COLORS = ["#287A5B", "#3E88B5", "#A67C25", "#7C68A6", "#B55245", "#68746D"];
const NODE_WIDTH = 184;
const NODE_HEIGHT = 62;
const COLUMN_GAP = 244;
const ROW_GAP = 82;
const LEFT_GUTTER = 142;
const TOP_GUTTER = 42;

function calculateRanks(nodes: ExplorerGraphNode[], edges: ExplorerGraphEdge[]) {
  const ids = new Set(nodes.map((node) => node.id));
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
      const next = Math.min(nodes.length, (rank.get(edge.from) ?? 0) + 1);
      if (next > (rank.get(edge.to) ?? 0)) {
        rank.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return rank;
}

export function CategoryGraph({
  nodes,
  edges,
  categories,
  selectedNodeId,
  onSelectNode,
  title = "Case aggregate graph",
}: {
  nodes: ExplorerGraphNode[];
  edges: ExplorerGraphEdge[];
  categories: string[];
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  title?: string;
}) {
  const markerId = `arrow-${useId().replaceAll(":", "")}`;
  const [zoom, setZoom] = useState(0.85);
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(new Set());

  const layout = useMemo(() => {
    const visibleNodes = nodes.filter((node) => !hiddenCategories.has(node.category));
    const visibleIds = new Set(visibleNodes.map((node) => node.id));
    const visibleEdges = edges.filter((edge) => visibleIds.has(edge.from) && visibleIds.has(edge.to));
    const ranks = calculateRanks(visibleNodes, visibleEdges);
    const position = new Map<string, { x: number; y: number }>();
    const lanes: Array<{ category: string; y: number; height: number; color: string }> = [];
    let laneY = TOP_GUTTER;
    const categoryIndex = new Map(categories.map((category, index) => [category, index]));

    for (const category of categories.filter((item) => !hiddenCategories.has(item))) {
      const laneNodes = visibleNodes.filter((node) => node.category === category);
      const groups = new Map<number, ExplorerGraphNode[]>();
      for (const node of laneNodes) {
        const nodeRank = ranks.get(node.id) ?? 0;
        groups.set(nodeRank, [...(groups.get(nodeRank) ?? []), node]);
      }
      const maxStack = Math.max(1, ...[...groups.values()].map((group) => group.length));
      const height = maxStack * ROW_GAP + 28;
      const color = CATEGORY_COLORS[(categoryIndex.get(category) ?? 0) % CATEGORY_COLORS.length];
      lanes.push({ category, y: laneY, height, color });
      for (const [nodeRank, group] of groups) {
        group.forEach((node, index) => {
          position.set(node.id, {
            x: LEFT_GUTTER + NODE_WIDTH / 2 + nodeRank * COLUMN_GAP,
            y: laneY + 46 + index * ROW_GAP,
          });
        });
      }
      laneY += height + 10;
    }
    const maxRank = Math.max(0, ...visibleNodes.map((node) => ranks.get(node.id) ?? 0));
    return {
      nodes: visibleNodes,
      edges: visibleEdges,
      position,
      lanes,
      width: Math.max(920, LEFT_GUTTER + NODE_WIDTH + maxRank * COLUMN_GAP + 80),
      height: Math.max(260, laneY + 10),
    };
  }, [categories, edges, hiddenCategories, nodes]);

  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const toggleCategory = (category: string) => {
    setHiddenCategories((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  return (
    <section className="card card-flush" aria-label={title}>
      <div className="panel-head">
        <div>
          <h2 className="text-[13px] font-bold text-ink">{title}</h2>
          <p className="mono mt-0.5 text-[11.5px] text-ink-3">
            {nodes.length} objects · {edges.length} relationships · categorized lineage canvas
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LocateFixed className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />
          <label className="text-[11.5px] font-semibold text-ink-2" htmlFor="graph-zoom">Zoom</label>
          <select
            id="graph-zoom"
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="field w-24 py-1.5"
          >
            <option value={0.65}>65%</option>
            <option value={0.85}>85%</option>
            <option value={1}>100%</option>
            <option value={1.2}>120%</option>
          </select>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-line bg-surface px-4 py-2.5" aria-label="Graph category visibility">
        {categories.map((category, index) => {
          const hidden = hiddenCategories.has(category);
          return (
            <button
              type="button"
              key={category}
              aria-pressed={!hidden}
              onClick={() => toggleCategory(category)}
              className={`btn btn-xs ${hidden ? "btn-ghost opacity-60" : "bg-surface-2 text-ink"}`}
              style={{ borderColor: hidden ? undefined : CATEGORY_COLORS[index % CATEGORY_COLORS.length] }}
            >
              {hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {category} ({nodes.filter((node) => node.category === category).length})
            </button>
          );
        })}
      </div>

      <div className="max-h-[68vh] overflow-auto bg-[#f8faf6]" tabIndex={0} aria-label="Scrollable graph canvas">
        <svg
          width={layout.width * zoom}
          height={layout.height * zoom}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="group"
          aria-label={`${title}: ${layout.nodes.length} visible nodes and ${layout.edges.length} visible edges`}
        >
          <defs>
            <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <polygon points="0 0, 8 4, 0 8" fill="#68746D" />
            </marker>
          </defs>

          {layout.lanes.map((lane) => (
            <g key={lane.category}>
              <rect x="8" y={lane.y} width={layout.width - 16} height={lane.height} rx="10" fill="#FFFFFF" stroke="#E2E8DD" />
              <rect x="8" y={lane.y} width="6" height={lane.height} rx="3" fill={lane.color} />
              <text x="28" y={lane.y + 27} fontSize="11" fontWeight="700" fill={lane.color} letterSpacing="1">
                {lane.category.toUpperCase()}
              </text>
            </g>
          ))}

          {layout.edges.map((edge) => {
            const from = layout.position.get(edge.from);
            const to = layout.position.get(edge.to);
            if (!from || !to) return null;
            const startX = from.x + NODE_WIDTH / 2;
            const endX = to.x - NODE_WIDTH / 2;
            const midX = startX + Math.max(36, (endX - startX) / 2);
            return (
              <g key={edge.id}>
                <path
                  d={`M ${startX} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${endX} ${to.y}`}
                  fill="none"
                  stroke="#7A877F"
                  strokeWidth="1.5"
                  markerEnd={`url(#${markerId})`}
                />
                {Math.abs(to.x - from.x) > 180 && (
                  <text x={(startX + endX) / 2} y={(from.y + to.y) / 2 - 5} textAnchor="middle" fontSize="9" fill="#69756E" fontFamily="ui-monospace, monospace">
                    {edge.label.length > 20 ? `${edge.label.slice(0, 19)}…` : edge.label}
                  </text>
                )}
              </g>
            );
          })}

          {layout.nodes.map((node) => {
            const point = layout.position.get(node.id);
            if (!point) return null;
            const selected = node.id === selectedNodeId;
            const categoryIndex = categories.indexOf(node.category);
            const color = CATEGORY_COLORS[Math.max(0, categoryIndex) % CATEGORY_COLORS.length];
            return (
              <g
                key={node.id}
                transform={`translate(${point.x}, ${point.y})`}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                aria-label={`${node.category}: ${node.label}${node.status ? `, ${node.status}` : ""}`}
                onClick={() => onSelectNode(node.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelectNode(node.id);
                  }
                }}
                className="cursor-pointer focus:outline-none"
              >
                <rect
                  x={-NODE_WIDTH / 2}
                  y={-NODE_HEIGHT / 2}
                  width={NODE_WIDTH}
                  height={NODE_HEIGHT}
                  rx="9"
                  fill={selected ? "#EDF5EF" : "#FFFFFF"}
                  stroke={selected ? "#1F6B4F" : color}
                  strokeWidth={selected ? 3 : 1.7}
                />
                <rect x={-NODE_WIDTH / 2} y={-NODE_HEIGHT / 2} width="6" height={NODE_HEIGHT} rx="3" fill={color} />
                <text x="-78" y="-11" fontSize="9.5" fontWeight="700" fill={color} fontFamily="ui-monospace, monospace">
                  {node.category.toUpperCase()}
                </text>
                <text x="-78" y="6" fontSize="11.5" fontWeight="650" fill="#222D27">
                  {node.label.length > 25 ? `${node.label.slice(0, 24)}…` : node.label}
                </text>
                <text x="-78" y="21" fontSize="9.5" fill="#69756E" fontFamily="ui-monospace, monospace">
                  {(node.status || node.subtitle).slice(0, 29)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div className="border-t border-line bg-surface-2 px-4 py-2 text-[11px] text-ink-3">
        Scroll horizontally and vertically for large graphs. Toggle categories to isolate a lineage path; select any object for its contract data.
        {selectedNodeId && nodeById.has(selectedNodeId) ? ` Selected: ${nodeById.get(selectedNodeId)?.label}.` : ""}
      </div>
    </section>
  );
}
