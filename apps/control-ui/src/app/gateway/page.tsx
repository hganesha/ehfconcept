"use client";

import React, { useState } from "react";
import Link from "next/link";
import { ShieldCheck, ShieldAlert, Wifi, Lock, ArrowUpRight, Loader2 } from "lucide-react";
import { AppShell } from "@/components/app-shell";
import { DataTable, Column } from "@/components/data-table";
import {
  DigestValue,
  LocalTimestamp,
  ReadinessBadge,
  SectionCard,
  StaleDataBanner,
} from "@/components/primitives";
import { usePolledResource } from "@/lib/use-polled-resource";
import {
  GatewayDecisionView,
  GatewayStatusView,
  ModelTierProfileView,
  ToolCapabilityView,
} from "@/lib/types";

export default function CapabilityGatewayPage() {
  const [testingConn, setTestingConn] = useState(false);
  const [decisionFilter, setDecisionFilter] = useState("all");

  const {
    data: status,
    isRefreshing,
    hasRefreshError,
    errorMessage,
    lastRefreshedAt,
    refresh,
  } = usePolledResource<GatewayStatusView>("/v1/gateway/status", 5000, true);

  const { data: profilesData } = usePolledResource<{ items: ModelTierProfileView[] }>(
    "/v1/gateway/profiles",
    10000,
    true
  );
  const { data: capsData } = usePolledResource<{ items: ToolCapabilityView[] }>(
    "/v1/gateway/capabilities",
    10000,
    true
  );
  const { data: decisionsData, refresh: refreshDecisions } = usePolledResource<{
    items: GatewayDecisionView[];
  }>(`/v1/gateway/decisions?decision=${encodeURIComponent(decisionFilter)}`, 5000, true);

  const handleTestConnection = async () => {
    setTestingConn(true);
    try {
      await fetch("/v1/gateway/openrouter/test", { method: "POST" });
      refresh();
      refreshDecisions();
    } finally {
      setTestingConn(false);
    }
  };

  const tierColumns: Column<ModelTierProfileView>[] = [
    {
      id: "tier",
      header: "Tier ID & version",
      primary: true,
      cell: (p) => (
        <div>
          <div className="mono text-xs font-bold text-ink">{p.tierId}</div>
          <div className="mono text-[11px] text-ink-3">{p.version}</div>
        </div>
      ),
    },
    {
      id: "purpose",
      header: "Purpose",
      hideBelow: "xl",
      cell: (p) => <p className="max-w-xs text-xs text-ink-2">{p.purpose}</p>,
    },
    {
      id: "digest",
      header: "Profile digest",
      hideBelow: "lg",
      cell: (p) => <DigestValue digest={p.profileDigest} showCopy={false} />,
    },
    {
      id: "model",
      header: "Resolved model",
      cell: (p) => (
        <span className="mono break-anywhere text-xs font-semibold text-evergreen">
          {p.resolvedOpenRouterModel}
        </span>
      ),
    },
    {
      id: "tokens",
      header: "Max tokens in / out",
      hideBelow: "xl",
      cell: (p) => (
        <span className="mono text-xs text-ink">
          {p.maxInputTokens.toLocaleString()} / {p.maxOutputTokens.toLocaleString()}
        </span>
      ),
    },
    {
      id: "limits",
      header: "Timeout / concurrency",
      hideBelow: "lg",
      cell: (p) => (
        <span className="mono text-xs text-ink">
          {p.timeoutMs}ms · max {p.concurrencyLimit}
        </span>
      ),
    },
    {
      id: "state",
      header: "State",
      cell: (p) => (
        <span className="chip chip-ok">{p.enabled ? "Enabled" : "Disabled"}</span>
      ),
    },
    { id: "last", header: "Last success", cell: (p) => <LocalTimestamp iso={p.lastSuccessAt} compact /> },
  ];

  const capColumns: Column<ToolCapabilityView>[] = [
    {
      id: "cap",
      header: "Capability ID",
      primary: true,
      cell: (c) => (
        <span className="mono break-anywhere text-xs font-bold text-ink">
          {c.capabilityId}
        </span>
      ),
    },
    {
      id: "effect",
      header: "Effect class",
      cell: (c) => (
        <span className={`chip chip-mono ${c.effectClass === "read_only" ? "" : "chip-warn"}`}>
          {c.effectClass}
        </span>
      ),
    },
    {
      id: "binding",
      header: "Adapter binding",
      cell: (c) => (
        <span className="mono break-anywhere text-xs text-ink">{c.adapterBindingId}</span>
      ),
    },
    {
      id: "schemas",
      header: "Request / result schema",
      hideBelow: "xl",
      cell: (c) => (
        <span className="mono text-xs text-ink-2">
          {c.requestSchemaVersion} → {c.resultSchemaVersion}
        </span>
      ),
    },
    {
      id: "policy",
      header: "Timeout & retry",
      hideBelow: "lg",
      cell: (c) => (
        <span className="mono text-xs text-ink">
          {c.timeoutMs}ms · {c.retryPolicy}
        </span>
      ),
    },
    {
      id: "cred",
      header: "Credential",
      cell: (c) => <span className="chip chip-mono">{c.credentialState}</span>,
    },
    { id: "health", header: "Health", cell: (c) => <ReadinessBadge status={c.health} /> },
  ];

  const decisionColumns: Column<GatewayDecisionView>[] = [
    {
      id: "when",
      header: "Timestamp & receipt",
      primary: true,
      cell: (d) => (
        <div className="min-w-0">
          <LocalTimestamp iso={d.occurredAt} compact />
          <div className="mono break-anywhere text-[11px] text-ink-3">{d.receiptId}</div>
        </div>
      ),
    },
    {
      id: "run",
      header: "Run & node",
      cell: (d) => (
        <div className="min-w-0">
          <Link
            href={`/runs/${d.runId}`}
            className="mono inline-flex items-center gap-1 text-xs font-semibold text-evergreen hover:underline"
          >
            <span className="truncate">{d.runId}</span>
            <ArrowUpRight className="h-3 w-3 shrink-0" aria-hidden="true" />
          </Link>
          <div className="mono break-anywhere text-[11px] text-ink-3">{d.nodeId}</div>
        </div>
      ),
    },
    {
      id: "cap",
      header: "Capability & effect",
      cell: (d) => (
        <div className="mono min-w-0 text-xs">
          <div className="break-anywhere font-bold text-ink">{d.capabilityId}</div>
          <div className="break-anywhere text-[11px] text-ink-3">{d.effect}</div>
        </div>
      ),
    },
    {
      id: "decision",
      header: "Decision",
      cell: (d) =>
        d.decision === "denied" ? (
          <span className="chip chip-danger">
            <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Denied</span>
          </span>
        ) : (
          <span className="chip chip-ok">
            <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Allowed</span>
          </span>
        ),
    },
    {
      id: "reason",
      header: "Reason code",
      cell: (d) => (
        <span className="mono break-anywhere text-xs font-semibold text-ink">
          {d.reasonCode}
        </span>
      ),
    },
    {
      id: "fencing",
      header: "Attempt / epoch",
      hideBelow: "lg",
      cell: (d) => (
        <span className="mono text-xs text-ink">
          att:{d.attempt} · epoch:{d.fencingEpoch}
        </span>
      ),
    },
    {
      id: "envelope",
      header: "Envelope scope digest",
      hideBelow: "xl",
      cell: (d) => <DigestValue digest={d.envelopeDigest} showCopy={false} />,
    },
    {
      id: "trace",
      header: "Trace / span",
      hideBelow: "xl",
      cell: (d) => (
        <div className="mono text-[11px] text-ink-2">
          <div>{d.traceId ? `${d.traceId.slice(0, 12)}…` : "—"}</div>
          <div>{d.spanId ? `span ${d.spanId}` : "no span"}</div>
        </div>
      ),
    },
    {
      id: "result",
      header: "Latency & result",
      cell: (d) => (
        <div className="mono text-xs text-ink">
          <div>{d.latencyMs} ms</div>
          <div className="text-[11px] text-ink-3">{d.resultStatus || "—"}</div>
        </div>
      ),
    },
  ];

  return (
    <AppShell
      title="Capability Gateway"
      readiness={status?.readiness || "Ready"}
      runtimeMode={status?.runtimeMode || "Recorded"}
      fixture={status?.runtimeMode !== "OpenRouter"}
      lastRefreshedAt={lastRefreshedAt}
      pollIntervalSec={5}
      isRefreshing={isRefreshing}
      hasRefreshError={hasRefreshError}
      compactCounts={
        status ? `${status.calls24h} calls · ${status.denials24h} denials · 24h` : null
      }
      onManualRefresh={() => {
        refresh();
        refreshDecisions();
      }}
    >
      {hasRefreshError && errorMessage && (
        <StaleDataBanner
          errorMessage={errorMessage}
          lastValidAt={lastRefreshedAt}
          onRetry={refresh}
        />
      )}

      <div className="space-y-5 sm:space-y-6">
        {/* ---------- Status header ---------- */}
        <section className="card p-4 sm:p-5" aria-label="Gateway boundary status">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2.5">
                <h2 className="text-[15px] font-bold text-ink">
                  Envelope verifier boundary
                </h2>
                <ReadinessBadge status={status?.readiness || "Ready"} />
              </div>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-2">
                Mediates every model-tier invocation and external tool effect against
                signed execution envelopes. Provider credentials are never returned to
                the browser.
              </p>
            </div>

            <button
              type="button"
              disabled={testingConn}
              onClick={handleTestConnection}
              className="btn btn-primary shrink-0"
            >
              {testingConn ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Wifi className="h-4 w-4" aria-hidden="true" />
              )}
              <span>
                {testingConn ? "Probing catalog…" : "Test OpenRouter connection"}
              </span>
            </button>
          </div>

          <dl className="mt-4 grid grid-cols-1 gap-3 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <div className="tile">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                OpenRouter credential
              </dt>
              <dd className="mt-1.5">
                <span className="chip chip-ok">{status?.openRouterState || "Configured"}</span>
              </dd>
            </div>
            <div className="tile">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                Last probe & latency
              </dt>
              <dd className="mono mt-1.5 flex flex-wrap items-center gap-1.5 text-xs font-semibold text-ink">
                <span>
                  {status?.lastConnectionLatencyMs
                    ? `${status.lastConnectionLatencyMs} ms`
                    : "—"}
                </span>
                <LocalTimestamp iso={status?.lastConnectionTestAt} compact />
              </dd>
            </div>
            <div className="tile">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                Envelope verifier
              </dt>
              <dd className="mono mt-1.5 text-xs font-semibold text-evergreen">
                {status?.envelopeVerifierStatus || "Verified · HMAC-SHA256 envelope-v1"}
              </dd>
            </div>
            <div className="tile">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                Authorized calls · 24h
              </dt>
              <dd className="num mt-1 text-2xl font-bold text-ink">
                {status?.calls24h ?? "—"}
              </dd>
            </div>
            <div className="tile">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                Denials · 24h
              </dt>
              <dd className="num mt-1 text-2xl font-bold text-danger">
                {status?.denials24h ?? "—"}
              </dd>
            </div>
          </dl>

          {status?.lastConnectionMessage && (
            <p className="mono mt-3 rounded-lg border border-[#bcd9c7] bg-mint px-3 py-2 text-[11.5px] text-evergreen">
              {status.lastConnectionMessage}
            </p>
          )}
        </section>

        {/* ---------- Model tiers ---------- */}
        <SectionCard
          flush
          title="Model tiers"
          description="Read-only bindings sourced from versioned profile manifests."
          actions={
            <span className="chip chip-mono">
              <Lock className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Immutable manifest</span>
            </span>
          }
        >
          <DataTable
            caption="Model tier profiles"
            columns={tierColumns}
            rows={profilesData?.items || []}
            getRowKey={(p) => p.tierId}
          />
        </SectionCard>

        {/* ---------- Tool capabilities ---------- */}
        <SectionCard
          flush
          title="Tool capabilities"
          description="Logical capabilities, effect classes, adapter bindings, and credential readiness."
        >
          <DataTable
            caption="Tool capability bindings"
            columns={capColumns}
            rows={capsData?.items || []}
            getRowKey={(c) => c.capabilityId}
          />
        </SectionCard>

        {/* ---------- Recent decisions ---------- */}
        <SectionCard
          flush
          title="Recent decisions"
          description="Authorization and invocation receipts — denials listed first."
          actions={
            <label className="flex items-center gap-2">
              <span className="text-[11.5px] text-ink-2">Decision</span>
              <select
                aria-label="Filter gateway decisions"
                value={decisionFilter}
                onChange={(e) => setDecisionFilter(e.target.value)}
                className="field w-44 py-1.5"
              >
                <option value="all">All (denials first)</option>
                <option value="denied">Denied only</option>
                <option value="allowed">Allowed only</option>
              </select>
            </label>
          }
        >
          <DataTable
            caption="Gateway authorization receipts"
            columns={decisionColumns}
            rows={decisionsData?.items || []}
            getRowKey={(d) => d.receiptId}
            emptyMessage="No gateway decisions recorded for this filter."
          />
        </SectionCard>
      </div>
    </AppShell>
  );
}
