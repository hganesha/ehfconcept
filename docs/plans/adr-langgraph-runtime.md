# ADR: LangGraph.js as the POC Execution State Machine

**Status:** accepted for POC
**Date:** 2026-09-17
**Companion plan:** [Local Harness Runtime POC](./local-runtime-poc.md)

## Decision

Use LangGraph.js `StateGraph` as the state-machine and checkpoint execution substrate for the POC.

Keep these authority boundaries:

- `DomainPackage` and LGIR remain the human-authored source contracts.
- The Rust compiler remains the only authority that validates source and emits an immutable `HarnessPlan`.
- A versioned lowering adapter translates an admitted `HarnessPlan` into a LangGraph.js graph.
- LangGraph owns node scheduling, conditional routing, parallel supersteps, and execution checkpoints.
- The Capability Gateway owns model/tool authorization, provider credentials, adapter routing, and invocation receipts.
- PostgreSQL run, attempt, event, gateway-receipt, lease, and fencing records remain the operational/audit read model.
- LangGraph state never becomes domain business truth.

```text
DomainPackage + LGIR
      |
      v
Rust harness compiler
      |
      v
immutable HarnessPlan + digest
      |
      v
versioned LangGraph lowering adapter
      |
      v
LangGraph.js StateGraph + PostgreSQL checkpointer
      |
      +---- model/tool node wrapper ---- Capability Gateway ---- OpenRouter/adapters
      |
      +---- event/checkpoint projection ---- Run ledger/UI
```

## Why

LangGraph provides the mechanics the POC otherwise needs to build and maintain:

- explicit state and node boundaries;
- fixed and conditional graph routing;
- parallel branches with reducer-controlled state updates;
- retry policies around individual nodes;
- checkpoint persistence at node boundaries;
- restart/resume using a stable thread ID;
- a later path to human interrupts and subgraphs.

The existing Ladder Graph design already documents a safe LGIR-to-LangGraph mapping. Harness Factory also has a LangGraph topology exporter and tests. Those are useful inputs, but neither is currently a complete governed runtime.

## What LangGraph does not replace

LangGraph is not:

- the HarnessSpec or HarnessPlan format;
- the compiler or graph-policy validator;
- a capability registry;
- an authorization boundary;
- a credential broker;
- an idempotency guarantee for external effects;
- the canonical run/evidence ledger;
- a Case or domain-state store;
- a release/signing/revocation system.

All model and tool nodes call the Capability Gateway through runtime-owned wrappers. Domain code cannot instantiate provider SDKs or call OpenRouter directly.

## Runtime language and packages

Use TypeScript/Node to align with Harness Factory's existing runtime and OpenRouter adapter.

Pin exact versions of:

- `@langchain/langgraph`;
- `@langchain/core`;
- `@langchain/langgraph-checkpoint-postgres`;
- the lowering adapter package implemented by this POC.

Record all four versions in the execution record and System UI.

Do not use LangGraph Agent Server or LangSmith as a required POC component. Invoke compiled graphs inside the existing runtime worker and persist checkpoints directly to local PostgreSQL.

## Compiled-plan additions

The `HarnessPlan` execution section contains:

```json
{
  "engine": {
    "kind": "langgraph-js",
    "adapterVersion": "harness-langgraph-v1",
    "profile": "poc-v1"
  },
  "maxTransitions": 64,
  "maxConcurrency": 4,
  "durability": "sync"
}
```

The engine adapter version participates in the canonical plan digest. The LangGraph library version is recorded in build and execution provenance but does not silently change plan semantics; a semantic lowering change requires a new adapter version and recompilation.

## State contract

Use one generated `StateSchema` shared across compiled POC graphs. Keep it JSON-compatible and free of secrets.

```ts
type HarnessGraphState = {
  runInput: unknown;
  nodeOutputs: Record<string, unknown>;
  routes: Record<string, string>;
  loopIterations: Record<string, number>;
  nodeErrors: Record<string, NodeErrorEnvelope>;
  terminal: null | "completed" | "manual_review" | "denied" | "failed";
  output: unknown;
};
```

Rules:

- store raw structured values, not rendered prompts;
- merge concurrent node updates through deterministic map reducers;
- one node may write only its own output/error key;
- secrets, API keys, bearer tokens, and provider headers are prohibited;
- large artifacts are represented by digest-addressed references once artifact storage exists;
- every state value must pass its compiled schema before it is checkpointed.

## Deterministic lowering profile

The lowering adapter consumes only a validated `HarnessPlan`. It cannot reinterpret source YAML.

| Plan primitive | LangGraph lowering | POC status |
|---|---|---|
| input | initialization node reached from `START` | supported |
| output | terminal projection followed by `END` | supported |
| agent/model | wrapper calling the gateway model capability | supported |
| tool | wrapper calling a declared gateway capability | supported |
| evaluate/validator | deterministic or gateway-backed wrapper | supported |
| transform | generated deterministic node for allowlisted operations | supported |
| condition | generated router plus `addConditionalEdges` path map | supported |
| fan-out | multiple outgoing edges | supported |
| join all | all-source waiting edge/barrier | supported |
| join allSettled | typed result/error envelopes followed by barrier | supported for declared nodes |
| aggregator | generated deterministic collect/merge/concat/vote node | supported |
| bounded loop | conditional back-edge plus compiler-managed iteration counter | deferred unless a demo requires it |
| approval/interrupt | `interrupt()` plus resume command | deferred from POC |
| join first | race/cancellation semantics | rejected |
| group | explicit lowering | rejected initially |
| subgraph | compiled child graph with state mapping | rejected initially |
| teacher | ordinary handler only after explicit semantics | rejected initially |

Unsupported constructs fail compilation with stable target-profile diagnostics. They are never flattened or approximated.

## Node wrapper contract

Every effectful LangGraph node is created by the runtime, not supplied by a domain package.

The wrapper:

1. verifies the run lease and current fencing epoch;
2. reads the node's compiled permission envelope;
3. validates and minimizes node input;
4. creates a stable node-attempt and gateway idempotency key;
5. mints a short-lived execution envelope;
6. calls the Capability Gateway;
7. validates the normalized result schema;
8. writes an invocation receipt and runtime event idempotently;
9. returns a state update scoped to the node's own key.

Gateway idempotency identity:

```text
planDigest : runId : nodeId : logicalAttempt : capabilityId
```

Retries of the same logical node attempt reuse this identity. A deliberate new run or policy-directed new attempt receives a new identity.

## Persistence and restart behavior

Use `PostgresSaver` with one LangGraph thread per runtime run:

```text
thread_id      = runId
checkpoint_ns  = "" for the root graph (LangGraph reserves namespaces for subgraphs)
run.planDigest = planDigest (the authoritative plan/checkpoint binding)
```

Initialize checkpointer tables through an explicit migration/setup step. Do not make table creation a normal request-path responsibility.

Use synchronous durability for the POC so a node boundary is not reported committed before its checkpoint is durable. Revisit asynchronous durability only after fault testing.

PostgreSQL contains two related but separate record sets:

1. **LangGraph checkpoints** — opaque execution continuation state owned by the pinned checkpointer package.
2. **Harness run ledger** — stable application records used for idempotency, audit, metrics, UI, and future portability away from LangGraph.

The runtime records the latest checkpoint ID on each committed node attempt. A reconciliation process can project missing UI events from checkpoint metadata after a crash.

## Lease and fencing

LangGraph checkpointing does not replace worker ownership.

- The worker must acquire a PostgreSQL run lease before invoking/resuming a graph.
- A lease acquisition increments the fencing epoch.
- Every gateway execution envelope contains that epoch.
- The gateway checks the current epoch immediately before provider invocation.
- The run ledger checks it again before accepting a result.
- A stale worker may finish local computation but cannot invoke a capability or commit an accepted result.

This prevents two workers from legitimately resuming the same run concurrently.

## Events and observability

LangGraph streaming/checkpoint metadata is adapted into stable Harness runtime events. UI contracts consume Harness events, not framework-private event shapes.

Record at minimum:

- graph invocation/resumption;
- checkpoint committed;
- node scheduled/started/completed/skipped/retrying/failed;
- route selected;
- capability requested/allowed/denied/completed;
- budget reserved/reconciled/exhausted;
- terminal reached.

Each node attempt records `threadId`, `checkpointId`, `checkpointNamespace`, engine adapter version, LangGraph version, attempt, and fencing epoch.

The POC emits one W3C OpenTelemetry trace for each harness run attempt and preserves the same trace across a fenced retry by parenting the new attempt span to the durable run trace reference. Manual semantic spans are `harness.run`, `workflow.transition`, `capability.request`, `capability.invoke`, `authorization.evaluate`, `model.inference`, and `tool.execution`. Runtime-to-gateway HTTP carries `traceparent`; trace context conveys no authority. Run, node-attempt, and gateway-receipt records retain trace/span references independently of export or sampling. Attribute values follow the telemetry allowlist: operational IDs and digest prefixes are permitted; case payloads, prompts, responses, tokens, credentials, and raw exception messages are prohibited.

## Failure and retry policy

- Transient provider/network failures use a bounded LangGraph node retry policy derived from the compiled plan.
- Schema, authorization, unknown capability, effect, and budget errors do not retry automatically.
- Provider output that fails schema validation is a typed node failure; any repair loop must be explicit in the plan.
- Gateway denial is terminal for that node attempt and routes only through a declared failure path.
- Runtime bugs bubble out, mark the run failed, and preserve the last durable checkpoint.

Because a failed node can restart from its beginning, external calls must remain idempotent through the gateway receipt journal. LangGraph checkpointing alone is not sufficient protection from duplicate effects.

## Compiler conformance requirements

For each accepted fixture, tests assert:

- deterministic plan bytes and digest;
- deterministic lowering topology for the same plan and adapter version;
- exact supported/rejected primitive diagnostics;
- declared branch tokens equal generated router paths;
- parallel state updates merge without key loss;
- joins wait for the declared upstream set;
- node wrappers cannot call an undeclared capability;
- no source string becomes evaluated JavaScript;
- all state is JSON-compatible and schema-valid.

The existing Harness Factory interpreter/conformance suite becomes a semantic oracle during migration. For the POC profile, the legacy interpreter and LangGraph adapter must produce equivalent terminal outcomes, node outputs, selected branches, and stable Harness event meanings on shared deterministic fixtures. The legacy interpreter is removed from the POC runtime once parity passes.

## Fault acceptance tests

The LangGraph-based POC is credible only if these pass:

1. Kill the worker after a completed model/tool receipt but before the next node; restart resumes without a second provider call.
2. Kill the worker during a provider call; retry uses the same gateway idempotency identity.
3. Expire the worker lease while it is executing; its gateway call or result commit is rejected by fencing.
4. Start two workers against the same queued run; only one acquires authority.
5. Fail PostgreSQL checkpoint writes; the UI never reports the node committed.
6. Return two parallel node updates; both survive the reducer merge.
7. Return malformed model/tool output; the checkpoint retains the previous valid state and the node fails visibly.
8. Change the lowering adapter version; the plan digest changes and old plans continue to resolve only through their pinned adapter.

## Consequences

### Benefits

- less custom scheduler/checkpoint code;
- real parallel graph execution instead of simulated readiness order;
- clear path to later approvals, interrupts, and subgraphs;
- checkpoint history can strengthen the observability UI;
- TypeScript alignment with the existing Harness Factory runtime and OpenRouter integration.

### Costs and risks

- a framework dependency becomes part of runtime compatibility;
- LGIR-to-LangGraph semantic parity requires strict tests;
- LangGraph checkpoint tables are framework-owned and cannot be the product audit schema;
- retries/restarts can repeat node bodies, so gateway idempotency remains mandatory;
- unsupported LGIR constructs must be rejected until their lowering is proven;
- future LangGraph upgrades require replay of conformance and fault suites.

## Rejected alternatives

**Use generated Python LangGraph modules as runtime authority.** Rejected because the current exporter is a scaffold with handler stubs, the working application stack is TypeScript, and generated code would complicate plan identity and deployment.

**Replace LGIR/HarnessPlan with handwritten LangGraph code.** Rejected because executable code would bypass deterministic compilation, permission derivation, capability qualification, and portable domain packages.

**Use LangGraph Agent Server/LangSmith as the required runtime.** Rejected for the local-first POC because it adds a deployment/control-plane dependency. The core graph library and PostgreSQL checkpointer are sufficient.

**Keep the custom Harness Factory interpreter as the POC engine.** Rejected as the primary path because it duplicates scheduler/durability mechanics and currently executes ready nodes sequentially. It remains a semantic reference during adapter conformance.
