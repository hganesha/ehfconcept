# POC Harness Control Surface — UI Specification

**Status:** build-ready specification
**Audience:** frontend implementation agent
**Companion:** [Local Harness Runtime POC](./local-runtime-poc.md)
**Visual references:** user-provided `harness.png` and `dash.png`

## 1. Product intent

Build a desktop-first control surface that makes a compiled harness understandable and a running harness inspectable without implying production authority the POC does not possess.

The UI must answer four questions quickly:

1. **What is admitted?** Which immutable plans can be run, with what graph, contract, model tiers, capabilities, effects, and budgets?
2. **What is happening?** Which runs are queued, executing, retrying, completed, denied, or failed?
3. **Why did it happen?** Which nodes executed, what inputs and outputs were accepted, which capability calls were authorized, and where time/cost was spent?
4. **What can I safely do?** Admit a compiled plan, start a run, inspect evidence, repeat a run as a new run, test the gateway, and copy/download artifacts.

This is an engineering/operator surface, not an analyst case-management application.

## 2. Authority and truthfulness rules

- The UI never executes source YAML. It admits and runs only a compiled `HarnessPlan` whose digest verifies.
- Use **Admitted locally**, not **Deployed** or **Released**.
- Use **Completion rate**, not **Success rate**, unless a domain-specific evaluator has actually supplied a success verdict.
- Cost is labeled **Reported cost** and shows **Incomplete** when any provider call omitted cost.
- System health is computed from readiness checks; never hard-code “All systems nominal.”
- A provider credential is shown only as `Configured` or `Missing`. Never return, render, log, or store its value in the browser.
- Provider request/response bodies are redacted according to the runtime record. The UI does not imply chain-of-thought visibility.
- A plan digest, profile digest, execution ID, attempt number, and fencing epoch are visible wherever they explain authority.
- Raw source, mutable configuration, and provider model discovery are not runtime authority.
- Demo data must be visibly labeled `Fixture` when the backend is running in deterministic mode.

## 3. POC information architecture

```text
Overview                 /overview
Harnesses                /harnesses
  Harness detail         /harnesses/:planDigest
Runs                     /runs
  Run detail             /runs/:runId
Capability Gateway       /gateway
System                   /system
```

Do not implement the reference concepts' **Business States** or **Evals** navigation for this POC:

- Business States requires a Case/ledger authority that is explicitly outside the runtime POC.
- Evals requires persisted evaluation runs, thresholds, and attestations that are also outside scope.

The two demo domains may expose terminal run outcomes, but those are not business-system states.

## 4. Application shell

### Left navigation

Retain the concepts' fixed left rail and understated control-plane character.

Order:

1. Overview
2. Harnesses
3. Runs
4. Capability Gateway
5. System

Bottom rail:

- environment: `local`
- runtime mode: `OpenRouter` or `Recorded`
- telemetry freshness: `live · 5s`, `stale · 32s`, or `offline`
- build version and short commit SHA

Do not include a user avatar or admin role in the POC unless authentication is actually implemented.

### Top bar

- page title and optional breadcrumb/path;
- global readiness badge: `Ready`, `Degraded`, or `Unavailable`;
- last successful refresh, not a decorative UTC clock;
- compact counts relevant to the current page;
- manual refresh button with accessible label.

### Global behavior

- Desktop target: 1280 px and above.
- At 960-1279 px, collapse the rail to icons with tooltips.
- Below 960 px, use a drawer; tables may horizontally scroll with the identifying column pinned.
- URL query parameters own search, filters, sorting, and selected time range.
- Poll overview/list views every 5 seconds and an active run detail every 2 seconds. Pause polling when the tab is hidden.
- Preserve the last successful payload during refresh and display a subtle refreshing state.
- Show timestamps in the user's local timezone with the full UTC value in a tooltip.

## 5. Screen specifications

### 5.1 Overview

**Goal:** operational orientation and fast access to current problems.

#### Header metrics

Four cards:

1. **Admitted harnesses** — count of locally admitted plan digests.
2. **Active runs** — queued + running + retrying.
3. **Needs attention** — failed + denied + stale lease.
4. **Reported cost · 24h** — summed complete cost plus an incomplete-data marker when applicable.

Every metric links to its filtered destination. Include the denominator or time window directly in the label.

#### Main content

- **Active runs** table: run ID, harness, current node, status, elapsed time, cost, updated time.
- **Recent issues** list: gateway denial, invalid output, budget exhaustion, stale fencing attempt, worker unavailable.
- **Service status** strip: API, worker, PostgreSQL, Capability Gateway, OpenRouter.
- **Model tiers** compact panel: tier, resolved OpenRouter model, configured/missing, last successful invocation.

#### Empty state

If no plan exists, show one primary action: **Admit compiled plan**. Explain that the UI accepts compiled JSON, not source YAML.

### 5.2 Harnesses

**Goal:** compare admitted immutable plans and open one for inspection or execution.

Use the supplied Harness Registry concept as the visual foundation: two-column cards, graph thumbnail, quiet dividers, compact metrics.

#### Toolbar

- search by harness name or digest;
- domain filter;
- model-tier filter;
- `Admit plan` primary action;
- count: `2 admitted plans`.

#### Harness card

Required fields:

- display name;
- semantic package version;
- domain name;
- short plan digest with copy action;
- immutable status badge: `Admitted locally`;
- objective/description, clamped to two lines;
- static graph thumbnail with primitive shapes and accessible text alternative;
- node count and edge count;
- model tiers used;
- capability count, including effectful count;
- runs in selected window;
- completion rate with numerator and denominator;
- reported mean cost, with incomplete marker;
- p50 duration rather than average latency;
- last run timestamp.

Card actions:

- click card: open detail;
- `Run harness`: opens the run drawer;
- overflow: copy digest, download plan JSON.

Do not place provider model names in the card footer as if they define the harness. Show capability tiers; exact resolved models belong in detail and execution evidence.

#### Admit plan drawer

- JSON file picker and paste area;
- parsed plan name, version, digest, compiler, dependency count;
- digest verification result;
- diagnostics list;
- collision state: same digest already admitted;
- primary action enabled only for a valid compiled plan.

Rejected plans remain client-side and are not listed as admitted.

### 5.3 Harness detail

**Goal:** make the compiled contract legible and start a controlled run.

#### Header

- name, package version, domain;
- full digest with copy action;
- `Admitted locally` and compiler-version badges;
- actions: `Run harness`, `Download plan`, `Copy digest`.

#### Summary strip

- runs · 14d;
- completion rate with `completed / total`;
- reported mean cost and completeness;
- p50 / p95 duration;
- last run.

#### Tabs

**Graph**

- full workflow graph;
- nodes distinguished by shape/icon and label, not color alone;
- selecting a node opens the node inspector;
- legend: input/output, transform/condition, agent/model, tool, evaluate, join/aggregate;
- unsupported primitives should never appear in an admitted plan.

**Contract**

- input and output JSON Schemas;
- terminal outcomes;
- failure policy;
- budgets: duration, model calls, capability calls, cost, retries, concurrency;
- dependency closure with digests.

**Capabilities**

- node-to-capability matrix;
- effect class;
- input/output schema;
- model tier or tool binding;
- timeout/retry limits;
- permission-envelope digest.

**Runs**

- filtered run list for this plan.

#### Node inspector

Show:

- node ID, name, primitive;
- purpose/prompt summary where permitted;
- accepted input and output schema;
- upstream/downstream edges and mappings;
- resolved capability tier or tool binding;
- allowed effects;
- node budgets;
- permission-envelope digest.

Never display provider credentials or unredacted secret-bearing headers.

#### Start-run drawer

- generated form from the plan input JSON Schema;
- toggle between Form and JSON modes;
- client-side schema validation plus authoritative server validation;
- idempotency key generated by the UI, visible under Advanced, stable across safe submission retry;
- execution mode badge: `OpenRouter live` or `Recorded fixture`;
- selected capability tiers, budgets, and possible terminal outcomes;
- primary action: `Start run`.

After acceptance, navigate to the run detail screen.

### 5.4 Runs

**Goal:** find a run by status, harness, time, or identifier.

#### Filters

- search run ID;
- status: queued, running, retrying, completed, manual review, denied, failed, cancelled if supported later;
- harness;
- domain;
- model tier;
- time range: 1h, 24h, 7d, 14d;
- `Only needs attention` toggle.

#### Table

Columns:

- run ID;
- harness and short plan digest;
- status/outcome;
- current or terminal node;
- model tier;
- model calls / capability calls;
- reported cost with completeness;
- duration;
- started;
- updated.

Default sort is most recently updated. Status is always textual and icon-supported, never color-only.

Row expansion may show the last three events, but the main action is opening run detail.

### 5.5 Run detail

**Goal:** explain the run from admission through terminal state.

This is the POC's most important observability screen.

#### Header

- run ID and copy action;
- harness name, plan digest, attempt;
- status and terminal outcome;
- started, elapsed/completed time;
- reported cost and completeness;
- model and capability call counts;
- fixture/live badge.

Allowed actions:

- `Repeat as new run`: opens the start-run drawer prefilled with the prior input and creates a new idempotency key;
- `Download execution record`;
- `Copy run ID`.

Do not implement resume, skip node, edit output, force complete, retry-in-place, or mutate checkpoint controls in the POC.

#### Execution graph

Overlay the plan graph with run state:

- not reached;
- queued;
- executing;
- completed;
- skipped by branch;
- retrying;
- denied;
- failed;
- terminal.

The graph must remain readable without color through icons, stroke styles, and labels. Selecting a node filters the timeline and opens its attempt inspector.

#### Timeline

Chronological events grouped by node attempt:

- run admitted;
- work claimed and lease/fencing epoch;
- node started/completed;
- model request/result;
- capability authorized/denied/result;
- checkpoint committed;
- retry scheduled;
- budget warning/exhaustion;
- terminal reached.

Each row includes sequence, timestamp, code, node, status, duration where known, and expandable structured values. Raw JSON is secondary to a human-readable summary.

#### Attempt inspector

Tabs:

**Summary** — status, timing, retry classification, input/output schema validity.
**Input** — redacted normalized node input.
**Output** — validated output or validation diagnostics.
**Authority** — plan digest, permission-envelope digest, execution-envelope claims, audience, expiry, capability/effect scope, attempt, fencing epoch. Never show the signature or secrets.
**Checkpoint** — engine `langgraph-js`, lowering-adapter version, LangGraph version, thread ID, checkpoint namespace/ID, durability mode, previous checkpoint, and next scheduled nodes. Treat checkpoint payloads as framework state, not business evidence.
**Usage** — tier, exact OpenRouter model, adapter version, provider request ID, parameters, tokens, reported cost, latency.
**Capability calls** — logical capability, adapter binding ID, decision, request/result digest, effect, idempotency key, gateway receipt, denial reason.
**Trace** — durable trace/root-span references, sampling state, exporter availability, and a deep link to the configured trace viewer. Render `telemetry unavailable` separately from `run evidence missing`; the run ledger and gateway receipts remain authoritative.

#### Failure presentation

The failure banner leads with the stable error code and a plain explanation. Show:

- failing node and attempt;
- whether a retry is permitted;
- whether an external effect may have occurred;
- last committed checkpoint;
- suggested operator action that does not bypass policy.

### 5.6 Capability Gateway

**Goal:** show what the runtime is allowed to ask for, how it resolves, and whether the boundary is healthy.

#### Status header

- gateway readiness;
- OpenRouter: configured/missing/unreachable;
- last connection test and latency;
- envelope verifier status;
- calls and denials · 24h.

Primary action: `Test OpenRouter connection`. This tests connectivity/catalog authorization only and does not expose the key.

#### Model tiers

Table:

- tier ID and version;
- purpose;
- profile digest;
- resolved OpenRouter model;
- maximum input/output tokens;
- timeout;
- concurrency limit;
- enabled/disabled;
- last success.

Tier mappings are read-only in the POC and sourced from versioned configuration.

#### Tool capabilities

Table:

- logical capability ID;
- effect class;
- adapter binding ID and version;
- request/result schema versions;
- timeout/retry policy;
- credential state: configured/missing/not required;
- health.

#### Recent decisions

Show gateway authorization and invocation receipts:

- timestamp;
- run and node;
- capability;
- decision: allowed/denied;
- reason code;
- attempt/fencing epoch;
- latency and result status.

Default to denials first when any exist.

### 5.7 System

**Goal:** distinguish an application problem from runtime, persistence, gateway, or provider problems.

Sections:

- component readiness: API, worker, PostgreSQL, gateway, simulator, OpenRouter;
- build metadata: UI, API, runtime, compiler, LangGraph lowering adapter, LangGraph library, PostgreSQL checkpointer, capability adapter versions, and commits;
- queue/work state: ready, leased, retrying, stale;
- telemetry freshness;
- database migration version;
- supported execution-profile primitives;
- known POC limitations.

No restart, reset, migration, secret, or destructive controls are exposed in the UI.

## 6. UI read models and endpoints

The control surface requires read endpoints in addition to the POC's command endpoints.

### Existing command endpoints

- `POST /v1/plans`
- `POST /v1/runs`
- `GET /v1/runs/{id}`
- `GET /health/live`
- `GET /health/ready`

### Required UI query endpoints

- `GET /v1/overview?window=24h`
- `GET /v1/plans?query=&domain=&modelTier=&cursor=`
- `GET /v1/plans/{planDigest}`
- `GET /v1/plans/{planDigest}/runs?cursor=`
- `GET /v1/runs?status=&planDigest=&domain=&modelTier=&from=&to=&cursor=`
- `GET /v1/runs/{runId}/events?afterSequence=`
- `GET /v1/gateway/status`
- `GET /v1/gateway/profiles`
- `GET /v1/gateway/capabilities`
- `GET /v1/gateway/decisions?decision=&cursor=`
- `POST /v1/gateway/openrouter/test`
- `GET /v1/system`

Use cursor pagination. Responses include `generatedAt` and `telemetryFreshThrough` so the UI can express freshness honestly.

### Core view types

```ts
type RunStatus =
  | "queued" | "running" | "retrying"
  | "completed" | "manual_review" | "denied" | "failed";

type CostView = {
  reportedUsd: number;
  complete: boolean;
};

type HarnessSummary = {
  planDigest: string;
  name: string;
  packageVersion: string;
  domain: string;
  objective: string;
  compilerVersion: string;
  nodeCount: number;
  edgeCount: number;
  modelTiers: string[];
  capabilityCount: number;
  effectfulCapabilityCount: number;
  runs: number;
  completedRuns: number;
  meanReportedCost: CostView;
  p50DurationMs: number | null;
  lastRunAt: string | null;
};

type RunSummary = {
  runId: string;
  planDigest: string;
  harnessName: string;
  domain: string;
  status: RunStatus;
  terminalOutcome: string | null;
  currentNodeId: string | null;
  attempt: number;
  modelTiers: string[];
  modelCalls: number;
  capabilityCalls: number;
  cost: CostView;
  durationMs: number | null;
  startedAt: string;
  updatedAt: string;
  fixture: boolean;
  traceId: string | null;
  rootSpanId: string | null;
  traceSampled: boolean | null;
};

type TraceView = {
  traceId: string;
  rootSpanId: string;
  sampled: boolean;
  telemetryAvailable: boolean;
  viewerUrl: string | null;
};

type ExecutionEngineView = {
  kind: "langgraph-js";
  adapterVersion: string;
  libraryVersion: string;
  checkpointerVersion: string;
  threadId: string;
  checkpointNamespace: string;
  latestCheckpointId: string | null;
  durability: "sync";
};

type GatewayDecisionView = {
  receiptId: string;
  occurredAt: string;
  runId: string;
  nodeId: string;
  attempt: number;
  fencingEpoch: number;
  capabilityId: string;
  effect: string;
  decision: "allowed" | "denied";
  reasonCode: string;
  adapterBindingId: string | null;
  latencyMs: number;
  resultStatus: string | null;
  traceId: string | null;
  spanId: string | null;
};
```

The backend remains authoritative for all derived metrics. The browser does not recompute completion, cost, permission, or health judgments from event arrays.

## 7. Required interface states

Every route must implement:

- initial loading skeleton matching final geometry;
- background refresh;
- empty;
- filtered empty;
- partial/degraded data;
- stale telemetry;
- permission/gateway denial;
- server validation error;
- unavailable service;
- pagination loading;
- long IDs and long unbroken diagnostic values;
- missing cost telemetry;
- unknown forward-compatible event code rendered safely as structured data.

Never erase previously loaded operational data because a refresh failed. Mark it stale and show the refresh error.

## 8. Visual language

Follow the supplied concepts closely:

- warm off-white application background;
- white content surfaces;
- deep charcoal primary text;
- restrained evergreen as the primary accent;
- muted sage borders and fills;
- amber for review/warning;
- red only for denial, failure, breached constraints, or destructive implications;
- blue for active execution;
- compact monospace treatment for IDs, digests, durations, costs, and event codes;
- generous spacing, 1 px borders, 8-12 px radii, almost no shadow;
- sparse line graphs and graph diagrams rather than decorative illustration.

Recommended semantic tokens:

```text
bg.canvas          #F7F8F4
bg.surface         #FFFFFF
text.primary       #26312B
text.secondary     #68746D
text.muted         #8A968E
border.default     #DCE4D8
accent.primary     #287A5B
accent.soft        #EDF5EF
status.active      #3E88B5
status.warning     #A67C25
status.danger      #B55245
status.neutral     #6F7B74
```

Use system sans-serif for product text and a readable monospace face for machine data. Typography must remain legible at 100% zoom; metadata should not be smaller than 12 px.

## 9. Accessibility requirements

- WCAG 2.2 AA color contrast for text and controls.
- Complete keyboard navigation with visible focus.
- Skip link to main content.
- Semantic headings, landmarks, tables, and buttons.
- Status never communicated by color alone.
- Graph has a textual node/edge list and keyboard-selectable nodes.
- Sparklines have an accessible label or are hidden when redundant.
- Tooltips are supplementary; critical information is visible without hover.
- Drawers trap focus, close with Escape, and restore focus to their trigger.
- Live run updates use a polite live region and do not steal focus.
- Reduced-motion mode disables animated graph pulses and number transitions.
- JSON/code panes support wrapping, copy, and screen-reader labels.

Screenshot review alone cannot establish accessibility compliance; keyboard and assistive-technology testing are required.

## 10. Component inventory

- `AppShell`, `SideNav`, `TopBar`, `ReadinessBadge`, `FreshnessIndicator`
- `MetricCard`, `StatusBadge`, `CostValue`, `DurationValue`, `DigestValue`
- `HarnessCard`, `WorkflowThumbnail`, `WorkflowGraph`, `GraphLegend`, `NodeInspector`
- `DataTable`, `FilterBar`, `SearchInput`, `PaginationControls`
- `RunStatusBadge`, `RunTimeline`, `TimelineEvent`, `AttemptInspector`
- `CapabilityTable`, `ModelTierTable`, `GatewayDecisionTable`
- `AdmitPlanDrawer`, `StartRunDrawer`, `JsonSchemaForm`, `JsonEditor`
- `DiagnosticList`, `FailureBanner`, `EmptyState`, `StaleDataBanner`
- `JsonViewer`, `CopyButton`, `DownloadButton`

Components must receive typed view models. They must not parse raw database rows or derive authorization decisions.

## 11. POC build order

1. Application shell and semantic tokens.
2. Mock service implementing the exact view types.
3. Harness list and harness detail/graph.
4. Start-run drawer and run creation.
5. Runs list and run detail timeline/attempt inspector.
6. Capability Gateway screen.
7. Overview and System screens.
8. Empty, error, stale, long-content, and accessibility states.
9. Wire to live query endpoints without changing component contracts.

## 12. UI acceptance criteria

The UI is ready for the POC when:

1. An operator can admit a valid compiled plan and cannot admit raw source or a digest-invalid plan.
2. Both demo harnesses render from backend plan data without domain-specific frontend branches.
3. An operator can start both demos from their JSON Schemas.
4. A running workflow visibly advances on the graph and timeline through polling.
5. A failed or denied node exposes its diagnostic, authority context, last checkpoint, and safe next action.
6. A model call shows the requested tier and exact resolved OpenRouter model without exposing credentials.
7. A gateway decision shows capability, effect, envelope scope, attempt, fencing epoch, and reason code.
8. Missing cost telemetry is never displayed as `$0.00` or included silently as complete cost.
9. A worker restart does not create a duplicate node result in the UI; the continued attempt/checkpoint history is understandable.
10. Run detail distinguishes LangGraph continuation checkpoints from stable Harness events and gateway receipts.
11. Parallel node updates and their join are visible without implying an arbitrary serial order.
12. Refresh failures retain and mark stale the last successful data.
13. Keyboard-only use covers navigation, filters, drawers, graph selection, tables, and copy/download actions.
14. No screen claims business-state authority, evaluation certification, deployment, release, or production readiness.

## 13. Notes on the supplied concepts

Keep:

- the calm control-plane visual tone;
- the left rail and simple page headers;
- two-column harness cards;
- graph thumbnails as the primary harness signature;
- compact metrics and monospace operational data;
- restrained semantic color.

Change for the POC:

- replace the decorative UTC clock with data freshness;
- replace ambiguous `Success` with completion plus denominator;
- show model tiers on cards, not provider-specific model names;
- move exact provider/model information into plan/run/gateway detail;
- remove Business States and Evals until their contracts exist;
- add Run Detail and Capability Gateway as first-class observability surfaces;
- raise muted-text contrast and ensure statuses are not color-only;
- avoid `All systems nominal` unless every readiness dependency is actually healthy.

The result should feel like the supplied concepts, but behave like an honest window into the POC's compiled authority and execution evidence.
