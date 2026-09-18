"use client";

import React, { Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, AlertTriangle, ArrowUpRight, SlidersHorizontal } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { DataTable, Column } from "@/components/data-table";
import {
  CostValue,
  DigestValue,
  DurationValue,
  EmptyState,
  LocalTimestamp,
  RunStatusBadge,
  SkeletonBlock,
  StaleDataBanner,
} from "@/components/primitives";
import { usePolledResource } from "@/lib/use-polled-resource";
import { RunSummary } from "@/lib/types";

function RunsListContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const query = searchParams.get("query") || "";
  const status = searchParams.get("status") || "all";
  const domain = searchParams.get("domain") || "all";
  const modelTier = searchParams.get("modelTier") || "all";
  const windowParam = searchParams.get("window") || "24h";
  const onlyNeedsAttention = searchParams.get("onlyNeedsAttention") === "true";

  const apiUrl = `/v1/runs?query=${encodeURIComponent(query)}&status=${encodeURIComponent(
    status
  )}&domain=${encodeURIComponent(domain)}&modelTier=${encodeURIComponent(
    modelTier
  )}&onlyNeedsAttention=${onlyNeedsAttention}`;

  const {
    data,
    isLoadingInitial,
    isRefreshing,
    hasRefreshError,
    errorMessage,
    lastRefreshedAt,
    refresh,
  } = usePolledResource<{ items: RunSummary[]; generatedAt: string; runtimeMode: "OpenRouter" | "Recorded"; fixture: boolean }>(apiUrl, 5000, true);

  const updateParam = (key: string, val: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (!val || val === "all" || val === "false") params.delete(key);
    else params.set(key, val);
    router.replace(`/runs?${params.toString()}`);
  };

  const items = data?.items || [];

  const columns: Column<RunSummary>[] = [
    {
      id: "runId",
      header: "Run ID",
      primary: true,
      cell: (r) => (
        <div className="min-w-0">
          <Link
            href={`/runs/${r.runId}`}
            onClick={(e) => e.stopPropagation()}
            className="mono inline-flex items-center gap-1 text-xs font-bold text-evergreen hover:underline"
          >
            <span className="truncate">{r.runId}</span>
            <ArrowUpRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          </Link>
          <div className="mono mt-0.5 text-[11px] text-ink-3">
            att:{r.attempt} · epoch:{r.fencingEpoch}
          </div>
        </div>
      ),
    },
    {
      id: "harness",
      header: "Harness & digest",
      cell: (r) => (
        <div className="min-w-0 space-y-1">
          <div className="truncate text-xs font-medium text-ink">{r.harnessName}</div>
          <DigestValue digest={r.planDigest} showCopy={false} />
        </div>
      ),
    },
    {
      id: "status",
      header: "Status / outcome",
      cell: (r) => (
        <div className="flex flex-col items-start gap-1">
          <RunStatusBadge status={r.status} />
          {r.terminalOutcome && (
            <span className="mono text-[11px] text-ink-3">→ {r.terminalOutcome}</span>
          )}
        </div>
      ),
    },
    {
      id: "node",
      header: "Current / terminal node",
      hideBelow: "lg",
      cell: (r) => (
        <span className="mono break-anywhere text-xs text-ink">
          {r.currentNodeId || "—"}
        </span>
      ),
    },
    {
      id: "tier",
      header: "Model tier",
      hideBelow: "xl",
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          {r.modelTiers.length === 0 ? (
            <span className="text-xs text-ink-3">—</span>
          ) : (
            r.modelTiers.map((t) => (
              <span key={t} className="chip chip-ok chip-mono">
                {t}
              </span>
            ))
          )}
        </div>
      ),
    },
    {
      id: "calls",
      header: "Calls",
      hideBelow: "xl",
      cell: (r) => (
        <span className="mono text-xs text-ink">
          {r.modelCalls} model / {r.capabilityCalls} cap
        </span>
      ),
    },
    { id: "cost", header: "Reported cost", cell: (r) => <CostValue cost={r.cost} /> },
    { id: "duration", header: "Duration", cell: (r) => <DurationValue ms={r.durationMs} /> },
    {
      id: "started",
      header: "Started",
      hideBelow: "xl",
      cell: (r) => <LocalTimestamp iso={r.startedAt} compact />,
    },
    { id: "updated", header: "Updated", cell: (r) => <LocalTimestamp iso={r.updatedAt} compact /> },
  ];

  return (
    <AppShell
      title="Runs"
      readiness="Ready"
      runtimeMode={data?.runtimeMode ?? "Recorded"}
      fixture={data?.fixture ?? true}
      lastRefreshedAt={lastRefreshedAt}
      pollIntervalSec={5}
      isRefreshing={isRefreshing}
      hasRefreshError={hasRefreshError}
      compactCounts={`${items.length} matching runs · sorted by most recently updated`}
      onManualRefresh={refresh}
    >
      {hasRefreshError && errorMessage && (
        <StaleDataBanner
          errorMessage={errorMessage}
          lastValidAt={lastRefreshedAt}
          onRetry={refresh}
        />
      )}

      {/* ---------- Filters ---------- */}
      <div className="card mb-5 p-3 sm:p-4">
        <div className="flex items-center gap-2 pb-3 sm:hidden">
          <SlidersHorizontal className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />
          <span className="eyebrow">Filters</span>
        </div>

        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4 xl:flex xl:flex-wrap xl:items-center">
            <div className="relative xl:w-64">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
                aria-hidden="true"
              />
              <input
                type="search"
                aria-label="Search run ID, harness, or plan digest"
                placeholder="Search run ID or digest…"
                value={query}
                onChange={(e) => updateParam("query", e.target.value)}
                className="field mono pl-9"
              />
            </div>

            <select
              aria-label="Filter by status"
              value={status}
              onChange={(e) => updateParam("status", e.target.value)}
              className="field xl:w-44"
            >
              <option value="all">All statuses</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="retrying">Retrying (fenced)</option>
              <option value="completed">Completed</option>
              <option value="manual_review">Manual review</option>
              <option value="denied">Denied</option>
              <option value="failed">Failed</option>
            </select>

            <select
              aria-label="Filter by domain"
              value={domain}
              onChange={(e) => updateParam("domain", e.target.value)}
              className="field xl:w-52"
            >
              <option value="all">All domains</option>
              <option value="financial_operations">financial_operations</option>
              <option value="clinical_utilization">clinical_utilization</option>
              <option value="trade_compliance">trade_compliance</option>
            </select>

            <select
              aria-label="Filter by model tier"
              value={modelTier}
              onChange={(e) => updateParam("modelTier", e.target.value)}
              className="field mono xl:w-48"
            >
              <option value="all">All model tiers</option>
              <option value="tier.reasoning">tier.reasoning</option>
              <option value="tier.clinical_extract">tier.clinical_extract</option>
              <option value="tier.fast">tier.fast</option>
            </select>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 xl:justify-end">
            <label className="btn btn-ghost cursor-pointer">
              <input
                type="checkbox"
                checked={onlyNeedsAttention}
                onChange={(e) =>
                  updateParam("onlyNeedsAttention", e.target.checked ? "true" : "false")
                }
                className="h-3.5 w-3.5 accent-[#1f6b4f]"
              />
              <AlertTriangle className="h-3.5 w-3.5 text-danger" aria-hidden="true" />
              <span>Only needs attention</span>
            </label>

            <div className="seg" role="group" aria-label="Selected time range">
              {["1h", "24h", "7d", "14d"].map((w) => (
                <button
                  key={w}
                  type="button"
                  data-active={windowParam === w}
                  aria-pressed={windowParam === w}
                  onClick={() => updateParam("window", w)}
                  className="seg-item mono"
                >
                  {w}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ---------- Table ---------- */}
      {isLoadingInitial && !data ? (
        <SkeletonBlock className="h-[32rem]" />
      ) : items.length === 0 ? (
        <EmptyState
          title="No execution runs match the selected filters"
          description="Adjust the status, domain, or attention filters, or start a new run from an admitted harness."
          actionLabel="Clear all filters"
          onAction={() => router.replace("/runs")}
        />
      ) : (
        <div className="card card-flush">
          <DataTable
            caption="Execution runs"
            columns={columns}
            rows={items}
            getRowKey={(r) => r.runId}
            onRowClick={(r) => router.push(`/runs/${r.runId}`)}
            expandLabel={(r) => `Show latest events for ${r.runId}`}
            renderExpanded={(r) => (
              <div className="rounded-xl border border-line bg-surface p-3">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="eyebrow">Latest execution events</span>
                  <Link
                    href={`/runs/${r.runId}`}
                    className="text-[11.5px] font-semibold text-evergreen hover:underline"
                  >
                    Open run detail & attempt inspector →
                  </Link>
                </div>
                <ul className="divide-y divide-line">
                  {(r.recentEventsPreview || []).map((ev) => (
                    <li
                      key={ev.sequence}
                      className="flex flex-wrap items-start justify-between gap-2 py-2"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="mono text-[11px] text-ink-3">#{ev.sequence}</span>
                        <span className="chip chip-mono">{ev.code}</span>
                        <span className="text-xs text-ink">{ev.summary}</span>
                      </span>
                      <LocalTimestamp iso={ev.occurredAt} compact />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          />
        </div>
      )}
    </AppShell>
  );
}

export default function RunsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-xs text-ink-2">Loading runs…</div>}>
      <RunsListContent />
    </Suspense>
  );
}
