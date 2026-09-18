"use client";

import React from "react";
import { Database, Cpu, Layers, AlertCircle, Lock, ShieldCheck } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { DataTable, Column } from "@/components/data-table";
import {
  LocalTimestamp,
  PrimitiveBadge,
  ReadinessBadge,
  SectionCard,
  SkeletonBlock,
  StaleDataBanner,
} from "@/components/primitives";
import { usePolledResource } from "@/lib/use-polled-resource";
import { NodePrimitive, SystemView } from "@/lib/types";

type PrimitiveRow = {
  primitive: NodePrimitive;
  profileVersion: string;
  deterministicReplay: boolean;
  description: string;
};

export default function SystemPage() {
  const {
    data: sys,
    isLoadingInitial,
    isRefreshing,
    hasRefreshError,
    errorMessage,
    lastRefreshedAt,
    refresh,
  } = usePolledResource<SystemView>("/v1/system", 5000, true);

  const primitiveColumns: Column<PrimitiveRow>[] = [
    {
      id: "primitive",
      header: "Primitive",
      primary: true,
      cell: (p) => <PrimitiveBadge primitive={p.primitive} />,
    },
    {
      id: "profile",
      header: "Profile version",
      cell: (p) => <span className="mono text-xs text-ink">{p.profileVersion}</span>,
    },
    {
      id: "replay",
      header: "Deterministic replay",
      cell: (p) => (
        <span className={`chip chip-mono ${p.deterministicReplay ? "chip-ok" : ""}`}>
          {p.deterministicReplay ? "content-addressed" : "gateway receipt"}
        </span>
      ),
    },
    {
      id: "desc",
      header: "Contract semantics",
      cell: (p) => <p className="text-xs leading-relaxed text-ink-2">{p.description}</p>,
    },
  ];

  const queueTiles = sys
    ? [
        { label: "Ready", value: sys.queueWorkState.ready, cls: "text-ink" },
        { label: "Leased", value: sys.queueWorkState.leased, cls: "text-active" },
        { label: "Retrying", value: sys.queueWorkState.retrying, cls: "text-warn" },
        { label: "Stale / fenced", value: sys.queueWorkState.stale, cls: "text-ink" },
      ]
    : [];

  return (
    <AppShell
      title="System"
      readiness={sys?.globalReadiness || "Ready"}
      runtimeMode={sys?.runtimeMode || "Recorded"}
      fixture={sys?.fixture ?? true}
      lastRefreshedAt={lastRefreshedAt}
      pollIntervalSec={5}
      isRefreshing={isRefreshing}
      hasRefreshError={hasRefreshError}
      compactCounts={
        sys ? `${sys.queueWorkState.activeWorkers} workers · ${sys.databaseMigrationVersion}` : null
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

      {isLoadingInitial && !sys ? (
        <div className="space-y-5">
          <SkeletonBlock className="h-44" />
          <SkeletonBlock className="h-64" />
        </div>
      ) : sys ? (
        <div className="space-y-5 sm:space-y-6">
          {/* Authority notice */}
          <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <p className="flex items-start gap-2.5 text-xs text-ink-2">
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-evergreen" aria-hidden="true" />
              <span>
                <strong className="text-ink">Read-only diagnostics.</strong> No restart,
                reset, migration, secret, or destructive controls are exposed in this
                surface.
              </span>
            </p>
            <span className="mono text-[11.5px] text-ink-3">
              fresh through <LocalTimestamp iso={sys.telemetryFreshThrough} compact />
            </span>
          </div>

          {/* Component readiness */}
          <SectionCard
            title="Component readiness"
            description="Separates application problems from runtime, persistence, gateway, simulator, and provider problems."
            actions={<ReadinessBadge status={sys.globalReadiness} />}
          >
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {sys.componentReadiness.map((c) => (
                <li key={c.id} className="tile flex flex-col justify-between gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-bold text-ink">{c.name}</span>
                    <ReadinessBadge status={c.status} />
                  </div>
                  <div className="mono flex items-center justify-between gap-2 text-[11px] text-ink-3">
                    <span className="truncate">{c.detail}</span>
                    <span className="shrink-0">{c.latencyMs} ms</span>
                  </div>
                </li>
              ))}
            </ul>
          </SectionCard>

          {/* Runtime isolation */}
          <SectionCard
            title="Agent execution isolation"
            description="Shows where agent code executes and which authority selects the runtime boundary."
            actions={<ShieldCheck className="h-4 w-4 text-evergreen" aria-hidden="true" />}
          >
            <div className="mb-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
              <div className="tile">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Isolation scope</p>
                <p className="mt-1 text-xs font-bold text-ink">Whole harness invocation</p>
              </div>
              <div className="tile">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Default provider</p>
                <p className="mono mt-1 text-xs font-bold text-ink">
                  {sys.runtimeIsolation.defaultProvider}
                </p>
              </div>
              <div className="tile">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">Mixed targets</p>
                <p className="mt-1 text-xs font-bold text-ink">
                  {sys.runtimeIsolation.mixedTargetsAllowed ? "Allowed" : "Rejected before dispatch"}
                </p>
              </div>
            </div>

            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {sys.runtimeIsolation.providers.map((provider) => (
                <li key={provider.id} className="tile">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-bold text-ink">{provider.name}</p>
                      <p className="mono mt-0.5 text-[10.5px] text-ink-3">{provider.id}</p>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {provider.id === sys.runtimeIsolation.defaultProvider && (
                        <span className="chip chip-ok">default</span>
                      )}
                      <span className={`chip ${provider.configured ? "chip-ok" : "chip-warn"}`}>
                        {provider.configured ? "configured" : "adapter available · not configured"}
                      </span>
                    </div>
                  </div>
                  <dl className="mt-3 space-y-2 text-[11.5px]">
                    <div className="flex flex-wrap justify-between gap-2">
                      <dt className="text-ink-3">execution boundary</dt>
                      <dd className="text-right font-semibold text-ink">{provider.boundary}</dd>
                    </div>
                    <div className="flex flex-wrap justify-between gap-2">
                      <dt className="text-ink-3">authentication</dt>
                      <dd className="text-right text-ink">{provider.authentication}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-ink-3">
              Selection authority: {sys.runtimeIsolation.selectionAuthority}.
            </p>
          </SectionCard>

          {/* Build + queue */}
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2 xl:gap-6">
            <SectionCard
              title="Build metadata"
              description="UI, API, runtime, compiler, and adapter versions"
              actions={<Cpu className="h-4 w-4 text-evergreen" aria-hidden="true" />}
            >
              <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[
                  ["UI control surface", sys.buildMetadata.uiVersion],
                  ["Control-plane API", sys.buildMetadata.apiVersion],
                  ["Execution runtime", sys.buildMetadata.runtimeVersion],
                  ["Plan compiler", sys.buildMetadata.compilerVersion],
                  ["Adapter bundle", sys.buildMetadata.adapterBundleVersion],
                  ["Commit SHA", sys.buildMetadata.commitSha],
                ].map(([label, value]) => (
                  <div key={label} className="tile">
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                      {label}
                    </dt>
                    <dd className="mono break-anywhere mt-1 text-xs font-semibold text-ink">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </SectionCard>

            <SectionCard
              title="Queue & persistence"
              description="Lease state, fencing authority, and migration version"
              actions={<Database className="h-4 w-4 text-evergreen" aria-hidden="true" />}
            >
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {queueTiles.map((t) => (
                  <div key={t.label} className="tile text-center">
                    <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                      {t.label}
                    </dt>
                    <dd className={`num mt-1 text-2xl font-bold ${t.cls}`}>{t.value}</dd>
                  </div>
                ))}
              </dl>

              <dl className="mono mt-3 space-y-2 rounded-lg border border-line bg-surface-2 p-3 text-[11.5px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <dt className="text-ink-3">migration version</dt>
                  <dd className="break-anywhere font-bold text-ink">
                    {sys.databaseMigrationVersion}
                  </dd>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <dt className="text-ink-3">fencing authority</dt>
                  <dd className="break-anywhere text-evergreen">
                    {sys.queueWorkState.fencingAuthority}
                  </dd>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <dt className="text-ink-3">environment · mode</dt>
                  <dd className="text-ink">
                    {sys.environment} · {sys.runtimeMode}
                  </dd>
                </div>
              </dl>
            </SectionCard>
          </div>

          {/* Supported primitives */}
          <SectionCard
            flush
            title="Supported execution-profile primitives"
            description="Only plans compiled exclusively from these verified primitives can be admitted."
            actions={<Layers className="h-4 w-4 text-evergreen" aria-hidden="true" />}
          >
            <DataTable
              caption="Supported execution primitives"
              columns={primitiveColumns}
              rows={sys.supportedPrimitives}
              getRowKey={(p) => p.primitive}
            />
          </SectionCard>

          {/* Limitations */}
          <SectionCard
            title="Known POC limitations"
            description="Authority this proof of concept explicitly does not claim."
            actions={<AlertCircle className="h-4 w-4 text-warn" aria-hidden="true" />}
          >
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {sys.knownPocLimitations.map((lim) => (
                <li key={lim.id} className="tile">
                  <p className="text-xs font-bold text-ink">{lim.area}</p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-2">
                    {lim.explanation}
                  </p>
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      ) : null}
    </AppShell>
  );
}
