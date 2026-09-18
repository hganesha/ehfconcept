"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ShieldAlert,
  Boxes,
  Activity,
  DollarSign,
  PlusCircle,
  Clock,
  ArrowUpRight,
} from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { DataTable, Column } from "@/components/data-table";
import {
  CostValue,
  DigestValue,
  DurationValue,
  EmptyState,
  LocalTimestamp,
  MetricCard,
  ReadinessBadge,
  RunStatusBadge,
  SectionCard,
  SkeletonBlock,
  StaleDataBanner,
} from "@/components/primitives";
import { AdmitPlanDrawer } from "@/components/drawers";
import { usePolledResource } from "@/lib/use-polled-resource";
import { ModelTierProfileView, OverviewView, RunSummary } from "@/lib/types";

export default function OverviewPage() {
  const router = useRouter();
  const [admitOpen, setAdmitOpen] = useState(false);

  const {
    data,
    isLoadingInitial,
    isRefreshing,
    hasRefreshError,
    errorMessage,
    lastRefreshedAt,
    refresh,
  } = usePolledResource<OverviewView>("/v1/overview?window=24h", 5000, true);

  const runColumns: Column<RunSummary>[] = [
    {
      id: "runId",
      header: "Run ID",
      primary: true,
      cell: (r) => (
        <div className="min-w-0">
          <Link
            href={`/runs/${r.runId}`}
            onClick={(e) => e.stopPropagation()}
            className="mono inline-flex items-center gap-1 text-xs font-semibold text-evergreen hover:underline"
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
      header: "Harness",
      cell: (r) => (
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-ink">
            {r.harnessName}
          </div>
          <div className="mono text-[11px] text-ink-3">{r.domain}</div>
        </div>
      ),
    },
    {
      id: "node",
      header: "Current node",
      hideBelow: "lg",
      cell: (r) => (
        <span className="mono text-xs text-ink">{r.currentNodeId || "—"}</span>
      ),
    },
    { id: "status", header: "Status", cell: (r) => <RunStatusBadge status={r.status} /> },
    { id: "elapsed", header: "Elapsed", cell: (r) => <DurationValue ms={r.durationMs} /> },
    { id: "cost", header: "Reported cost", cell: (r) => <CostValue cost={r.cost} /> },
    {
      id: "updated",
      header: "Updated",
      hideBelow: "xl",
      cell: (r) => <LocalTimestamp iso={r.updatedAt} compact />,
    },
  ];

  const tierColumns: Column<ModelTierProfileView>[] = [
    {
      id: "tier",
      header: "Model tier",
      primary: true,
      cell: (t) => (
        <div>
          <div className="mono text-xs font-bold text-ink">{t.tierId}</div>
          <div className="mono text-[11px] text-ink-3">{t.version}</div>
        </div>
      ),
    },
    {
      id: "model",
      header: "Resolved OpenRouter model",
      cell: (t) => (
        <span className="mono text-xs font-medium text-evergreen">
          {t.resolvedOpenRouterModel}
        </span>
      ),
    },
    {
      id: "digest",
      header: "Profile digest",
      hideBelow: "xl",
      cell: (t) => <DigestValue digest={t.profileDigest} showCopy={false} />,
    },
    {
      id: "cred",
      header: "Credential",
      cell: (t) => (
        <span className="chip chip-ok">
          <span>{t.credentialState}</span>
        </span>
      ),
    },
    {
      id: "last",
      header: "Last successful invocation",
      cell: (t) => <LocalTimestamp iso={t.lastSuccessAt} />,
    },
  ];

  return (
    <AppShell
      title="Overview"
      readiness={data?.globalReadiness || "Ready"}
      runtimeMode={data?.runtimeMode || "Recorded"}
      fixture={data?.fixture ?? true}
      lastRefreshedAt={lastRefreshedAt}
      pollIntervalSec={5}
      isRefreshing={isRefreshing}
      hasRefreshError={hasRefreshError}
      compactCounts={
        data
          ? `${data.admittedHarnessesCount} admitted · ${data.activeRunsCount} active · ${data.needsAttentionCount} attention`
          : null
      }
      onManualRefresh={refresh}
    >
      {hasRefreshError && errorMessage && (
        <StaleDataBanner
          errorMessage={errorMessage}
          lastValidAt={lastRefreshedAt}
          onRetry={refresh}
        />
      )}

      {isLoadingInitial && !data ? (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <SkeletonBlock key={i} className="h-40" />
            ))}
          </div>
          <SkeletonBlock className="h-32" />
          <SkeletonBlock className="h-80" />
        </div>
      ) : data && data.admittedHarnessesCount === 0 ? (
        <EmptyState
          title="No compiled HarnessPlan admitted locally"
          description="This control surface accepts only compiled HarnessPlan JSON whose SHA-256 digest verifies. It never executes uncompiled source YAML."
          actionLabel="Admit compiled plan"
          onAction={() => setAdmitOpen(true)}
        />
      ) : data ? (
        <div className="space-y-5 sm:space-y-6">
          {/* ---------- Header metrics ---------- */}
          <section
            aria-label="Operational summary metrics"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
          >
            <MetricCard
              label="Admitted harnesses · local"
              href="/harnesses"
              icon={<Boxes className="h-4 w-4 text-evergreen" />}
              value={data.admittedHarnessesCount}
              footnote="immutable content-addressed plan digests"
              linkLabel="Inspect registry"
            />
            <MetricCard
              label="Active runs · queued + running + retrying"
              href="/runs?status=running"
              icon={<Activity className="h-4 w-4 text-active" />}
              value={data.activeRunsCount}
              tone="active"
              footnote={`${data.queuedCount} queued · ${data.runningCount} running · ${data.retryingCount} retrying`}
              linkLabel="View executing"
            />
            <MetricCard
              label="Needs attention · 24h"
              href="/runs?onlyNeedsAttention=true"
              icon={<AlertTriangle className="h-4 w-4 text-danger" />}
              value={data.needsAttentionCount}
              tone="danger"
              footnote={`${data.failedCount} failed · ${data.deniedCount} denied · ${data.staleLeaseCount} stale lease`}
              linkLabel="Triage now"
            />
            <MetricCard
              label="Reported cost · 24h"
              href="/runs"
              icon={<DollarSign className="h-4 w-4 text-evergreen" />}
              valueNode={<CostValue cost={data.reportedCost24h} size="lg" />}
              footnote={
                data.reportedCost24h.complete
                  ? "all provider calls reported usage cost"
                  : "1+ provider call omitted cost — total is partial"
              }
              linkLabel="Cost breakdown"
            />
          </section>

          {/* ---------- Service readiness strip ---------- */}
          <SectionCard
            title="Component readiness"
            description="Computed from live dependency probes — never assumed."
            actions={
              <Link href="/system" className="btn btn-ghost btn-xs">
                Full diagnostics
                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            }
          >
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
              {data.serviceStatus.map((svc) => (
                <li key={svc.id} className="tile flex flex-col justify-between gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-bold text-ink">{svc.name}</span>
                    <ReadinessBadge status={svc.status} />
                  </div>
                  <div className="mono flex items-center justify-between gap-2 text-[11px] text-ink-3">
                    <span className="truncate">{svc.detail}</span>
                    <span className="shrink-0">{svc.latencyMs}ms</span>
                  </div>
                </li>
              ))}
            </ul>
          </SectionCard>

          {/* ---------- Active runs + recent issues ---------- */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-12 xl:gap-6">
            <div className="xl:col-span-7">
              <SectionCard
                flush
                title="Active runs"
                description="Queued, executing, and fenced-retry workflows"
                actions={
                  <>
                    <button
                      type="button"
                      onClick={() => setAdmitOpen(true)}
                      className="btn btn-ghost btn-xs"
                    >
                      <PlusCircle className="h-3.5 w-3.5 text-evergreen" />
                      <span>Admit plan</span>
                    </button>
                    <Link href="/runs" className="btn btn-ghost btn-xs">
                      All runs
                      <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  </>
                }
              >
                <DataTable
                  caption="Runs currently queued, running, or retrying"
                  columns={runColumns}
                  rows={data.activeRuns}
                  getRowKey={(r) => r.runId}
                  onRowClick={(r) => router.push(`/runs/${r.runId}`)}
                  emptyMessage="No runs are currently queued or executing. Open a harness to start a controlled run."
                />
              </SectionCard>
            </div>

            <div className="xl:col-span-5">
              <SectionCard
                flush
                title="Recent issues"
                description="Denials, invalid output, and fenced lease recovery"
                actions={
                  <Link href="/gateway" className="btn btn-ghost btn-xs">
                    Gateway receipts
                    <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                  </Link>
                }
              >
                <ul className="divide-y divide-line">
                  {data.recentIssues.map((iss) => (
                    <li key={iss.id} className="p-4 sm:p-5">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <span className="inline-flex items-center gap-1.5">
                          {iss.category === "gateway_denial" ? (
                            <ShieldAlert className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
                          ) : iss.category === "stale_fencing_attempt" ? (
                            <Clock className="h-4 w-4 shrink-0 text-warn" aria-hidden="true" />
                          ) : (
                            <AlertTriangle className="h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
                          )}
                          <span className="mono break-anywhere text-[11.5px] font-bold text-danger">
                            {iss.code}
                          </span>
                        </span>
                        <LocalTimestamp iso={iss.occurredAt} compact />
                      </div>

                      <h3 className="mt-1.5 text-xs font-bold text-ink">
                        {iss.title}
                      </h3>
                      <p className="mt-1 text-xs leading-relaxed text-ink-2">
                        {iss.summary}
                      </p>

                      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
                        <span className="mono text-[11px] text-ink-3">
                          node: {iss.nodeId}
                        </span>
                        <Link
                          href={`/runs/${iss.runId}`}
                          className="mono inline-flex items-center gap-1 text-[11.5px] font-semibold text-evergreen hover:underline"
                        >
                          <span>{iss.runId}</span>
                          <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
              </SectionCard>
            </div>
          </div>

          {/* ---------- Model tiers ---------- */}
          <SectionCard
            flush
            title="Model tiers"
            description="Read-only tier bindings from versioned configuration — credential values are never exposed to the browser."
            actions={
              <Link href="/gateway" className="btn btn-ghost btn-xs">
                Capability Gateway
                <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
              </Link>
            }
          >
            <DataTable
              caption="Model tier to provider model resolution"
              columns={tierColumns}
              rows={data.modelTiers}
              getRowKey={(t) => t.tierId}
            />
          </SectionCard>
        </div>
      ) : null}

      <AdmitPlanDrawer
        isOpen={admitOpen}
        onClose={() => setAdmitOpen(false)}
        existingDigests={[]}
        onAdmitted={() => refresh()}
      />
    </AppShell>
  );
}
