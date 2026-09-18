"use client";

import React, { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Play,
  ShieldCheck,
  Cpu,
  Lock,
  Layers,
  GitBranch,
  FileCode,
  Activity,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import {
  CopyButton,
  CostValue,
  DigestValue,
  DownloadButton,
  DurationValue,
  JsonViewer,
  LocalTimestamp,
  PrimitiveBadge,
  RunStatusBadge,
  StaleDataBanner,
} from "@/components/primitives";
import { CategoryGraph } from "@/components/category-graph";
import { StartRunDrawer } from "@/components/drawers";
import { usePolledResource } from "@/lib/use-polled-resource";
import { HarnessDetail, RunSummary } from "@/lib/types";

export default function HarnessDetailPage({
  params,
}: {
  params: Promise<{ planDigest: string }>;
}) {
  const { planDigest } = use(params);
  const router = useRouter();

  const [activeTab, setActiveTab] = useState<
    "graph" | "contract" | "capabilities" | "runs"
  >("graph");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [runDrawerOpen, setRunDrawerOpen] = useState(false);

  const encodedDigest = encodeURIComponent(decodeURIComponent(planDigest));

  const {
    data: detail,
    isLoadingInitial,
    isRefreshing,
    hasRefreshError,
    errorMessage,
    lastRefreshedAt,
    refresh,
  } = usePolledResource<HarnessDetail>(
    `/v1/plans/${encodedDigest}`,
    5000,
    true
  );

  const { data: planRunsData } = usePolledResource<{ items: RunSummary[] }>(
    `/v1/plans/${encodedDigest}/runs`,
    5000,
    true
  );

  const planRuns = planRunsData?.items || [];
  const plan = detail?.plan;
  const activeNodeId = selectedNodeId || plan?.nodes[0]?.id || null;
  const selectedNode =
    plan?.nodes.find((n) => n.id === activeNodeId) || plan?.nodes[0] || null;
  const graphCategory = (primitive: string) => ({
    input: "Input",
    transform: "Orchestration",
    join: "Orchestration",
    model: "Intelligence",
    tool: "Capabilities",
    evaluate: "Policy gates",
    output: "Output",
  })[primitive] ?? "Orchestration";
  const graphCategories = ["Input", "Orchestration", "Intelligence", "Capabilities", "Policy gates", "Output"]
    .filter((category) => plan?.nodes.some((node) => graphCategory(node.primitive) === category));

  return (
    <AppShell
      title={detail?.name || "Harness Detail"}
      breadcrumb={[
        { label: "Harnesses", href: "/harnesses" },
        {
          label: detail
            ? `v${detail.packageVersion}`
            : decodeURIComponent(planDigest).slice(0, 16),
        },
      ]}
      readiness="Ready"
      runtimeMode={detail?.fixture === false ? "OpenRouter" : "Recorded"}
      fixture={detail?.fixture ?? true}
      lastRefreshedAt={lastRefreshedAt}
      pollIntervalSec={5}
      isRefreshing={isRefreshing}
      hasRefreshError={hasRefreshError}
      onManualRefresh={refresh}
    >
      {hasRefreshError && errorMessage && (
        <StaleDataBanner
          errorMessage={errorMessage}
          lastValidAt={lastRefreshedAt}
          onRetry={refresh}
        />
      )}

      {isLoadingInitial && !detail ? (
        <div className="space-y-4 animate-pulse">
          <div className="h-32 rounded-lg border border-[#DCE4D8] bg-white" />
          <div className="h-96 rounded-lg border border-[#DCE4D8] bg-white" />
        </div>
      ) : !detail || !plan ? (
        <div className="rounded-lg border border-[#DCE4D8] bg-white p-8 text-center">
          <h2 className="text-sm font-semibold text-[#26312B]">
            Plan digest not found in local admission store
          </h2>
          <Link
            href="/harnesses"
            className="mt-3 inline-block text-xs font-medium text-[#287A5B] hover:underline"
          >
            ← Back to admitted harnesses
          </Link>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Header Card */}
          <section className="card space-y-4 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold text-[#26312B]">
                    {detail.name}
                  </h2>
                  <span className="rounded bg-[#F7F8F4] px-2 py-0.5 font-mono-code text-xs font-semibold text-[#26312B] border border-[#DCE4D8]">
                    v{detail.packageVersion}
                  </span>
                  <span className="rounded bg-[#F7F8F4] px-2 py-0.5 font-mono-code text-xs text-[#536059] border border-[#DCE4D8]">
                    {detail.domain}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded bg-[#EDF5EF] px-2.5 py-0.5 text-xs font-medium text-[#1E5E45] border border-[#B8D8C5]">
                    <ShieldCheck className="h-3.5 w-3.5" />
                    <span>Admitted locally</span>
                  </span>
                  <span className="rounded bg-[#F7F8F4] px-2 py-0.5 font-mono-code text-xs text-[#536059] border border-[#DCE4D8]">
                    {detail.compilerVersion}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-[#536059]">
                    Immutable Plan Digest:
                  </span>
                  <DigestValue digest={detail.planDigest} full showCopy={false} />
                </div>

                <p className="text-xs text-[#536059] max-w-4xl leading-relaxed">
                  {detail.objective}
                </p>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap items-center gap-2">
                <CopyButton value={detail.planDigest} label="Copy digest" />
                <DownloadButton
                  filename={`${detail.domain}-${detail.packageVersion}.compiled.json`}
                  data={plan}
                  label="Download plan"
                />
                <button
                  type="button"
                  onClick={() => setRunDrawerOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-md bg-[#287A5B] px-4 py-2 text-xs font-semibold text-white hover:bg-[#1E5E45] transition-colors"
                >
                  <Play className="h-3.5 w-3.5" />
                  <span>Run harness</span>
                </button>
              </div>
            </div>

            {/* Summary Strip */}
            <div className="grid grid-cols-2 gap-4 border-t border-line pt-4 text-xs lg:grid-cols-5">
              <div>
                <span className="text-[#536059] block">Runs · 14d</span>
                <span className="font-mono-code text-sm font-semibold text-[#26312B]">
                  {detail.runs} total
                </span>
              </div>
              <div>
                <span className="text-[#536059] block">
                  Completion rate (completed / total)
                </span>
                <span className="font-mono-code text-sm font-semibold text-[#26312B]">
                  {detail.completionRatePct !== null
                    ? `${detail.completionRatePct}% (${detail.completedRuns} / ${detail.runs})`
                    : `0 / ${detail.runs}`}
                </span>
              </div>
              <div>
                <span className="text-[#536059] block">
                  Reported mean cost
                </span>
                <CostValue cost={detail.meanReportedCost} />
              </div>
              <div>
                <span className="text-[#536059] block">p50 / p95 duration</span>
                <span className="font-mono-code text-xs text-[#26312B]">
                  <DurationValue ms={detail.p50DurationMs} /> /{" "}
                  <DurationValue ms={detail.p95DurationMs} />
                </span>
              </div>
              <div>
                <span className="text-[#536059] block">Last run</span>
                <LocalTimestamp iso={detail.lastRunAt} />
              </div>
            </div>
          </section>

          {/* Tabs Navigation */}
          <div
            role="tablist"
            aria-label="Harness contract inspection tabs"
            className="scroll-x flex items-center gap-1 border-b border-line"
          >
            {[
              { id: "graph", label: "Graph & Node Inspector", icon: GitBranch },
              { id: "contract", label: "Contract & Budgets", icon: FileCode },
              {
                id: "capabilities",
                label: `Capabilities (${plan.nodes.length} bindings)`,
                icon: Lock,
              },
              {
                id: "runs",
                label: `Runs (${planRuns.length})`,
                icon: Activity,
              },
            ].map((tab) => {
              const Icon = tab.icon;
              const isSelected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={isSelected}
                  type="button"
                  onClick={() =>
                    setActiveTab(
                      tab.id as "graph" | "contract" | "capabilities" | "runs"
                    )
                  }
                  className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-xs font-semibold transition-colors sm:px-4 ${
                    isSelected
                      ? "border-evergreen text-evergreen"
                      : "border-transparent text-ink-2 hover:text-ink"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>

          {/* Tab 1: Graph + Node Inspector */}
          {activeTab === "graph" && (
            <div className="space-y-6">
              <CategoryGraph
                nodes={plan.nodes.map((node) => ({
                  id: node.id,
                  label: node.name,
                  subtitle: node.modelTier || node.capabilityId || node.primitive,
                  category: graphCategory(node.primitive),
                  status: node.effectClass === "none" ? node.primitive : node.effectClass,
                  data: node as unknown as Record<string, unknown>,
                }))}
                edges={plan.edges.map((edge) => ({
                  id: edge.id,
                  from: edge.from,
                  to: edge.to,
                  label: edge.conditionLabel || edge.mappingSummary,
                }))}
                categories={graphCategories}
                selectedNodeId={activeNodeId}
                onSelectNode={(id) => setSelectedNodeId(id)}
                title="Compiled execution DAG"
              />

              {/* Node Inspector */}
              {selectedNode && (
                <section
                  aria-label="Selected node inspector"
                  className="rounded-lg border border-[#DCE4D8] bg-white p-5 space-y-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#DCE4D8] pb-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs font-semibold uppercase tracking-wider text-[#536059]">
                        Node Inspector:
                      </span>
                      <h3 className="text-sm font-bold text-[#26312B]">
                        {selectedNode.name}
                      </h3>
                      <span className="font-mono-code text-xs text-[#536059]">
                        ({selectedNode.id})
                      </span>
                      <PrimitiveBadge primitive={selectedNode.primitive} />
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-[#536059]">
                        Permission-Envelope Digest:
                      </span>
                      <DigestValue
                        digest={selectedNode.permissionEnvelopeDigest}
                      />
                    </div>
                  </div>

                  <p className="text-xs text-[#26312B] bg-[#F7F8F4] p-3 rounded border border-[#DCE4D8]">
                    <strong>Purpose / Compiled Prompt Summary:</strong>{" "}
                    {selectedNode.purpose}
                  </p>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4 text-xs">
                    <div className="rounded border border-[#DCE4D8] p-3">
                      <span className="text-[#536059] block">
                        Resolved Tier / Tool Binding
                      </span>
                      <span className="font-mono-code font-semibold text-[#26312B] mt-1 block">
                        {selectedNode.modelTier ||
                          selectedNode.capabilityId ||
                          "Deterministic Runtime Intrinsic"}
                      </span>
                      {selectedNode.modelTier && (
                        <span className="text-[11px] font-mono-code text-[#1E5E45] block mt-0.5">
                          → resolved by the Capability Gateway profile manifest
                        </span>
                      )}
                    </div>

                    <div className="rounded border border-[#DCE4D8] p-3">
                      <span className="text-[#536059] block">
                        Effect Class & Allowed Effects
                      </span>
                      <span className="font-mono-code font-semibold text-[#26312B] mt-1 block uppercase">
                        {selectedNode.effectClass}
                      </span>
                      <span className="font-mono-code text-[11px] text-[#536059] block mt-0.5">
                        {selectedNode.allowedEffects.join(", ") || "pure / none"}
                      </span>
                    </div>

                    <div className="rounded border border-[#DCE4D8] p-3">
                      <span className="text-[#536059] block">Node Budgets</span>
                      <span className="font-mono-code font-semibold text-[#26312B] mt-1 block">
                        timeout: {selectedNode.timeoutMs}ms · retries:{" "}
                        {selectedNode.maxRetries}
                      </span>
                      <span className="font-mono-code text-[11px] text-[#536059] block mt-0.5">
                        max cost ceiling: ${selectedNode.maxCostUsd.toFixed(4)}
                      </span>
                    </div>

                    <div className="rounded border border-[#DCE4D8] p-3">
                      <span className="text-[#536059] block">
                        Upstream / Downstream Edges
                      </span>
                      <span className="font-mono-code text-[11px] text-[#26312B] mt-1 block">
                        In:{" "}
                        {plan.edges
                          .filter((e) => e.to === selectedNode.id)
                          .map((e) => e.from)
                          .join(", ") || "(root)"}
                      </span>
                      <span className="font-mono-code text-[11px] text-[#26312B] block mt-0.5">
                        Out:{" "}
                        {plan.edges
                          .filter((e) => e.from === selectedNode.id)
                          .map((e) => e.to)
                          .join(", ") || "(terminal)"}
                      </span>
                    </div>
                  </div>

                  {selectedNode.caseWrites.length > 0 && (
                    <JsonViewer
                      data={selectedNode.caseWrites}
                      label={`Canonical case writes (${selectedNode.caseWrites.length})`}
                    />
                  )}

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <JsonViewer
                      data={selectedNode.inputSchema}
                      label={`Accepted Input Schema (${selectedNode.id})`}
                      maxHeight="max-h-48"
                    />
                    <JsonViewer
                      data={selectedNode.outputSchema}
                      label={`Accepted Output Schema (${selectedNode.id})`}
                      maxHeight="max-h-48"
                    />
                  </div>
                </section>
              )}
            </div>
          )}

          {/* Tab 2: Contract */}
          {activeTab === "contract" && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <JsonViewer
                  data={plan.inputSchema}
                  label="Plan Input JSON Schema Contract"
                />
                <JsonViewer
                  data={plan.outputSchema}
                  label="Plan Output JSON Schema Contract"
                />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {/* Terminal Outcomes */}
                <div className="rounded-lg border border-[#DCE4D8] bg-white p-4 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[#536059]">
                    Terminal Outcomes (Single-Run Dispositions)
                  </h3>
                  <div className="space-y-2.5">
                    {plan.terminalOutcomes.map((o) => (
                      <div
                        key={o.code}
                        className="rounded border border-[#DCE4D8] bg-[#F7F8F4] p-3 text-xs"
                      >
                        <div className="font-mono-code font-semibold text-[#26312B]">
                          {o.code}
                        </div>
                        <div className="text-[#536059] mt-0.5">
                          {o.description}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Failure Policy & Budgets */}
                <div className="rounded-lg border border-[#DCE4D8] bg-white p-4 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[#536059]">
                    Compiled Budgets & Failure Policy
                  </h3>
                  <dl className="grid grid-cols-2 gap-2.5 text-xs">
                    <div className="rounded border border-[#DCE4D8] bg-[#F7F8F4] p-2.5">
                      <dt className="text-[#536059]">Max Duration</dt>
                      <dd className="font-mono-code font-semibold text-[#26312B]">
                        {plan.budgets.maxDurationMs} ms
                      </dd>
                    </div>
                    <div className="rounded border border-[#DCE4D8] bg-[#F7F8F4] p-2.5">
                      <dt className="text-[#536059]">Max Cost Budget</dt>
                      <dd className="font-mono-code font-semibold text-[#26312B]">
                        ${plan.budgets.maxCostUsd.toFixed(4)}
                      </dd>
                    </div>
                    <div className="rounded border border-[#DCE4D8] bg-[#F7F8F4] p-2.5">
                      <dt className="text-[#536059]">Model / Cap Calls</dt>
                      <dd className="font-mono-code font-semibold text-[#26312B]">
                        {plan.budgets.maxModelCalls} /{" "}
                        {plan.budgets.maxCapabilityCalls}
                      </dd>
                    </div>
                    <div className="rounded border border-[#DCE4D8] bg-[#F7F8F4] p-2.5">
                      <dt className="text-[#536059]">Retries / Concurrency</dt>
                      <dd className="font-mono-code font-semibold text-[#26312B]">
                        {plan.budgets.maxRetries} /{" "}
                        {plan.budgets.maxConcurrency}
                      </dd>
                    </div>
                  </dl>
                  <div className="rounded border border-[#DCE4D8] bg-[#F7F8F4] p-3 text-xs font-mono-code space-y-1">
                    <div>action: {plan.failurePolicy.defaultAction}</div>
                    <div>backoff: {plan.failurePolicy.retryBackoff}</div>
                    <div>fencing: {plan.failurePolicy.fencingMode}</div>
                  </div>
                </div>

                {/* Dependency Closure with Digests */}
                <div className="rounded-lg border border-[#DCE4D8] bg-white p-4 space-y-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-[#536059]">
                    Dependency Closure ({plan.dependencies.length} Immutable
                    Packages)
                  </h3>
                  <div className="space-y-2.5">
                    {plan.dependencies.map((dep) => (
                      <div
                        key={dep.packageId}
                        className="rounded border border-[#DCE4D8] bg-[#F7F8F4] p-3 text-xs space-y-1"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-mono-code font-semibold text-[#26312B]">
                            {dep.packageId}@{dep.version}
                          </span>
                          <span className="rounded bg-white px-1.5 py-0.5 font-mono-code text-[10px] uppercase border border-[#DCE4D8]">
                            {dep.kind}
                          </span>
                        </div>
                        <DigestValue digest={dep.digest} />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Tab 3: Capabilities Matrix */}
          {activeTab === "capabilities" && (
            <div className="rounded-lg border border-[#DCE4D8] bg-white overflow-hidden">
              <div className="border-b border-[#DCE4D8] bg-[#F7F8F4] px-4 py-3">
                <h3 className="text-sm font-semibold text-[#26312B]">
                  Node-to-Capability & Permission Envelope Matrix
                </h3>
                <p className="text-xs text-[#536059]">
                  Compiled capability bindings, effect scopes, and cryptographic
                  permission-envelope digests
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-[#DCE4D8] text-[#536059]">
                      <th className="py-2.5 px-4">Node</th>
                      <th className="py-2.5 px-3">Primitive</th>
                      <th className="py-2.5 px-3">Model Tier / Tool Binding</th>
                      <th className="py-2.5 px-3">Effect Class</th>
                      <th className="py-2.5 px-3">Timeout / Retries</th>
                      <th className="py-2.5 px-4">Permission-Envelope Digest</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#DCE4D8]">
                    {plan.nodes.map((n) => (
                      <tr key={n.id} className="hover:bg-[#F7F8F4]">
                        <td className="py-2.5 px-4">
                          <div className="font-semibold text-[#26312B]">
                            {n.name}
                          </div>
                          <div className="font-mono-code text-[11px] text-[#536059]">
                            {n.id}
                          </div>
                        </td>
                        <td className="py-2.5 px-3">
                          <PrimitiveBadge primitive={n.primitive} />
                        </td>
                        <td className="py-2.5 px-3 font-mono-code font-medium text-[#1E5E45]">
                          {n.modelTier || n.capabilityId || "runtime.intrinsic"}
                        </td>
                        <td className="py-2.5 px-3 font-mono-code uppercase">
                          {n.effectClass}
                        </td>
                        <td className="py-2.5 px-3 font-mono-code">
                          {n.timeoutMs}ms · {n.maxRetries} retries
                        </td>
                        <td className="py-2.5 px-4">
                          <DigestValue digest={n.permissionEnvelopeDigest} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Tab 4: Runs for this Plan */}
          {activeTab === "runs" && (
            <div className="rounded-lg border border-[#DCE4D8] bg-white overflow-hidden">
              <div className="flex items-center justify-between border-b border-[#DCE4D8] bg-[#F7F8F4] px-4 py-3">
                <h3 className="text-sm font-semibold text-[#26312B]">
                  Execution Runs for {detail.name}
                </h3>
                <button
                  type="button"
                  onClick={() => setRunDrawerOpen(true)}
                  className="inline-flex items-center gap-1 rounded bg-[#287A5B] px-3 py-1 text-xs font-semibold text-white"
                >
                  <Play className="h-3 w-3" />
                  <span>Start new run</span>
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="border-b border-[#DCE4D8] text-[#536059]">
                      <th className="py-2.5 px-4">Run ID</th>
                      <th className="py-2.5 px-3">Status / Outcome</th>
                      <th className="py-2.5 px-3">Current / Terminal Node</th>
                      <th className="py-2.5 px-3">Attempt / Epoch</th>
                      <th className="py-2.5 px-3">Reported Cost</th>
                      <th className="py-2.5 px-3">Duration</th>
                      <th className="py-2.5 px-4">Updated</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#DCE4D8]">
                    {planRuns.map((r) => (
                      <tr
                        key={r.runId}
                        onClick={() => router.push(`/runs/${r.runId}`)}
                        className="cursor-pointer hover:bg-[#F7F8F4]"
                      >
                        <td className="py-2.5 px-4 font-mono-code font-semibold text-[#287A5B]">
                          {r.runId}
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-2">
                            <RunStatusBadge status={r.status} />
                            {r.terminalOutcome && (
                              <span className="font-mono-code text-[11px] text-[#536059]">
                                {r.terminalOutcome}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 font-mono-code">
                          {r.currentNodeId || "—"}
                        </td>
                        <td className="py-2.5 px-3 font-mono-code">
                          att:{r.attempt} · epoch:{r.fencingEpoch}
                        </td>
                        <td className="py-2.5 px-3">
                          <CostValue cost={r.cost} />
                        </td>
                        <td className="py-2.5 px-3">
                          <DurationValue ms={r.durationMs} />
                        </td>
                        <td className="py-2.5 px-4">
                          <LocalTimestamp iso={r.updatedAt} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      <StartRunDrawer
        isOpen={runDrawerOpen}
        onClose={() => setRunDrawerOpen(false)}
        plan={plan || null}
        onRunStarted={(runId) => router.push(`/runs/${runId}`)}
      />
    </AppShell>
  );
}
