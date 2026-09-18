"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  X,
  Upload,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Play,
  FileCode,
  Sliders,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { CompiledHarnessPlan, HarnessSummary } from "@/lib/types";
import { DigestValue } from "./primitives";

type AdmissionCandidate = {
  apiVersion?: string;
  kind?: string;
  planDigest?: string;
  metadata?: { name?: string; version?: string; domain?: string };
  compiler?: { name?: string; version?: string; lgirCoreRevision?: string };
  graph?: { nodes?: unknown[] };
  dependencyManifest?: unknown[];
};

/* ------------------------------------------------------------------ *
 * Shared drawer chrome: full-screen on mobile, side panel on desktop
 * ------------------------------------------------------------------ */
function DrawerShell({
  titleId,
  onClose,
  header,
  footer,
  closeRef,
  children,
}: {
  titleId: string;
  onClose: () => void;
  header: React.ReactNode;
  footer: React.ReactNode;
  closeRef: React.RefObject<HTMLButtonElement | null>;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <button
        type="button"
        aria-label="Close drawer overlay"
        onClick={onClose}
        className="absolute inset-0 bg-[#222d27]/45"
      />
      <div className="relative flex h-full w-full flex-col border-line bg-surface shadow-2xl sm:max-w-2xl sm:border-l">
        <div className="flex items-start justify-between gap-3 border-b border-line bg-surface-2 px-4 py-3.5 sm:px-6 sm:py-4">
          <div className="min-w-0">{header}</div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close drawer"
            className="shrink-0 rounded-lg p-2 text-ink-2 hover:bg-mint hover:text-ink"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="scroll-y flex-1 space-y-5 px-4 py-5 sm:px-6">{children}</div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2 px-4 py-3.5 sm:px-6 sm:py-4">
          {footer}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Admit compiled plan
 * ------------------------------------------------------------------ */
export function AdmitPlanDrawer({
  isOpen,
  onClose,
  existingDigests,
  onAdmitted,
}: {
  isOpen: boolean;
  onClose: () => void;
  existingDigests: string[];
  onAdmitted: (summary?: HarnessSummary) => void;
}) {
  const [rawInput, setRawInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string[] | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    closeBtnRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const trimmed = rawInput.trim();
  const isYaml =
    trimmed.startsWith("apiVersion:") ||
    trimmed.startsWith("kind:") ||
    trimmed.startsWith("name:") ||
    (!trimmed.startsWith("{") && trimmed.includes(":"));

  let parsed: AdmissionCandidate | null = null;
  let parseError: string | null = null;

  if (isYaml) {
    parseError =
      "Source YAML detected. This surface admits only compiled HarnessPlan JSON whose SHA-256 digest verifies.";
  } else if (trimmed.length > 0) {
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      parseError = `Invalid JSON syntax: ${
        e instanceof Error ? e.message : "unable to parse"
      }`;
    }
  }

  const diagnostics: string[] = [];
  let digestValid = false;
  let isCollision = false;

  if (parseError) {
    diagnostics.push(parseError);
  } else if (parsed) {
    if (parsed.apiVersion !== "harness.factory/plan-v1" || parsed.kind !== "HarnessPlan") {
      diagnostics.push(
        `Invalid contract. Expected apiVersion "harness.factory/plan-v1" and kind "HarnessPlan".`
      );
    }
    if (
      typeof parsed.planDigest === "string" &&
      /^[a-f0-9]{64}$/.test(parsed.planDigest)
    ) {
      digestValid = true;
      if (existingDigests.includes(parsed.planDigest)) {
        isCollision = true;
        diagnostics.push(
          `Collision: plan digest ${parsed.planDigest.slice(
            0,
            20
          )}… is already admitted locally.`
        );
      }
    } else {
      diagnostics.push(
        "Digest verification failed: planDigest must be a 64-character hex SHA-256 digest."
      );
    }
    if (!Array.isArray(parsed.graph?.nodes) || parsed.graph.nodes.length === 0) {
      diagnostics.push("A compiled plan must contain at least one primitive node.");
    }
  }

  const canAdmit =
    Boolean(parsed) && !parseError && digestValid && !isCollision && diagnostics.length === 0;

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      setRawInput(String(ev.target?.result || ""));
      setServerError(null);
    };
    reader.readAsText(file);
  };

  const handleSubmit = async () => {
    if (!canAdmit) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const res = await fetch("/v1/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawPlan: rawInput }),
      });
      const data = await res.json();
      if (!res.ok || !data.admitted) {
        setServerError(data.diagnostics || ["Failed to admit compiled plan."]);
      } else {
        onAdmitted(data.summary);
        onClose();
      }
    } catch (err) {
      setServerError([err instanceof Error ? err.message : "Network error admitting plan"]);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DrawerShell
      titleId="admit-plan-title"
      onClose={onClose}
      closeRef={closeBtnRef}
      header={
        <>
          <h2 id="admit-plan-title" className="text-sm font-bold text-ink sm:text-base">
            Admit compiled HarnessPlan
          </h2>
          <p className="mt-0.5 text-xs text-ink-2">
            Admits an immutable, content-addressed{" "}
            <code className="mono">harness.factory/plan-v1</code> artifact. Source YAML is
            never executed.
          </p>
        </>
      }
      footer={
        <>
          <span className="mr-auto hidden text-[11.5px] text-ink-2 sm:inline">
            Resulting status: <strong className="text-ink">Admitted locally</strong>
          </span>
          <button type="button" onClick={onClose} className="btn btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            disabled={!canAdmit || submitting}
            onClick={handleSubmit}
            className="btn btn-primary"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            <span>{submitting ? "Verifying…" : "Admit compiled plan"}</span>
          </button>
        </>
      }
    >
      {/* Presets + file picker */}
      <div className="flex flex-col gap-2.5">
        <span className="eyebrow">Load artifact</span>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setRawInput(
                "apiVersion: harness.io/v1alpha1\nkind: SourceWorkflow\nname: uncompiled-source-yaml\nsteps:\n  - run: llm_prompt"
              );
              setServerError(null);
            }}
            className="btn btn-ghost btn-xs text-danger"
          >
            Source YAML rejection
          </button>
          <label className="btn btn-ghost btn-xs cursor-pointer">
            <Upload className="h-3.5 w-3.5 text-ink-3" aria-hidden="true" />
            <span>Upload .json</span>
            <input
              type="file"
              accept=".json,application/json"
              onChange={handleFileUpload}
              className="sr-only"
            />
          </label>
        </div>
      </div>

      {/* Paste area */}
      <div>
        <label htmlFor="compiled-plan-json" className="mb-1.5 block text-xs font-bold text-ink">
          Compiled plan JSON payload
        </label>
        <textarea
          id="compiled-plan-json"
          rows={10}
          value={rawInput}
          onChange={(e) => {
            setRawInput(e.target.value);
            setServerError(null);
          }}
          className="field mono min-h-[12rem] resize-y leading-relaxed"
          placeholder='Paste compiled HarnessPlan JSON ("apiVersion": "harness.factory/plan-v1")…'
        />
      </div>

      {/* Verification result */}
      <div className="rounded-xl border border-line bg-surface-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="eyebrow">Digest verification</span>
          {canAdmit ? (
            <span className="chip chip-ok">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Verified · ready to admit</span>
            </span>
          ) : isCollision ? (
            <span className="chip chip-warn">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Already admitted locally</span>
            </span>
          ) : (
            <span className="chip chip-danger">
              <XCircle className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Rejected · stays client-side</span>
            </span>
          )}
        </div>

        {parsed && !parseError && (
          <dl className="mt-3 grid grid-cols-1 gap-3 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                Plan name
              </dt>
              <dd className="mt-0.5 text-xs font-bold text-ink">{parsed.metadata?.name || "—"}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                Version · domain
              </dt>
              <dd className="mono mt-0.5 text-xs text-ink">
                v{parsed.metadata?.version || "—"} · {parsed.metadata?.domain || "—"}
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                Plan content digest
              </dt>
              <dd className="mt-1">
                {parsed.planDigest ? (
                  <DigestValue digest={parsed.planDigest} full showCopy={false} />
                ) : (
                  <span className="text-xs text-danger">Missing planDigest</span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                Compiler
              </dt>
              <dd className="mono break-anywhere mt-0.5 text-xs text-ink">
                {parsed.compiler ? `${parsed.compiler.name || "harnessc"} ${parsed.compiler.version || "—"}` : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
                Topology · dependencies
              </dt>
              <dd className="mono mt-0.5 text-xs text-ink">
                {Array.isArray(parsed.graph?.nodes) ? parsed.graph.nodes.length : 0} nodes ·{" "}
                {Array.isArray(parsed.dependencyManifest) ? parsed.dependencyManifest.length : 0} locked
              </dd>
            </div>
          </dl>
        )}

        {(diagnostics.length > 0 || (serverError && serverError.length > 0)) && (
          <div className="mt-3 space-y-1.5">
            <span className="text-xs font-bold text-danger">Diagnostics</span>
            <ul className="space-y-1.5">
              {[...diagnostics, ...(serverError || [])].map((diag, i) => (
                <li
                  key={i}
                  className="mono flex items-start gap-2 rounded-lg border border-[#e7b9b1] bg-danger-soft px-3 py-2 text-[11.5px] text-danger"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="break-anywhere">{diag}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </DrawerShell>
  );
}

/* ------------------------------------------------------------------ *
 * Start run
 * ------------------------------------------------------------------ */
export function StartRunDrawer({
  isOpen,
  onClose,
  plan,
  prefillInput,
  runtimeMode = "Recorded",
  onRunStarted,
}: {
  isOpen: boolean;
  onClose: () => void;
  plan: CompiledHarnessPlan | null;
  prefillInput?: Record<string, unknown> | null;
  runtimeMode?: "OpenRouter" | "Recorded";
  onRunStarted: (runId: string) => void;
}) {
  const [mode, setMode] = useState<"form" | "json">("form");
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [jsonText, setJsonText] = useState("{}");
  const [idempotencyKey, setIdempotencyKey] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const initializedPlanRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen || !plan) {
      initializedPlanRef.current = null;
      return;
    }
    if (initializedPlanRef.current === plan.planDigest) return;
    initializedPlanRef.current = plan.planDigest;
    closeBtnRef.current?.focus();

    const defaults: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(plan.inputSchema.properties || {})) {
      defaults[key] =
        prefillInput && prefillInput[key] !== undefined
          ? prefillInput[key]
          : prop.default ?? "";
    }
    setFormValues(defaults);
    setJsonText(JSON.stringify(defaults, null, 2));
    setIdempotencyKey(
      `idem-${plan.domain.slice(0, 6)}-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`
    );
    setErrors([]);
  }, [isOpen, plan, prefillInput]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !plan) return null;

  const modelTiers = Array.from(
    new Set(plan.nodes.map((n) => n.modelTier).filter(Boolean) as string[])
  );

  const validateAndSubmit = async () => {
    setErrors([]);
    let payload: Record<string, unknown> = {};

    if (mode === "json") {
      try {
        payload = JSON.parse(jsonText);
      } catch (e) {
        setErrors([
          `Client JSON syntax error: ${e instanceof Error ? e.message : "invalid JSON"}`,
        ]);
        return;
      }
    } else {
      payload = { ...formValues };
    }

    const clientErrs: string[] = [];
    for (const reqKey of plan.inputSchema.required || []) {
      if (
        payload[reqKey] === undefined ||
        payload[reqKey] === null ||
        String(payload[reqKey]).trim() === ""
      ) {
        clientErrs.push(`Required property "${reqKey}" must not be empty.`);
      }
    }
    if (clientErrs.length > 0) {
      setErrors(clientErrs);
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/v1/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          planDigest: plan.planDigest,
          inputPayload: payload,
          idempotencyKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrors(data.validationErrors || ["Server validation rejected this input."]);
      } else {
        onRunStarted(data.runId);
        onClose();
      }
    } catch (err) {
      setErrors([err instanceof Error ? err.message : "Failed to submit run request"]);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DrawerShell
      titleId="start-run-title"
      onClose={onClose}
      closeRef={closeBtnRef}
      header={
        <>
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="start-run-title" className="text-sm font-bold text-ink sm:text-base">
              Start run · {plan.name}
            </h2>
            <span className="chip chip-ok chip-mono">
              {runtimeMode === "OpenRouter" ? "OpenRouter live" : "Recorded fixture"}
            </span>
          </div>
          <p className="mono mt-0.5 break-anywhere text-[11.5px] text-ink-3">
            {plan.planDigest.slice(0, 32)}…
          </p>
        </>
      }
      footer={
        <>
          <button type="button" onClick={onClose} className="btn btn-ghost">
            Cancel
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={validateAndSubmit}
            className="btn btn-primary"
          >
            <Play className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{submitting ? "Admitting run…" : "Start run"}</span>
          </button>
        </>
      }
    >
      {/* Mode toggle */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <span className="text-xs font-bold text-ink">
          Input contract · {Object.keys(plan.inputSchema.properties).length} fields
        </span>
        <div className="seg" role="group" aria-label="Input editing mode">
          <button
            type="button"
            data-active={mode === "form"}
            aria-pressed={mode === "form"}
            onClick={() => {
              setMode("form");
              try {
                setFormValues(JSON.parse(jsonText));
              } catch {
                /* keep current values */
              }
            }}
            className="seg-item inline-flex items-center gap-1"
          >
            <Sliders className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Form</span>
          </button>
          <button
            type="button"
            data-active={mode === "json"}
            aria-pressed={mode === "json"}
            onClick={() => {
              setMode("json");
              setJsonText(JSON.stringify(formValues, null, 2));
            }}
            className="seg-item inline-flex items-center gap-1"
          >
            <FileCode className="h-3.5 w-3.5" aria-hidden="true" />
            <span>JSON</span>
          </button>
        </div>
      </div>

      {/* Generated schema form / JSON editor */}
      {mode === "form" ? (
        <div className="space-y-4">
          {Object.entries(plan.inputSchema.properties).map(([key, prop]) => {
            const isRequired = plan.inputSchema.required?.includes(key);
            const val = formValues[key] ?? "";
            return (
              <div key={key}>
                <label htmlFor={`field-${key}`} className="block text-xs font-bold text-ink">
                  {prop.title || key}{" "}
                  <span className="mono font-normal text-ink-3">({prop.type})</span>
                  {isRequired && (
                    <span className="ml-1 text-danger" aria-hidden="true">
                      *
                    </span>
                  )}
                </label>
                {prop.description && (
                  <p className="mt-0.5 mb-1.5 text-[11.5px] leading-relaxed text-ink-2">
                    {prop.description}
                  </p>
                )}
                {prop.enum ? (
                  <select
                    id={`field-${key}`}
                    value={String(val)}
                    onChange={(e) => setFormValues({ ...formValues, [key]: e.target.value })}
                    className="field"
                  >
                    {prop.enum.map((opt) => (
                      <option key={opt} value={opt}>
                        {opt}
                      </option>
                    ))}
                  </select>
                ) : prop.type === "number" || prop.type === "integer" ? (
                  <input
                    id={`field-${key}`}
                    type="number"
                    value={String(val)}
                    onChange={(e) =>
                      setFormValues({
                        ...formValues,
                        [key]: e.target.value === "" ? "" : Number(e.target.value),
                      })
                    }
                    className="field mono"
                  />
                ) : (
                  <input
                    id={`field-${key}`}
                    type="text"
                    value={String(val)}
                    onChange={(e) => setFormValues({ ...formValues, [key]: e.target.value })}
                    className="field"
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div>
          <label htmlFor="run-json-editor" className="mb-1.5 block text-xs font-bold text-ink">
            Raw input JSON payload
          </label>
          <textarea
            id="run-json-editor"
            rows={10}
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            className="field mono min-h-[12rem] resize-y leading-relaxed"
          />
        </div>
      )}

      {errors.length > 0 && (
        <div className="rounded-lg border border-[#e7b9b1] bg-danger-soft p-3">
          <p className="text-xs font-bold text-danger">Schema validation diagnostics</p>
          <ul className="mono mt-1.5 list-disc space-y-1 pl-4 text-[11.5px] text-danger">
            {errors.map((err, i) => (
              <li key={i} className="break-anywhere">
                {err}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Bound constraints */}
      <div className="rounded-xl border border-line bg-surface-2 p-4">
        <span className="eyebrow">Bound execution constraints</span>
        <dl className="mt-2.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              Capability tiers
            </dt>
            <dd className="mono mt-0.5 text-xs font-semibold text-ink">
              {modelTiers.join(", ") || "none"}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
              Budgets
            </dt>
            <dd className="mono mt-0.5 text-xs font-semibold text-ink">
              ≤ ${plan.budgets.maxCostUsd.toFixed(2)} · ≤{" "}
              {plan.budgets.maxDurationMs / 1000}s · {plan.budgets.maxModelCalls} model calls
            </dd>
          </div>
        </dl>
        <div className="mt-3">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            Possible terminal outcomes
          </span>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {plan.terminalOutcomes.map((o) => (
              <span key={o.code} className="chip chip-mono">
                {o.code}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Advanced */}
      <div className="border-t border-line pt-3">
        <button
          type="button"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="inline-flex items-center gap-1 text-xs font-semibold text-ink-2 hover:text-ink"
        >
          {showAdvanced ? (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          <span>Advanced · idempotency</span>
        </button>
        {showAdvanced && (
          <div className="mt-2.5 rounded-lg border border-line bg-surface-2 p-3">
            <label htmlFor="idem-key-input" className="block text-xs font-bold text-ink">
              Client idempotency key
            </label>
            <input
              id="idem-key-input"
              type="text"
              value={idempotencyKey}
              onChange={(e) => setIdempotencyKey(e.target.value)}
              className="field mono mt-1.5"
            />
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-2">
              Stable across safe submission retry. Repeating a run always generates a fresh
              key.
            </p>
          </div>
        )}
      </div>
    </DrawerShell>
  );
}
