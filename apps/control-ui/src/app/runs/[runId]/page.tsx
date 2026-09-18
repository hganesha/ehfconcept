"use client";

import React, { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  RotateCcw,
  ShieldAlert,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronRight,
  Filter,
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
  SkeletonBlock,
  StaleDataBanner,
} from "@/components/primitives";
import { WorkflowGraph } from "@/components/workflow-graph";
import { StartRunDrawer } from "@/components/drawers";
import { usePolledResource } from "@/lib/use-polled-resource";
import { RunDetail } from "@/lib/types";

const INSPECTOR_TABS = [
  { id: "summary", label: "Summary" },
  { id: "input", label: "Input" },
  { id: "output", label: "Output" },
  { id: "authority", label: "Authority" },
  { id: "usage", label: "Usage" },
  { id: "capabilities", label: "Capability calls" },
] as const;

type InspectorTab = (typeof INSPECTOR_TABS)[number]["id"];

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
        {label}
      </dt>
      <dd className="mt-1 min-w-0">{children}</dd>
    </div>
  );
}

export default function RunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = use(params);
  const router = useRouter();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("summary");
  const [filterTimelineByNode, setFilterTimelineByNode] = useState(false);
  const [expandedEvents, setExpandedEvents] = useState<Record<number, boolean>>({});
  const [repeatDrawerOpen, setRepeatDrawerOpen] = useState(false);

  const {
    data: detail,
    isLoadingInitial,
    isRefreshing,
    hasRefreshError,
    errorMessage,
    lastRefreshedAt,
    refresh,
  } = usePolledResource<RunDetail>(`/v1/runs/${encodeURIComponent(runId)}`, 2000, true);

  const isActive =
    detail?.status === "queued" ||
    detail?.status === "running" ||
    detail?.status === "retrying";

  const activeNodeId =
    selectedNodeId ||
    detail?.failureInfo?.failingNodeId ||
    detail?.currentNodeId ||
    detail?.plan.nodes[0]?.id ||
    null;

  const attempt = detail && activeNodeId ? detail.nodeAttempts[activeNodeId] : null;

  const timelineEvents = detail
    ? filterTimelineByNode && activeNodeId
      ? detail.events.filter((e) => e.nodeId === activeNodeId)
      : detail.events
    : [];

  return (
    <AppShell
      title={detail ? detail.runId : runId}
      breadcrumb={[
        { label: "Runs", href: "/runs" },
        { label: detail?.harnessName || "Run detail" },
      ]}
      readiness="Ready"
      runtimeMode={detail?.fixture === false ? "OpenRouter" : "Recorded"}
      fixture={detail?.fixture ?? true}
      lastRefreshedAt={lastRefreshedAt}
      pollIntervalSec={isActive ? 2 : 5}
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
        <div className="space-y-5">
          <SkeletonBlock className="h-48" />
          <SkeletonBlock className="h-72" />
          <SkeletonBlock className="h-96" />
        </div>
      ) : !detail ? (
        <div className="card p-8 text-center">
          <h2 className="text-sm font-bold text-ink">
            Execution record {runId} not found
          </h2>
          <Link href="/runs" className="btn btn-ghost mt-4 inline-flex">
            Back to runs
          </Link>
        </div>
      ) : (
        <div className="space-y-5 sm:space-y-6">
          {/* ---------- Header ---------- */}
          <section className="card p-4 sm:p-5" aria-label="Run authority and status">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="min-w-0 space-y-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="mono break-anywhere text-base font-bold text-ink sm:text-lg">
                    {detail.runId}
                  </h2>
                  <CopyButton value={detail.runId} label="Copy run ID" compact />
                  <RunStatusBadge status={detail.status} />
                  {detail.terminalOutcome && (
                    <span className="chip chip-ok chip-mono">
                      outcome: {detail.terminalOutcome}
                    </span>
                  )}
                  <span className="chip chip-warn chip-mono">
                    {detail.fixture ? "Recorded fixture" : "OpenRouter live"}
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-2">
                  <Link
                    href={`/harnesses/${encodeURIComponent(detail.planDigest)}`}
                    className="font-semibold text-evergreen hover:underline"
                  >
                    {detail.harnessName} (v{detail.packageVersion})
                  </Link>
                  <DigestValue digest={detail.planDigest} />
                  <span className="mono chip">
                    attempt {detail.attempt} · fencing epoch {detail.fencingEpoch}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 lg:shrink-0">
                <DownloadButton
                  filename={`${detail.runId}-execution-record.json`}
                  data={detail}
                  label="Download record"
                />
                <button
                  type="button"
                  onClick={() => setRepeatDrawerOpen(true)}
                  className="btn btn-primary"
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Repeat as new run</span>
                </button>
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4 lg:grid-cols-5">
              <Stat label="Started → updated">
                <span className="flex flex-wrap items-center gap-1.5">
                  <LocalTimestamp iso={detail.startedAt} compact />
                  <span aria-hidden="true" className="text-ink-3">
                    →
                  </span>
                  <LocalTimestamp iso={detail.updatedAt} compact />
                </span>
              </Stat>
              <Stat label="Elapsed">
                <DurationValue ms={detail.durationMs} />
              </Stat>
              <Stat label="Reported cost">
                <CostValue cost={detail.cost} />
              </Stat>
              <Stat label="Model / capability calls">
                <span className="mono text-xs font-semibold text-ink">
                  {detail.modelCalls} model · {detail.capabilityCalls} capability
                </span>
              </Stat>
              <Stat label="Idempotency key">
                <span className="mono break-anywhere text-xs text-ink">
                  {detail.idempotencyKey}
                </span>
              </Stat>
            </dl>
            <div className="mt-4 flex flex-col gap-2 rounded-lg border border-line bg-surface-2 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <span className="eyebrow">OpenTelemetry execution trace</span>
                {detail.traceId ? (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <span className="mono break-anywhere text-xs font-semibold text-ink">{detail.traceId}</span>
                    <CopyButton value={detail.traceId} label="Copy trace ID" compact />
                    {detail.rootSpanId && <span className="mono chip">root {detail.rootSpanId}</span>}
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-ink-2">Trace context has not been bound yet. Active runs bind it when the worker claims execution.</p>
                )}
              </div>
              {detail.traceId && (
                <Link href={`/traces/${encodeURIComponent(detail.traceId)}`} className="btn btn-ghost shrink-0">
                  <Activity className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Open native trace</span>
                </Link>
              )}
            </div>
          </section>

          {/* ---------- Failure banner ---------- */}
          {detail.failureInfo && (
            <section
              role="alert"
              aria-label="Failure diagnostic"
              className="rounded-xl border border-[#e7b9b1] bg-danger-soft p-4 sm:p-5"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 items-start gap-2.5">
                  <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger" aria-hidden="true" />
                  <div className="min-w-0">
                    <span className="mono break-anywhere inline-block rounded-md bg-danger px-2 py-0.5 text-[11.5px] font-bold text-white">
                      {detail.failureInfo.errorCode}
                    </span>
                    <h3 className="mt-1.5 text-sm font-bold text-ink">
                      {detail.failureInfo.title}
                    </h3>
                  </div>
                </div>
                <span className="mono shrink-0 text-[11px] text-danger">
                  {detail.failureInfo.failingNodeId} · attempt{" "}
                  {detail.failureInfo.attempt} · epoch {detail.failureInfo.fencingEpoch}
                </span>
              </div>

              <p className="mt-3 text-xs leading-relaxed text-ink">
                {detail.failureInfo.explanation}
              </p>

              <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-lg border border-[#e7b9b1] bg-surface p-3">
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                    Retry permitted
                  </dt>
                  <dd className="mono mt-1 text-xs font-semibold text-danger">
                    {detail.failureInfo.retryPermitted
                      ? "Yes — within budget"
                      : "No — halted by policy"}
                  </dd>
                </div>
                <div className="rounded-lg border border-[#e7b9b1] bg-surface p-3">
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                    External effect
                  </dt>
                  <dd className="mono mt-1 text-xs font-semibold text-evergreen">
                    {detail.failureInfo.externalEffectOccurred
                      ? "Possible — inspect receipt"
                      : "None — zero mutation"}
                  </dd>
                </div>
                <div className="rounded-lg border border-[#e7b9b1] bg-surface p-3">
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                    Last checkpoint
                  </dt>
                  <dd className="mono break-anywhere mt-1 text-xs font-semibold text-ink">
                    {detail.failureInfo.lastCommittedCheckpoint}
                  </dd>
                </div>
                <div className="rounded-lg border border-[#e7b9b1] bg-surface p-3">
                  <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                    Suggested action
                  </dt>
                  <dd className="mt-1 text-xs font-medium text-ink">
                    {detail.failureInfo.suggestedOperatorAction}
                  </dd>
                </div>
              </dl>
            </section>
          )}

          {/* ---------- Execution graph ---------- */}
          <WorkflowGraph
            nodes={detail.plan.nodes}
            edges={detail.plan.edges}
            selectedNodeId={activeNodeId}
            onSelectNode={(nodeId) => setSelectedNodeId(nodeId)}
            nodeStates={Object.fromEntries(
              Object.entries(detail.nodeAttempts).map(([k, v]) => [k, v.state])
            )}
          />

          {/* ---------- Inspector + timeline ---------- */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-12 xl:gap-6">
            {/* Attempt inspector */}
            <section
              aria-label="Node attempt inspector"
              className="card card-flush xl:col-span-7"
            >
              <div className="panel-head">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="eyebrow">Attempt inspector</span>
                  {attempt && (
                    <>
                      <span className="text-[13px] font-bold text-ink">
                        {attempt.nodeName}
                      </span>
                      <PrimitiveBadge primitive={attempt.primitive} />
                      <span className="chip chip-mono">
                        att:{attempt.attempt} · epoch:{attempt.fencingEpoch}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div
                role="tablist"
                aria-label="Attempt inspector tabs"
                className="scroll-x flex gap-1 border-b border-line px-2"
              >
                {INSPECTOR_TABS.map((t) => {
                  const selected = inspectorTab === t.id;
                  return (
                    <button
                      key={t.id}
                      role="tab"
                      type="button"
                      aria-selected={selected}
                      onClick={() => setInspectorTab(t.id)}
                      className={`shrink-0 border-b-2 px-3 py-2.5 text-xs font-semibold transition-colors ${
                        selected
                          ? "border-evergreen text-evergreen"
                          : "border-transparent text-ink-2 hover:text-ink"
                      }`}
                    >
                      {t.label}
                      {t.id === "capabilities" && attempt
                        ? ` (${attempt.capabilityCalls.length})`
                        : ""}
                    </button>
                  );
                })}
              </div>

              <div className="p-4 sm:p-5">
                {!attempt ? (
                  <p className="text-xs text-ink-2">
                    Select a node on the execution graph to inspect its attempt evidence.
                  </p>
                ) : inspectorTab === "summary" ? (
                  <div className="space-y-4">
                    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <div className="tile">
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                          Node state
                        </dt>
                        <dd className="mono mt-1 text-xs font-bold uppercase text-ink">
                          {attempt.state}
                        </dd>
                      </div>
                      <div className="tile">
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                          Timing
                        </dt>
                        <dd className="mt-1">
                          <DurationValue ms={attempt.durationMs} />
                        </dd>
                      </div>
                      <div className="tile">
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                          Retry classification
                        </dt>
                        <dd className="mono break-anywhere mt-1 text-xs font-semibold text-ink">
                          {attempt.retryClassification || "none"}
                        </dd>
                      </div>
                      <div className="tile">
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                          Input schema
                        </dt>
                        <dd className="mt-1">
                          <span className="chip chip-ok">
                            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                            <span>Valid</span>
                          </span>
                        </dd>
                      </div>
                      <div className="tile">
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                          Output schema
                        </dt>
                        <dd className="mt-1">
                          {attempt.outputSchemaValid === true ? (
                            <span className="chip chip-ok">
                              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>Valid</span>
                            </span>
                          ) : attempt.outputSchemaValid === false ? (
                            <span className="chip chip-danger">
                              <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>Contract violated</span>
                            </span>
                          ) : (
                            <span className="chip">Pending / not reached</span>
                          )}
                        </dd>
                      </div>
                      <div className="tile">
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                          Attempt / epoch
                        </dt>
                        <dd className="mono mt-1 text-xs font-semibold text-ink">
                          #{attempt.attempt} · epoch {attempt.fencingEpoch}
                        </dd>
                      </div>
                    </dl>

                    {attempt.validationDiagnostics.length > 0 && (
                      <div className="rounded-lg border border-[#e7b9b1] bg-danger-soft p-3">
                        <p className="text-xs font-bold text-danger">
                          Attempt diagnostics
                        </p>
                        <ul className="mono mt-1.5 space-y-1 text-[11.5px] text-danger">
                          {attempt.validationDiagnostics.map((d, i) => (
                            <li key={i} className="break-anywhere">
                              {d}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                ) : inspectorTab === "input" ? (
                  <div className="space-y-2.5">
                    <p className="text-xs text-ink-2">
                      Normalized node input after runtime secret and header redaction.
                    </p>
                    <JsonViewer
                      data={attempt.redactedInput}
                      label={`Redacted input · ${attempt.nodeId}`}
                    />
                  </div>
                ) : inspectorTab === "output" ? (
                  <div className="space-y-3">
                    {attempt.validationDiagnostics.length > 0 && (
                      <div className="mono rounded-lg border border-[#e7b9b1] bg-danger-soft p-3 text-[11.5px] text-danger">
                        {attempt.validationDiagnostics.map((d, i) => (
                          <p key={i} className="break-anywhere">
                            {d}
                          </p>
                        ))}
                      </div>
                    )}
                    <JsonViewer
                      data={
                        attempt.validatedOutput || {
                          status: attempt.state,
                          note: "No schema-validated output committed for this node state.",
                        }
                      }
                      label={`Validated output · ${attempt.nodeId}`}
                    />
                  </div>
                ) : inspectorTab === "authority" ? (
                  <div className="tile space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-bold text-ink">
                        Execution-envelope claims
                      </span>
                      <span className="chip chip-mono">
                        signature & secrets omitted
                      </span>
                    </div>
                    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <Stat label="Plan digest">
                        <DigestValue digest={attempt.authority.planDigest} />
                      </Stat>
                      <Stat label="Permission-envelope digest">
                        <DigestValue digest={attempt.authority.permissionEnvelopeDigest} />
                      </Stat>
                      <Stat label="Envelope ID · audience">
                        <span className="mono break-anywhere text-xs text-ink">
                          {attempt.authority.executionEnvelopeId} ·{" "}
                          {attempt.authority.audience}
                        </span>
                      </Stat>
                      <Stat label="Issued → expires">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <LocalTimestamp iso={attempt.authority.issuedAt} compact />
                          <span aria-hidden="true" className="text-ink-3">
                            →
                          </span>
                          <LocalTimestamp iso={attempt.authority.expiresAt} compact />
                        </span>
                      </Stat>
                      <Stat label="Capability scope">
                        <span className="mono break-anywhere text-xs text-evergreen">
                          {attempt.authority.capabilityScope.join(", ") || "none"}
                        </span>
                      </Stat>
                      <Stat label="Effect scope">
                        <span className="mono break-anywhere text-xs text-ink">
                          {attempt.authority.effectScope.join(", ") || "none"}
                        </span>
                      </Stat>
                    </dl>
                  </div>
                ) : inspectorTab === "usage" ? (
                  attempt.usage ? (
                    <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <div className="tile">
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                          Requested tier
                        </dt>
                        <dd className="mono mt-1 text-xs font-bold text-evergreen">
                          {attempt.usage.requestedTier}
                        </dd>
                      </div>
                      <div className="tile">
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                          Resolved OpenRouter model
                        </dt>
                        <dd className="mono break-anywhere mt-1 text-xs font-bold text-ink">
                          {attempt.usage.resolvedOpenRouterModel}
                        </dd>
                      </div>
                      <div className="tile">
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                          Provider request ID
                        </dt>
                        <dd className="mono break-anywhere mt-1 text-xs text-ink">
                          {attempt.usage.providerRequestId}
                        </dd>
                      </div>
                      <div className="tile">
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                          Tokens (in / out)
                        </dt>
                        <dd className="mono mt-1 text-xs font-semibold text-ink">
                          {attempt.usage.inputTokens} / {attempt.usage.outputTokens}
                        </dd>
                      </div>
                      <div className="tile">
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                          Reported cost
                        </dt>
                        <dd className="mt-1">
                          <CostValue cost={attempt.usage.reportedCost} />
                        </dd>
                      </div>
                      <div className="tile">
                        <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                          Latency · adapter
                        </dt>
                        <dd className="mono mt-1 text-xs font-semibold text-ink">
                          {attempt.usage.latencyMs} ms · {attempt.usage.adapterVersion}
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="text-xs text-ink-2">
                      This {attempt.primitive} node does not invoke a model tier.
                    </p>
                  )
                ) : (
                  <div className="space-y-3">
                    {attempt.capabilityCalls.length === 0 ? (
                      <p className="text-xs text-ink-2">
                        No capability gateway calls recorded for this node.
                      </p>
                    ) : (
                      attempt.capabilityCalls.map((c) => (
                        <div
                          key={c.receiptId}
                          className={`rounded-lg border p-3 ${
                            c.decision === "denied"
                              ? "border-[#e7b9b1] bg-danger-soft"
                              : "border-line bg-surface-2"
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="mono break-anywhere text-xs font-bold text-ink">
                              {c.capabilityId}
                            </span>
                            <span
                              className={
                                c.decision === "denied"
                                  ? "chip chip-danger chip-mono"
                                  : "chip chip-ok chip-mono"
                              }
                            >
                              {c.decision} · {c.reasonCode}
                            </span>
                          </div>
                          <dl className="mono mt-2 grid grid-cols-1 gap-1.5 text-[11px] text-ink-3 sm:grid-cols-2">
                            <div className="break-anywhere">effect: {c.effect}</div>
                            <div className="break-anywhere">receipt: {c.receiptId}</div>
                            <div className="break-anywhere">
                              binding: {c.adapterBindingId || "—"}
                            </div>
                            <div className="break-anywhere">
                              idempotency: {c.idempotencyKey}
                            </div>
                            <div>
                              attempt {c.attempt} · epoch {c.fencingEpoch}
                            </div>
                            <div>
                              {c.latencyMs} ms · {c.resultStatus || "—"}
                            </div>
                          </dl>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </section>

            {/* Timeline */}
            <section
              aria-label="Chronological execution timeline"
              className="card card-flush xl:col-span-5"
            >
              <div className="panel-head">
                <div className="min-w-0">
                  <h2 className="text-[13px] font-bold text-ink">
                    Timeline · {timelineEvents.length} events
                  </h2>
                  <p className="mt-0.5 text-xs text-ink-2">
                    Ordered by sequence, grouped by node attempt
                  </p>
                </div>
                {activeNodeId && (
                  <button
                    type="button"
                    aria-pressed={filterTimelineByNode}
                    onClick={() => setFilterTimelineByNode(!filterTimelineByNode)}
                    className={`btn btn-xs ${
                      filterTimelineByNode ? "chip-ok border" : "btn-ghost"
                    }`}
                  >
                    <Filter className="h-3 w-3" aria-hidden="true" />
                    <span className="max-w-[12rem] truncate">
                      {filterTimelineByNode ? activeNodeId : "Filter by node"}
                    </span>
                  </button>
                )}
              </div>

              <ul className="scroll-y max-h-[36rem] divide-y divide-line">
                {timelineEvents.map((ev) => {
                  const isExp = Boolean(expandedEvents[ev.sequence]);
                  return (
                    <li key={ev.id} className="p-3.5 sm:p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="mono text-[11px] font-bold text-ink-3">
                            #{ev.sequence}
                          </span>
                          <span
                            className={`chip chip-mono break-anywhere ${
                              ev.status === "denied" || ev.status === "failed"
                                ? "chip-danger"
                                : !ev.isKnownCode
                                ? "chip-warn"
                                : ""
                            }`}
                          >
                            {ev.code}
                          </span>
                          {!ev.isKnownCode && (
                            <span className="chip chip-warn">Forward-compatible</span>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {ev.durationMs !== null && (
                            <span className="mono text-[11px] text-ink-3">
                              {ev.durationMs}ms
                            </span>
                          )}
                          <LocalTimestamp iso={ev.occurredAt} compact />
                        </div>
                      </div>

                      <p className="mt-1.5 text-xs font-medium leading-relaxed text-ink">
                        {ev.summary}
                      </p>

                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <span className="mono break-anywhere text-[11px] text-ink-3">
                          {ev.nodeId || "(run-level)"} · att:{ev.attempt} · ep:
                          {ev.fencingEpoch}
                        </span>
                        <button
                          type="button"
                          aria-expanded={isExp}
                          onClick={() =>
                            setExpandedEvents((prev) => ({
                              ...prev,
                              [ev.sequence]: !prev[ev.sequence],
                            }))
                          }
                          className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-evergreen hover:underline"
                        >
                          {isExp ? (
                            <ChevronDown className="h-3 w-3" aria-hidden="true" />
                          ) : (
                            <ChevronRight className="h-3 w-3" aria-hidden="true" />
                          )}
                          <span>{isExp ? "Hide payload" : "Structured values"}</span>
                        </button>
                      </div>

                      {isExp && (
                        <div className="mt-2.5">
                          <JsonViewer
                            data={ev.details}
                            label={`Event #${ev.sequence} · ${ev.code}`}
                            maxHeight="max-h-44"
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          </div>
        </div>
      )}

      <StartRunDrawer
        isOpen={repeatDrawerOpen}
        onClose={() => setRepeatDrawerOpen(false)}
        plan={detail?.plan || null}
        prefillInput={detail?.inputPayload || null}
        onRunStarted={(newRunId) => router.push(`/runs/${newRunId}`)}
      />
    </AppShell>
  );
}
