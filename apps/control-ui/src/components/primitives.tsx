"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  Check,
  Copy,
  Download,
  AlertTriangle,
  ShieldAlert,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  RotateCcw,
  Eye,
  WifiOff,
  Activity,
  WrapText,
  ArrowUpRight,
} from "lucide-react";
import { CostView, NodePrimitive, RunStatus } from "@/lib/types";

/* ------------------------------------------------------------------ *
 * Copy / download actions
 * ------------------------------------------------------------------ */
export function CopyButton({
  value,
  label = "Copy",
  compact = false,
}: {
  value: string;
  label?: string;
  compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={`${label}: ${value}`}
      title={`Copy ${label}`}
      className={`btn btn-ghost ${compact ? "btn-xs" : ""}`}
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-evergreen" aria-hidden="true" />
          <span>Copied</span>
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />
          <span>{label}</span>
        </>
      )}
    </button>
  );
}

export function DownloadButton({
  filename,
  data,
  label = "Download JSON",
  compact = false,
}: {
  filename: string;
  data: unknown;
  label?: string;
  compact?: boolean;
}) {
  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    const content =
      typeof data === "string" ? data : JSON.stringify(data, null, 2);
    const blob = new Blob([content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <button
      type="button"
      onClick={handleDownload}
      aria-label={label}
      className={`btn btn-ghost ${compact ? "btn-xs" : ""}`}
    >
      <Download className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

/* ------------------------------------------------------------------ *
 * Machine data values
 * ------------------------------------------------------------------ */
export function DigestValue({
  digest,
  full = false,
  showCopy = true,
  label = "digest",
}: {
  digest: string;
  full?: boolean;
  showCopy?: boolean;
  label?: string;
}) {
  const shortText =
    digest.length > 22 ? `${digest.slice(0, 15)}…${digest.slice(-6)}` : digest;

  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
      <span
        className="mono break-anywhere rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11.5px] text-ink"
        title={digest}
      >
        {full ? digest : shortText}
      </span>
      {showCopy && <CopyButton value={digest} label={label} compact />}
    </span>
  );
}

export function CostValue({
  cost,
  showLabel = false,
  size = "sm",
}: {
  cost: CostView | null | undefined;
  showLabel?: boolean;
  size?: "sm" | "lg";
}) {
  if (!cost) {
    return (
      <span className="chip chip-warn">
        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span>No cost telemetry</span>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {showLabel && <span className="text-xs text-ink-2">Reported cost:</span>}
      <span
        className={`num font-semibold text-ink ${
          size === "lg" ? "text-2xl" : "text-xs"
        }`}
      >
        ${cost.reportedUsd.toFixed(4)}
      </span>
      {!cost.complete && (
        <span
          className="chip chip-warn"
          title="One or more provider calls omitted cost headers; this total is partial."
        >
          <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
          <span>Incomplete</span>
        </span>
      )}
    </span>
  );
}

export function DurationValue({ ms }: { ms: number | null | undefined }) {
  if (ms === null || ms === undefined) {
    return <span className="num text-xs text-ink-3">—</span>;
  }
  return (
    <span className="num text-xs text-ink">
      {ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`}
    </span>
  );
}

export function LocalTimestamp({
  iso,
  compact = false,
}: {
  iso: string | null | undefined;
  compact?: boolean;
}) {
  if (!iso) return <span className="text-xs text-ink-3">Never</span>;
  const date = new Date(iso);
  if (isNaN(date.getTime()))
    return <span className="text-xs text-ink-3">{iso}</span>;

  const localFormatted = compact
    ? date.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : date.toLocaleString([], {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

  return (
    <time
      dateTime={date.toISOString()}
      title={`UTC: ${date.toISOString()}`}
      className="num cursor-help text-xs text-ink-2 underline decoration-dotted underline-offset-2"
    >
      {localFormatted}
    </time>
  );
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */
export function ReadinessBadge({
  status,
}: {
  status: "Ready" | "Degraded" | "Unavailable" | "Healthy" | "Unreachable";
}) {
  if (status === "Ready" || status === "Healthy") {
    return (
      <span className="chip chip-ok">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>{status}</span>
      </span>
    );
  }
  if (status === "Degraded") {
    return (
      <span className="chip chip-warn">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Degraded</span>
      </span>
    );
  }
  return (
    <span className="chip chip-danger">
      <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{status}</span>
    </span>
  );
}

export function RunStatusBadge({ status }: { status: RunStatus }) {
  switch (status) {
    case "running":
      return (
        <span className="chip chip-active">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" aria-hidden="true" />
          <span>Running</span>
        </span>
      );
    case "queued":
      return (
        <span className="chip">
          <Clock className="h-3.5 w-3.5 shrink-0 text-ink-3" aria-hidden="true" />
          <span>Queued</span>
        </span>
      );
    case "retrying":
      return (
        <span className="chip chip-warn">
          <RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Retrying · fenced</span>
        </span>
      );
    case "completed":
      return (
        <span className="chip chip-ok">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Completed</span>
        </span>
      );
    case "manual_review":
      return (
        <span className="chip chip-warn">
          <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Manual review</span>
        </span>
      );
    case "denied":
      return (
        <span className="chip chip-danger">
          <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Denied</span>
        </span>
      );
    case "failed":
    default:
      return (
        <span className="chip chip-danger">
          <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Failed</span>
        </span>
      );
  }
}

export function PrimitiveBadge({ primitive }: { primitive: NodePrimitive }) {
  const map: Record<NodePrimitive, { label: string; symbol: string; cls: string }> =
    {
      input: { label: "Input", symbol: "▷", cls: "chip" },
      transform: { label: "Transform", symbol: "◇", cls: "chip" },
      agent: { label: "Agent", symbol: "⬡", cls: "chip chip-ok" },
      model: { label: "Model capability", symbol: "◆", cls: "chip chip-ok" },
      tool: { label: "Tool capability", symbol: "▣", cls: "chip chip-active" },
      condition: { label: "Condition", symbol: "◇", cls: "chip chip-active" },
      evaluate: { label: "Evaluate gate", symbol: "⚖", cls: "chip chip-warn" },
      join: { label: "Join", symbol: "⊕", cls: "chip" },
      aggregator: { label: "Aggregator", symbol: "Σ", cls: "chip chip-warn" },
      output: { label: "Terminal output", symbol: "◉", cls: "chip chip-ok" },
    };
  const info = map[primitive] || map.transform;
  return (
    <span className={`${info.cls} chip-mono`}>
      <span aria-hidden="true">{info.symbol}</span>
      <span>{info.label}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Telemetry freshness
 * ------------------------------------------------------------------ */
export function FreshnessIndicator({
  lastRefreshedAt,
  pollIntervalSec = 5,
  isRefreshing = false,
  hasError = false,
}: {
  lastRefreshedAt: string | null;
  pollIntervalSec?: number;
  isRefreshing?: boolean;
  hasError?: boolean;
}) {
  if (hasError) {
    return (
      <span className="chip chip-danger chip-mono">
        <WifiOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>stale · refresh failed</span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <Activity
        className={`h-3.5 w-3.5 text-evergreen ${isRefreshing ? "animate-pulse" : ""}`}
        aria-hidden="true"
      />
      <span className="mono text-[11.5px] text-ink-2">
        {isRefreshing ? "refreshing…" : `live · ${pollIntervalSec}s`}
      </span>
      {lastRefreshedAt && (
        <span className="hidden xl:inline">
          <LocalTimestamp iso={lastRefreshedAt} compact />
        </span>
      )}
    </span>
  );
}

export function StaleDataBanner({
  errorMessage,
  lastValidAt,
  onRetry,
}: {
  errorMessage: string;
  lastValidAt: string | null;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#e7d2a4] bg-warn-soft px-4 py-3"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle
          className="mt-0.5 h-4 w-4 shrink-0 text-warn"
          aria-hidden="true"
        />
        <p className="text-xs text-[#6d4e11]">
          <strong>Stale telemetry retained.</strong> Refresh failed ({errorMessage}).
          Showing the last verified payload
          {lastValidAt
            ? ` from ${new Date(lastValidAt).toLocaleTimeString()}`
            : ""}
          .
        </p>
      </div>
      <button type="button" onClick={onRetry} className="btn btn-ghost btn-xs">
        Retry now
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Layout helpers
 * ------------------------------------------------------------------ */
export function Sparkline({
  points,
  label,
  tone = "evergreen",
}: {
  points: number[];
  label: string;
  tone?: "evergreen" | "active" | "danger";
}) {
  if (points.length < 2) return null;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const stroke =
    tone === "danger" ? "#a23f2f" : tone === "active" ? "#2e6f91" : "#1f6b4f";

  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * 100;
      const y = 26 - ((p - min) / span) * 22;
      return `${i === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className="h-7 w-full"
    >
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function MetricCard({
  label,
  href,
  icon,
  value,
  valueNode,
  footnote,
  linkLabel,
  tone = "neutral",
  sparkline,
}: {
  label: string;
  href: string;
  icon: React.ReactNode;
  value?: string | number;
  valueNode?: React.ReactNode;
  footnote: string;
  linkLabel: string;
  tone?: "neutral" | "active" | "danger";
  sparkline?: number[];
}) {
  const valueTone =
    tone === "danger" ? "text-danger" : tone === "active" ? "text-active" : "text-ink";

  return (
    <Link href={href} className="card card-link group flex flex-col p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs font-semibold text-ink-2">{label}</span>
        <span className="shrink-0" aria-hidden="true">
          {icon}
        </span>
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        {valueNode ?? (
          <span className={`num text-3xl font-bold leading-none ${valueTone}`}>
            {value}
          </span>
        )}
        {sparkline && (
          <div className="hidden w-24 shrink-0 sm:block">
            <Sparkline
              points={sparkline}
              label={`${label} trend`}
              tone={tone === "danger" ? "danger" : tone === "active" ? "active" : "evergreen"}
            />
          </div>
        )}
      </div>

      <p className="mono mt-2.5 text-[11.5px] leading-relaxed text-ink-3">
        {footnote}
      </p>

      <span className="mt-3 inline-flex items-center gap-1 border-t border-line pt-2.5 text-[11.5px] font-semibold text-evergreen">
        <span className="group-hover:underline">{linkLabel}</span>
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </Link>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  flush = false,
}: {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="card card-flush" aria-label={title}>
      <div className="panel-head">
        <div className="min-w-0">
          <h2 className="text-[13px] font-bold text-ink">{title}</h2>
          {description && (
            <p className="mt-0.5 text-xs text-ink-2">{description}</p>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        )}
      </div>
      <div className={flush ? "" : "p-4 sm:p-5"}>{children}</div>
    </section>
  );
}

export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <h3 className="text-sm font-bold text-ink">{title}</h3>
      <p className="mx-auto mt-2 max-w-xl text-xs leading-relaxed text-ink-2">
        {description}
      </p>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction} className="btn btn-primary mt-5">
          {actionLabel}
        </button>
      )}
    </div>
  );
}

export function JsonViewer({
  data,
  label,
  maxHeight = "max-h-72",
}: {
  data: unknown;
  label: string;
  maxHeight?: string;
}) {
  const [wrap, setWrap] = useState(true);
  const formatted =
    typeof data === "string" ? data : JSON.stringify(data, null, 2);

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-surface-2">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-3 py-2">
        <span className="text-[11.5px] font-semibold text-ink-2">{label}</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setWrap(!wrap)}
            aria-pressed={wrap}
            aria-label={`Toggle line wrapping for ${label}`}
            className={`btn btn-xs ${wrap ? "chip-ok border" : "btn-ghost"}`}
          >
            <WrapText className="h-3 w-3" aria-hidden="true" />
            <span>Wrap</span>
          </button>
          <CopyButton value={formatted} label="Copy" compact />
        </div>
      </div>
      <pre
        aria-label={label}
        tabIndex={0}
        className={`mono scroll-y p-3 text-[11.5px] leading-relaxed text-ink ${maxHeight} ${
          wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre scroll-x"
        }`}
      >
        {formatted}
      </pre>
    </div>
  );
}

export function SkeletonBlock({ className = "h-28" }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded-xl border border-line bg-surface ${className}`}
      aria-hidden="true"
    />
  );
}
