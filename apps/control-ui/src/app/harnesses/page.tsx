"use client";

import React, { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, PlusCircle, Play, ShieldCheck, ArrowRight } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import {
  CopyButton,
  CostValue,
  DigestValue,
  DownloadButton,
  DurationValue,
  EmptyState,
  LocalTimestamp,
  SkeletonBlock,
  StaleDataBanner,
} from "@/components/primitives";
import { WorkflowThumbnail } from "@/components/workflow-graph";
import { AdmitPlanDrawer, StartRunDrawer } from "@/components/drawers";
import { usePolledResource } from "@/lib/use-polled-resource";
import { CompiledHarnessPlan, HarnessSummary } from "@/lib/types";

function HarnessesContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const query = searchParams.get("query") || "";
  const domain = searchParams.get("domain") || "all";
  const modelTier = searchParams.get("modelTier") || "all";

  const [admitOpen, setAdmitOpen] = useState(false);
  const [runDrawerPlan, setRunDrawerPlan] = useState<CompiledHarnessPlan | null>(null);

  const apiUrl = `/v1/plans?query=${encodeURIComponent(query)}&domain=${encodeURIComponent(
    domain
  )}&modelTier=${encodeURIComponent(modelTier)}`;

  const {
    data,
    isLoadingInitial,
    isRefreshing,
    hasRefreshError,
    errorMessage,
    lastRefreshedAt,
    refresh,
  } = usePolledResource<{ items: HarnessSummary[]; generatedAt: string; runtimeMode: "OpenRouter" | "Recorded"; fixture: boolean }>(
    apiUrl,
    5000,
    true
  );

  const updateFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (!value || value === "all") params.delete(key);
    else params.set(key, value);
    router.replace(`/harnesses?${params.toString()}`);
  };

  const handleOpenRunDrawer = async (e: React.MouseEvent, planDigest: string) => {
    e.stopPropagation();
    const res = await fetch(`/v1/plans/${encodeURIComponent(planDigest)}`);
    if (res.ok) {
      const detail = await res.json();
      setRunDrawerPlan(detail.plan);
    }
  };

  const items = data?.items || [];

  return (
    <AppShell
      title="Harnesses"
      readiness="Ready"
      runtimeMode={data?.runtimeMode ?? "Recorded"}
      fixture={data?.fixture ?? true}
      lastRefreshedAt={lastRefreshedAt}
      pollIntervalSec={5}
      isRefreshing={isRefreshing}
      hasRefreshError={hasRefreshError}
      compactCounts={`${items.length} admitted ${items.length === 1 ? "plan" : "plans"}`}
      onManualRefresh={refresh}
    >
      {hasRefreshError && errorMessage && (
        <StaleDataBanner
          errorMessage={errorMessage}
          lastValidAt={lastRefreshedAt}
          onRetry={refresh}
        />
      )}

      {/* ---------- Toolbar ---------- */}
      <div className="card mb-5 p-3 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center">
            <div className="relative sm:w-72">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3"
                aria-hidden="true"
              />
              <input
                type="search"
                aria-label="Search by harness name or plan digest"
                placeholder="Search name or sha256 digest…"
                value={query}
                onChange={(e) => updateFilter("query", e.target.value)}
                className="field pl-9"
              />
            </div>

            <select
              aria-label="Filter by domain"
              value={domain}
              onChange={(e) => updateFilter("domain", e.target.value)}
              className="field sm:w-52"
            >
              <option value="all">All domains</option>
              <option value="financial_operations">financial_operations</option>
              <option value="clinical_utilization">clinical_utilization</option>
              <option value="trade_compliance">trade_compliance</option>
            </select>

            <select
              aria-label="Filter by model tier"
              value={modelTier}
              onChange={(e) => updateFilter("modelTier", e.target.value)}
              className="field mono sm:w-52"
            >
              <option value="all">All model tiers</option>
              <option value="tier.reasoning">tier.reasoning</option>
              <option value="tier.clinical_extract">tier.clinical_extract</option>
              <option value="tier.fast">tier.fast</option>
            </select>
          </div>

          <div className="flex items-center justify-between gap-3 lg:justify-end">
            <span className="mono text-[11.5px] font-semibold text-ink-2">
              {items.length} admitted {items.length === 1 ? "plan" : "plans"}
            </span>
            <button
              type="button"
              onClick={() => setAdmitOpen(true)}
              className="btn btn-primary"
            >
              <PlusCircle className="h-4 w-4" aria-hidden="true" />
              <span>Admit plan</span>
            </button>
          </div>
        </div>
      </div>

      {/* ---------- Cards ---------- */}
      {isLoadingInitial && !data ? (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <SkeletonBlock className="h-[26rem]" />
          <SkeletonBlock className="h-[26rem]" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title="No admitted plans match these filters"
          description="Clear the search or domain filter, or admit a compiled HarnessPlan JSON artifact. Rejected plans are never listed as admitted."
          actionLabel="Reset filters"
          onAction={() => router.replace("/harnesses")}
        />
      ) : (
        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          {items.map((h) => {
            const detailHref = `/harnesses/${encodeURIComponent(h.planDigest)}`;
            return (
              <article
                key={h.planDigest}
                onClick={() => router.push(detailHref)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") router.push(detailHref);
                }}
                tabIndex={0}
                role="link"
                aria-label={`${h.name} version ${h.packageVersion}, admitted locally`}
                className="card card-link group flex cursor-pointer flex-col gap-4 p-4 sm:p-5"
              >
                {/* Header */}
                <div className="space-y-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-[15px] font-bold leading-snug text-ink group-hover:text-evergreen">
                          {h.name}
                        </h2>
                        <span className="chip chip-mono">v{h.packageVersion}</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <span className="mono text-[11.5px] text-ink-3">
                          {h.domain}
                        </span>
                        <DigestValue digest={h.planDigest} label="plan digest" />
                      </div>
                    </div>
                    <span className="chip chip-ok shrink-0">
                      <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Admitted locally</span>
                    </span>
                  </div>

                  <p className="line-clamp-2 text-xs leading-relaxed text-ink-2">
                    {h.objective}
                  </p>
                </div>

                <WorkflowThumbnail
                  nodes={h.nodesPreview}
                  edges={h.edgesPreview}
                  harnessName={h.name}
                />

                {/* Topology */}
                <dl className="grid grid-cols-1 gap-3 border-y border-line py-3 sm:grid-cols-3">
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                      Topology
                    </dt>
                    <dd className="mono mt-0.5 text-xs font-semibold text-ink">
                      {h.nodeCount} nodes · {h.edgeCount} edges
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                      Model tiers
                    </dt>
                    <dd className="mt-1 flex flex-wrap gap-1">
                      {h.modelTiers.map((t) => (
                        <span key={t} className="chip chip-ok chip-mono">
                          {t}
                        </span>
                      ))}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                      Capabilities
                    </dt>
                    <dd className="mono mt-0.5 text-xs font-semibold text-ink">
                      {h.capabilityCount} bound · {h.effectfulCapabilityCount} effectful
                    </dd>
                  </div>
                </dl>

                {/* Metrics */}
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                      Completion rate
                    </dt>
                    <dd className="num mt-0.5 text-xs font-semibold text-ink">
                      {h.completionRatePct !== null
                        ? `${h.completionRatePct}% (${h.completedRuns}/${h.runs})`
                        : `— (0/${h.runs})`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                      Mean reported cost
                    </dt>
                    <dd className="mt-0.5">
                      <CostValue cost={h.meanReportedCost} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                      p50 duration
                    </dt>
                    <dd className="mt-0.5">
                      <DurationValue ms={h.p50DurationMs} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                      Last run
                    </dt>
                    <dd className="mt-0.5">
                      <LocalTimestamp iso={h.lastRunAt} compact />
                    </dd>
                  </div>
                </dl>

                {/* Actions */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
                  <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
                    <CopyButton value={h.planDigest} label="Copy digest" compact />
                    <DownloadButton
                      filename={`${h.domain}-${h.packageVersion}.plan.json`}
                      data={h}
                      label="Download plan"
                      compact
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={(e) => handleOpenRunDrawer(e, h.planDigest)}
                      className="btn btn-primary btn-xs"
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      <span>Run harness</span>
                    </button>
                    <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-evergreen group-hover:underline">
                      <span>Inspect</span>
                      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <AdmitPlanDrawer
        isOpen={admitOpen}
        onClose={() => setAdmitOpen(false)}
        existingDigests={items.map((i) => i.planDigest)}
        onAdmitted={() => refresh()}
      />

      <StartRunDrawer
        isOpen={Boolean(runDrawerPlan)}
        onClose={() => setRunDrawerPlan(null)}
        plan={runDrawerPlan}
        onRunStarted={(runId) => router.push(`/runs/${runId}`)}
      />
    </AppShell>
  );
}

export default function HarnessesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-xs text-ink-2">Loading harnesses…</div>}>
      <HarnessesContent />
    </Suspense>
  );
}
