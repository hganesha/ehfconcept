"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Boxes, FileInput, PlusCircle, ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { LocalTimestamp, SkeletonBlock, StaleDataBanner } from "@/components/primitives";
import { usePolledResource } from "@/lib/use-polled-resource";
import type { AuthoringDraftView, AuthoringStatus } from "@/lib/types";

const STAGES: AuthoringStatus[] = ["DRAFT", "COMPILED", "EVALUATED", "APPROVED", "PUBLISHED"];

function LifecycleRail({ status }: { status: AuthoringStatus }) {
  const active = STAGES.indexOf(status);
  return <div className="flex items-center gap-1.5" aria-label={`Lifecycle status ${status}`}>{STAGES.map((stage, index) => <span key={stage} className={`h-1.5 w-8 rounded-full ${index <= active ? "bg-evergreen" : "bg-line-2"}`} title={stage} />)}</div>;
}

export default function AuthorPlanePage() {
  const router = useRouter();
  const drafts = usePolledResource<{ items: AuthoringDraftView[]; generatedAt: string }>("/v1/authoring/drafts", 5000, true);
  const templates = usePolledResource<{ items: { id: string; packageSource: string; workflowSource: string }[] }>("/v1/authoring/templates", 0, true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const items = drafts.data?.items ?? [];

  const createDraft = async (template?: { packageSource: string; workflowSource: string }) => {
    setCreating(true); setError(null);
    try {
      const response = await fetch("/v1/authoring/drafts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(template ?? {}) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? body.error ?? `HTTP ${response.status}`);
      router.push(`/author/${encodeURIComponent(body.draftId)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create draft");
    } finally { setCreating(false); }
  };

  return (
    <AppShell title="Author Plane" readiness={drafts.hasRefreshError ? "Degraded" : "Ready"} runtimeMode="OpenRouter" fixture={false}
      lastRefreshedAt={drafts.lastRefreshedAt} isRefreshing={drafts.isRefreshing} hasRefreshError={drafts.hasRefreshError}
      compactCounts={`${items.length} package draft${items.length === 1 ? "" : "s"}`} onManualRefresh={drafts.refresh}>
      {drafts.hasRefreshError && drafts.errorMessage ? <StaleDataBanner errorMessage={drafts.errorMessage} lastValidAt={drafts.lastRefreshedAt} onRetry={drafts.refresh} /> : null}
      <section className="card mb-5 p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl"><p className="eyebrow">Domain package factory</p><h2 className="mt-1 text-lg font-bold text-ink">Author → compile → evaluate → approve → publish</h2><p className="mt-2 text-xs leading-relaxed text-ink-2">Edit portable DomainPackage and Ladder Graph sources, define capability and canonical case-write contracts, then produce an immutable LangGraph runtime plan.</p></div>
          <button className="btn btn-primary" disabled={creating} onClick={() => void createDraft()}><PlusCircle className="h-4 w-4" />New domain</button>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4"><span className="text-xs font-semibold text-ink-2">Load existing domain:</span>{templates.data?.items.map((template) => <button key={template.id} className="btn btn-ghost" disabled={creating} onClick={() => void createDraft(template)}><FileInput className="h-3.5 w-3.5" />{template.id.toUpperCase()}</button>)}</div>
        {error ? <p className="mt-3 rounded-lg border border-danger/30 bg-danger-soft p-3 text-xs text-danger">{error}</p> : null}
      </section>

      {drafts.isLoadingInitial && !drafts.data ? <SkeletonBlock className="h-80" /> : items.length === 0 ? (
        <section className="card p-10 text-center"><Boxes className="mx-auto h-7 w-7 text-ink-3" /><h2 className="mt-3 text-sm font-bold">No package drafts yet</h2><p className="mt-1 text-xs text-ink-2">Start blank or import one of the checked-in domains.</p></section>
      ) : <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{items.map((draft) => (
        <button key={draft.draftId} type="button" onClick={() => router.push(`/author/${encodeURIComponent(draft.draftId)}`)} className="card card-link group p-5 text-left">
          <div className="flex items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-bold text-ink group-hover:text-evergreen">{draft.name}</h2><span className={`chip ${draft.status === "PUBLISHED" ? "chip-ok" : draft.status === "DRAFT" ? "chip-active" : "chip-warn"}`}>{draft.status}</span></div><p className="mono mt-1 text-[11px] text-ink-3">{draft.domain} · v{draft.version} · revision {draft.revision}</p></div><ArrowRight className="h-4 w-4 text-ink-3 group-hover:text-evergreen" /></div>
          <div className="mt-4 flex items-center justify-between gap-3 border-y border-line py-3"><LifecycleRail status={draft.status} /><span className="mono text-[10.5px] text-ink-3">{draft.diagnostics.filter((item) => item.severity === "error").length} errors</span></div>
          <div className="mt-3 flex items-center justify-between text-xs"><span className="inline-flex items-center gap-1.5 text-ink-2"><ShieldCheck className="h-3.5 w-3.5" />{draft.publishedPlanDigest ? "Immutable plan published" : "Mutable authoring source"}</span><LocalTimestamp iso={draft.updatedAt} /></div>
        </button>
      ))}</div>}
    </AppShell>
  );
}
