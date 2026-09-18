"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { Activity, ArrowLeft, ExternalLink, GitBranch, Timer } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { CopyButton, DurationValue, JsonViewer, LocalTimestamp, SkeletonBlock, StaleDataBanner } from "@/components/primitives";
import { usePolledResource } from "@/lib/use-polled-resource";
import type { NativeTraceSpan, NativeTraceView } from "@/lib/types";

function SpanRow({ span, traceDuration, selected, onSelect }: { span: NativeTraceSpan; traceDuration: number; selected: boolean; onSelect: (id: string) => void }) {
  const left = traceDuration ? Math.min(100, (span.startOffsetMs / traceDuration) * 100) : 0;
  const width = traceDuration ? Math.max(0.5, (span.durationMs / traceDuration) * 100) : 100;
  return <button type="button" onClick={() => onSelect(span.spanId)} aria-pressed={selected} className={`grid w-full grid-cols-[minmax(210px,0.9fr)_minmax(250px,1.5fr)_76px] items-center gap-3 border-b border-line px-3 py-2 text-left transition-colors ${selected ? "bg-mint" : "hover:bg-surface-2"}`}>
    <span className="min-w-0" style={{ paddingLeft: `${Math.min(span.depth, 8) * 12}px` }}><span className="block truncate text-xs font-semibold text-ink">{span.operationName}</span><span className="mono block truncate text-[10px] text-ink-3">{span.serviceName}</span></span>
    <span className="relative h-5 overflow-hidden rounded bg-[#edf1ea]"><span className={`absolute top-1 h-3 rounded ${span.status === "error" ? "bg-danger" : "bg-evergreen"}`} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%`, minWidth: "3px" }} /></span>
    <span className="num text-right text-[11px] font-semibold text-ink-2">{span.durationMs.toFixed(2)} ms</span>
  </button>;
}

export default function NativeTracePage({ params }: { params: Promise<{ traceId: string }> }) {
  const { traceId } = use(params);
  const resource = usePolledResource<NativeTraceView>(`/v1/traces/${encodeURIComponent(traceId)}`, 0, true);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const trace = resource.data;
  const selected = useMemo(() => trace?.spans.find((span) => span.spanId === selectedSpanId) ?? trace?.spans.find((span) => !span.parentSpanId) ?? trace?.spans[0] ?? null, [selectedSpanId, trace]);
  return <AppShell title="Execution trace" breadcrumb={[{ label: "Runs", href: "/runs" }, { label: traceId.slice(0, 12) }]} readiness={resource.hasRefreshError ? "Degraded" : "Ready"} runtimeMode="Recorded" fixture={false} lastRefreshedAt={resource.lastRefreshedAt} pollIntervalSec={0} isRefreshing={resource.isRefreshing} hasRefreshError={resource.hasRefreshError} onManualRefresh={resource.refresh}>
    {resource.hasRefreshError && resource.errorMessage ? <StaleDataBanner errorMessage={resource.errorMessage} lastValidAt={resource.lastRefreshedAt} onRetry={resource.refresh} /> : null}
    {resource.isLoadingInitial && !trace ? <SkeletonBlock className="h-[36rem]" /> : !trace ? <section className="card p-8 text-center"><h2 className="text-sm font-bold">Trace unavailable</h2><p className="mt-2 text-xs text-ink-2">Jaeger did not return trace {traceId}.</p><Link href="/runs" className="btn btn-ghost mt-4"><ArrowLeft className="h-3.5 w-3.5" />Back to runs</Link></section> : <div className="space-y-5">
      <section className="card p-5"><div className="flex flex-wrap items-start justify-between gap-4"><div><span className="eyebrow">Native OpenTelemetry trace</span><div className="mt-2 flex flex-wrap items-center gap-2"><h2 className="mono break-anywhere text-base font-bold">{trace.traceId}</h2><CopyButton value={trace.traceId} label="Copy trace ID" compact /></div><p className="mt-2 text-xs text-ink-2">Telemetry is queried from Jaeger and rendered inside the control plane.</p></div><a className="btn btn-ghost" href={trace.rawViewerUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" />Raw Jaeger</a></div><dl className="mt-4 grid grid-cols-2 gap-4 border-t border-line pt-4 lg:grid-cols-4"><div><dt className="eyebrow">Started</dt><dd className="mt-1 text-xs"><LocalTimestamp iso={trace.startedAt} /></dd></div><div><dt className="eyebrow">Duration</dt><dd className="mt-1"><DurationValue ms={trace.durationMs} /></dd></div><div><dt className="eyebrow">Spans</dt><dd className="num mt-1 text-sm font-bold">{trace.spanCount}</dd></div><div><dt className="eyebrow">Services</dt><dd className="mt-1 flex flex-wrap gap-1">{trace.services.map((service) => <span className="chip" key={service}>{service}</span>)}</dd></div></dl></section>
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.55fr)]"><section className="card card-flush overflow-hidden"><div className="panel-head"><div><h2 className="flex items-center gap-2 text-[13px] font-bold"><GitBranch className="h-4 w-4 text-evergreen" />Span waterfall</h2><p className="mono mt-0.5 text-[11px] text-ink-3">parent-child depth · relative execution time</p></div></div><div className="grid grid-cols-[minmax(210px,0.9fr)_minmax(250px,1.5fr)_76px] gap-3 border-b border-line bg-surface-2 px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-ink-3"><span>Operation / service</span><span>Timeline</span><span className="text-right">Duration</span></div><div className="max-h-[38rem] overflow-auto">{trace.spans.map((span) => <SpanRow key={span.spanId} span={span} traceDuration={trace.durationMs} selected={selected?.spanId === span.spanId} onSelect={setSelectedSpanId} />)}</div></section>
      <aside className="card card-flush h-fit overflow-hidden"><div className="panel-head"><div><h2 className="flex items-center gap-2 text-[13px] font-bold"><Activity className="h-4 w-4 text-evergreen" />Span inspector</h2><p className="mono mt-0.5 text-[11px] text-ink-3">approved operational attributes</p></div></div>{selected ? <div className="space-y-4 p-4"><div><div className="flex flex-wrap items-center gap-2"><span className={`chip ${selected.status === "error" ? "chip-danger" : "chip-ok"}`}>{selected.status}</span><span className="chip">{selected.serviceName}</span></div><h3 className="mt-2 text-sm font-bold">{selected.operationName}</h3><p className="mono mt-1 break-all text-[10px] text-ink-3">{selected.spanId}</p></div><dl className="grid grid-cols-2 gap-3"><div className="tile"><dt className="eyebrow">Offset</dt><dd className="num mt-1 text-xs font-bold">{selected.startOffsetMs.toFixed(2)} ms</dd></div><div className="tile"><dt className="eyebrow">Duration</dt><dd className="mt-1 flex items-center gap-1 text-xs font-bold"><Timer className="h-3 w-3" />{selected.durationMs.toFixed(2)} ms</dd></div></dl><JsonViewer data={selected.tags} label="Span attributes" maxHeight="max-h-[25rem]" /></div> : null}</aside></div>
    </div>}
  </AppShell>;
}
