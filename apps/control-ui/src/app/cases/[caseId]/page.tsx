"use client";

import { use, useState } from "react";
import Link from "next/link";
import { Activity, ExternalLink, FileCheck2, GitBranch, History, ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { CategoryGraph } from "@/components/category-graph";
import { DigestValue, JsonViewer, LocalTimestamp, SkeletonBlock, StaleDataBanner } from "@/components/primitives";
import { usePolledResource } from "@/lib/use-polled-resource";
import type { CaseDetailView } from "@/lib/types";

export default function CaseDetailPage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = use(params);
  const resource = usePolledResource<CaseDetailView>(`/v1/cases/${encodeURIComponent(decodeURIComponent(caseId))}`, 5000, true);
  const detail = resource.data;
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const selectedNode = detail?.graph.nodes.find((node) => node.id === (selectedNodeId ?? detail.graph.nodes[0]?.id)) ?? null;

  return (
    <AppShell
      title={detail?.case.externalRef ?? "Case aggregate"}
      breadcrumb={[{ label: "Cases", href: "/cases" }, { label: detail?.case.status ?? decodeURIComponent(caseId).slice(0, 18) }]}
      readiness={resource.hasRefreshError ? "Degraded" : "Ready"}
      runtimeMode="OpenRouter"
      fixture={false}
      lastRefreshedAt={resource.lastRefreshedAt}
      isRefreshing={resource.isRefreshing}
      hasRefreshError={resource.hasRefreshError}
      onManualRefresh={resource.refresh}
    >
      {resource.hasRefreshError && resource.errorMessage && (
        <StaleDataBanner errorMessage={resource.errorMessage} lastValidAt={resource.lastRefreshedAt} onRetry={resource.refresh} />
      )}
      {resource.isLoadingInitial && !detail ? (
        <><SkeletonBlock className="mb-5 h-36" /><SkeletonBlock className="h-[34rem]" /></>
      ) : !detail ? (
        <section className="card p-8 text-center"><h2 className="text-sm font-bold">Case not found</h2><Link className="mt-3 inline-block text-xs text-evergreen hover:underline" href="/cases">← Back to cases</Link></section>
      ) : (
        <div className="space-y-5">
          <section className="card p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold text-ink">{detail.case.externalRef}</h2>
                  <span className="chip chip-ok">{detail.case.status}</span>
                  <span className="chip chip-mono">{detail.case.caseType}</span>
                  <span className="chip">{detail.case.jurisdiction}</span>
                </div>
                <p className="mono mt-2 text-[11px] text-ink-3">{detail.case.caseId}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="chip chip-ok"><ShieldCheck className="h-3.5 w-3.5" />{detail.case.classification}</span>
                <span className="chip"><History className="h-3.5 w-3.5" />Sequence {detail.case.caseSequence}</span>
              </div>
            </div>
            <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4 text-xs lg:grid-cols-5">
              <div><dt className="text-ink-3">Aggregate objects</dt><dd className="mono mt-1 font-semibold">{detail.graph.nodes.length}</dd></div>
              <div><dt className="text-ink-3">Lineage relationships</dt><dd className="mono mt-1 font-semibold">{detail.graph.edges.length}</dd></div>
              <div><dt className="text-ink-3">Ledger activities</dt><dd className="mono mt-1 font-semibold">{detail.ledger.eventCount}</dd></div>
              <div><dt className="text-ink-3">Harness plan</dt><dd className="mt-1"><DigestValue digest={detail.case.harnessPlanDigest} /></dd></div>
              <div><dt className="text-ink-3">Updated</dt><dd className="mt-1"><LocalTimestamp iso={detail.case.updatedAt} /></dd></div>
            </dl>
          </section>

          <div className="grid grid-cols-1 gap-5 2xl:grid-cols-[minmax(0,1fr)_390px]">
            <CategoryGraph
              nodes={detail.graph.nodes}
              edges={detail.graph.edges}
              categories={detail.graph.categories}
              selectedNodeId={selectedNode?.id ?? null}
              onSelectNode={setSelectedNodeId}
              title="Full KYC aggregate & evidence lineage"
            />
            <aside className="card h-fit overflow-hidden" aria-label="Selected aggregate object inspector">
              <div className="panel-head"><div><h2 className="text-[13px] font-bold">Node inspector</h2><p className="mono mt-0.5 text-[11px] text-ink-3">contract data · current projection</p></div></div>
              {selectedNode && (
                <div className="space-y-4 p-4">
                  <div><span className="eyebrow">{selectedNode.category}</span><h3 className="mt-1 text-sm font-bold text-ink">{selectedNode.label}</h3><p className="mono mt-1 break-all text-[10.5px] text-ink-3">{selectedNode.id}</p></div>
                  {selectedNode.status && <span className="chip chip-ok">{selectedNode.status}</span>}
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <div className="tile"><dt className="text-ink-3">Incoming</dt><dd className="mono mt-1 font-semibold">{detail.graph.edges.filter((edge) => edge.to === selectedNode.id).length}</dd></div>
                    <div className="tile"><dt className="text-ink-3">Outgoing</dt><dd className="mono mt-1 font-semibold">{detail.graph.edges.filter((edge) => edge.from === selectedNode.id).length}</dd></div>
                  </dl>
                  <JsonViewer data={selectedNode.data} label="Canonical object JSON" maxHeight="max-h-[30rem]" />
                </div>
              )}
            </aside>
          </div>

          <section className="card card-flush">
            <div className="panel-head">
              <div><h2 className="flex items-center gap-2 text-[13px] font-bold"><Activity className="h-4 w-4 text-evergreen" />Immutable case activity</h2><p className="mono mt-0.5 text-[11px] text-ink-3">{detail.ledger.eventCount} ordered events · digest-chained ledger</p></div>
              {detail.ledger.headDigest && <DigestValue digest={detail.ledger.headDigest} label="ledger head digest" />}
            </div>
            <ol className="divide-y divide-line">
              {[...detail.activities].reverse().map((activity) => (
                <li key={activity.eventId} className="grid grid-cols-[42px_minmax(0,1fr)] gap-3 p-4 sm:grid-cols-[56px_minmax(0,1fr)_170px]">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full border border-line-2 bg-surface-2 mono text-[11px] font-bold text-evergreen">{activity.sequence}</div>
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-mono-code text-xs font-bold text-ink">{activity.eventType}</span>{activity.evidenceRefs.length > 0 && <span className="chip"><FileCheck2 className="h-3 w-3" />{activity.evidenceRefs.length} evidence</span>}</div><p className="mt-1 text-[11.5px] text-ink-2">{activity.actorLabel}</p><details className="mt-2"><summary className="cursor-pointer text-[11px] font-semibold text-evergreen">Inspect payload & authority</summary><div className="mt-2 grid gap-2 lg:grid-cols-2"><JsonViewer data={activity.payload} label="Event payload" /><JsonViewer data={activity.authority} label="Authority" /></div></details></div>
                  <div className="col-start-2 text-left sm:col-start-auto sm:text-right"><LocalTimestamp iso={activity.occurredAt} /><p className="mono mt-1 truncate text-[10px] text-ink-3" title={activity.eventDigest}>{activity.eventDigest.slice(0, 16)}…</p></div>
                </li>
              ))}
            </ol>
          </section>

          {detail.executionRefs.length > 0 && (
            <section className="card p-5"><h2 className="flex items-center gap-2 text-sm font-bold"><GitBranch className="h-4 w-4 text-evergreen" />Linked harness execution & telemetry</h2><div className="mt-3 grid gap-3 lg:grid-cols-2">{detail.executionRefs.map((reference) => { const runId = String(reference.run_id ?? ""); const traceId = String(reference.trace_id ?? ""); return <div key={runId} className="tile text-xs"><p className="font-semibold text-ink">{String(reference.purpose ?? "Harness execution")}</p><div className="mt-2 flex flex-wrap gap-2"><Link className="btn btn-ghost btn-xs" href={`/runs/${encodeURIComponent(runId)}`}>Open run <ExternalLink className="h-3 w-3" /></Link>{traceId && <Link className="btn btn-ghost btn-xs" href={`/traces/${encodeURIComponent(traceId)}`}>Open native trace <Activity className="h-3 w-3" /></Link>}</div><p className="mono mt-2 break-all text-[10.5px] text-ink-3">{runId}</p></div>; })}</div></section>
          )}
        </div>
      )}
    </AppShell>
  );
}
