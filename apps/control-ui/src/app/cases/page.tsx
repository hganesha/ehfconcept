"use client";

import { useState } from "react";
import Link from "next/link";
import { Search, ArrowRight, GitBranch, History, ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { DigestValue, LocalTimestamp, SkeletonBlock, StaleDataBanner } from "@/components/primitives";
import { usePolledResource } from "@/lib/use-polled-resource";
import type { CaseSummaryView } from "@/lib/types";

function statusClass(status: string) {
  if (["APPROVED", "COMPLETED"].includes(status)) return "chip chip-ok";
  if (["REJECTED", "DENIED", "FAILED"].includes(status)) return "chip chip-danger";
  if (["REVIEW", "MANUAL_REVIEW"].includes(status)) return "chip chip-warn";
  return "chip chip-active";
}

export default function CasesPage() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("all");
  const url = `/v1/cases?query=${encodeURIComponent(query)}&status=${encodeURIComponent(status)}`;
  const resource = usePolledResource<{ items: CaseSummaryView[]; generatedAt: string }>(url, 5000, true);
  const items = resource.data?.items ?? [];

  return (
    <AppShell
      title="Cases"
      readiness={resource.hasRefreshError ? "Degraded" : "Ready"}
      runtimeMode="OpenRouter"
      fixture={false}
      lastRefreshedAt={resource.lastRefreshedAt}
      isRefreshing={resource.isRefreshing}
      hasRefreshError={resource.hasRefreshError}
      compactCounts={`${items.length} case${items.length === 1 ? "" : "s"}`}
      onManualRefresh={resource.refresh}
    >
      {resource.hasRefreshError && resource.errorMessage && (
        <StaleDataBanner errorMessage={resource.errorMessage} lastValidAt={resource.lastRefreshedAt} onRetry={resource.refresh} />
      )}

      <section className="card mb-5 p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-sm font-bold text-ink">Canonical business state</h2>
            <p className="mt-1 text-xs text-ink-2">Operational case aggregates, evidence lineage, governed decisions, and immutable activities.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative sm:w-72">
              <span className="sr-only">Search cases</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
              <input className="field pl-9" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Case or external reference…" />
            </label>
            <select className="field sm:w-44" value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter cases by status">
              <option value="all">All statuses</option>
              <option value="INTAKE">Intake</option>
              <option value="SCREENING">Screening</option>
              <option value="REVIEW">Review</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>
        </div>
      </section>

      {resource.isLoadingInitial && !resource.data ? (
        <SkeletonBlock className="h-80" />
      ) : (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {items.map((item) => (
            <Link key={item.caseId} href={`/cases/${encodeURIComponent(item.caseId)}`} className="card card-link group p-5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-bold text-ink group-hover:text-evergreen">{item.externalRef}</h2>
                    <span className={statusClass(item.status)}>{item.status}</span>
                  </div>
                  <p className="mono mt-1 truncate text-[11px] text-ink-3">{item.caseId}</p>
                </div>
                <ArrowRight className="h-4 w-4 text-ink-3 group-hover:text-evergreen" />
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-3 border-y border-line py-3 text-xs sm:grid-cols-4">
                <div><dt className="text-ink-3">Type</dt><dd className="mt-1 font-semibold text-ink">{item.caseType}</dd></div>
                <div><dt className="text-ink-3">Jurisdiction</dt><dd className="mono mt-1 text-ink">{item.jurisdiction}</dd></div>
                <div><dt className="flex items-center gap-1 text-ink-3"><History className="h-3 w-3" />Ledger</dt><dd className="mono mt-1 text-ink">{item.caseSequence} events</dd></div>
                <div><dt className="flex items-center gap-1 text-ink-3"><ShieldCheck className="h-3 w-3" />Class</dt><dd className="mono mt-1 text-ink">{item.classification}</dd></div>
              </dl>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 text-ink-2"><GitBranch className="h-3.5 w-3.5" />Plan <DigestValue digest={item.harnessPlanDigest} showCopy={false} /></span>
                <LocalTimestamp iso={item.updatedAt} />
              </div>
            </Link>
          ))}
        </div>
      )}
    </AppShell>
  );
}
