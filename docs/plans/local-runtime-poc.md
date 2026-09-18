# Local Harness Runtime POC

**Status:** proposed implementation scope
**Purpose:** prove that a generic runtime can execute a compiled, domain-defined harness locally in Docker, without creating a throwaway path to the Azure architecture.

## 1. Recommendation

Build a narrow vertical slice in this repository. Keep the compiler/runtime independently headless, then place a thin visibility, observability, and control UI over their HTTP contracts:

```text
versioned domain package
  -> authoritative compiler
  -> immutable HarnessPlan + digest
  -> versioned LangGraph.js lowering adapter
  -> durable StateGraph runtime
  -> Capability Gateway and adapters
  -> recorded result and execution evidence
```

The POC should prove five claims:

1. A domain team can define behavior without changing runtime code.
2. Compilation is deterministic and rejects unsafe or unresolved authority.
3. The runtime executes only a compiled plan, never source YAML.
4. A run survives worker restart and does not duplicate a completed node effect.
5. The same containers and contracts can move to Azure by replacing infrastructure adapters, not business logic.

This is a **runtime and contract POC**, not a miniature production platform. Do not include a design studio, natural-language harness generation, full KYC, enterprise identity, signed releases, or Azure infrastructure in this slice.

## 2. POC boundary

### In scope

- A versioned `DomainPackage` layout with:
  - package and harness manifests;
  - one Ladder Graph workflow;
  - agent, tool, policy, and JSON Schema definitions;
  - deterministic fixtures and expected outcomes.
- A Rust `harnessc` compiler that:
  - safely parses the package;
  - delegates graph validation and normalization to Ladder Graph `lgir-core`;
  - resolves local references to immutable content digests;
  - derives a node-level permission envelope;
  - checks graph, budget, capability, schema, and effect rules;
  - emits canonical `HarnessPlan` JSON, diagnostics, dependency manifest, and SHA-256 digest.
- A generic TypeScript runtime that:
  - accepts only a compiled plan and typed run input;
  - deterministically lowers the supported plan profile into a LangGraph.js `StateGraph`;
  - uses the PostgreSQL LangGraph checkpointer at node boundaries;
  - invokes every model and tool interface through the Capability Gateway;
  - enforces node permissions, deadlines, call limits, cost limits, and effect policy;
  - persists framework checkpoints separately from stable Harness node attempts, events, outputs, gateway receipts, and failure details.
- PostgreSQL-backed run durability with leases, fencing epochs, and idempotency keys.
- A small HTTP control API and a separate worker process.
- A thin operator control surface, specified separately in [`poc-control-surface-ui-spec.md`](./poc-control-surface-ui-spec.md), for admitted plans, run inspection, gateway visibility, health, plan admission, and run start.
- Docker Compose for `api`, `worker`, `capability-gateway`, `postgres`, and deterministic capability simulators.
- A basic Capability Gateway and credential boundary:
  - the runtime calls capabilities by logical ID, never by provider URL;
  - LLM inference is exposed as a provider-neutral capability such as `model.reasoning.standard`, not as an OpenRouter-specific call;
  - each call carries a short-lived signed execution envelope scoped to one run, node, plan digest, capability set, effect set, deadline, and fencing epoch;
  - the gateway validates the envelope and compiled permission envelope before routing;
  - provider credentials remain gateway-owned and are never returned to the runtime or embedded in a plan.
- Two domain packages executed by the same runtime with no runtime branching:
  - `kyc-screening-demo`: validate input, run simulated sanctions and PEP checks, aggregate, evaluate, and route to `clear`, `manual_review`, or `failed`;
  - `invoice-review-demo`: validate invoice input, call simulated vendor and purchase-order tools, compare values, and route to `matched`, `manual_review`, or `failed`.
- A conformance suite and one-command demo.

### Explicitly out of scope

- Full KYC lifecycle, real sanctions providers, real customer data, or legal/policy completeness.
- Harness authoring UI, Ladder Graph editor integration, visual workflow editing, or natural-language generation. The POC control surface is an observer and safe command client, not an authoring environment.
- Supabase Auth, multi-tenant administration, analyst UI, and human task management.
- Production release signing, approval chains, registry pointers, revocation distribution, and evaluation attestations.
- Service Bus, APIM, Blob, Foundry hosted agents, Azure networking, Bicep, and disaster recovery.
- Arbitrary MCP servers, arbitrary code execution, user-supplied container images, and runtime-loaded plugins.
- Distributed parallel execution, subgraphs, event-driven triggers, migrations of in-flight plans, and automatic business writes.

These are deferred behind contracts, not mocked into the core.

## 3. Source and compiled contracts

### Domain package

```text
domains/<domain>/
  package.yaml
  harness.yaml
  workflows/main.yaml
  agents/*.yaml
  tools/*.yaml
  policies/*.yaml
  schemas/*.json
  fixtures/*.json
  expected/*.json
```

`harness.yaml` expresses intent and references package-local objects. It cannot contain scripts, secrets, network locations, mutable tags, or environment interpolation.

Minimal source fields:

- identity: name, semantic version, owner, risk class;
- workflow reference;
- input and output schema references;
- declared capabilities and tool bindings;
- effect class for each capability;
- model profile aliases, never provider credentials;
- run and per-node budgets;
- terminal outcomes and failure policy.

### Compiled HarnessPlan

The compiler emits a fully resolved plan containing:

- schema and compiler versions;
- package, source, workflow, schema, agent, policy, and tool digests;
- normalized executable graph;
- concrete adapter binding IDs;
- node-level permission envelopes;
- input/output schemas embedded or addressed by digest;
- time, call, cost, retry, and concurrency bounds;
- terminal outcomes and failure semantics;
- execution engine `langgraph-js`, lowering-adapter version, supported profile, transition limit, concurrency limit, and durability mode;
- dependency closure;
- canonical plan digest.

Timestamps, environment names, run IDs, signatures, and deployment metadata must not enter the canonical plan bytes.

### Supported execution profile

Support only primitives already covered by Harness Factory runtime tests and required by the two demos:

- `input`, `output`;
- `transform`: `select`, `merge`, `deduplicate`, `sort`, `slice`;
- `condition`;
- `join`: `all`, `allSettled`;
- `aggregator`: `collect`, `merge`, `concat`, `vote`;
- `agent`, `tool`, `evaluate`/validator; agent/model execution resolves a compiled model-profile capability through the gateway;
- bounded `loop` only if a demo needs it.

Compilation must fail for `group`, `subgraph`, `teacher`, `join:first`, unbounded loops, event-driven execution, undeclared bindings, unsupported transforms, or any primitive outside the profile. An unsupported feature is never silently projected.

## 4. Local deployable shape

```text
CLI / test client
      |
      v
control-api --------------> PostgreSQL
                                |
                                | durable run + ready node
                                v
runtime-dispatcher -------> lease + provider selection
      |                         |
      |                         +--> Harness run/events ledger
      v
runtime-host-local ------> LangGraph StateGraph + Postgres checkpointer
      |
      +----> capability client ----> capability-gateway ----> OpenRouter/simulator
```

Recommended repository layout:

```text
apps/control-api/          HTTP admission and read APIs
apps/runtime-worker/       lease-owning runtime dispatcher
apps/runtime-host/         isolated HTTP executor host
apps/capability-gateway/   authorization, credential isolation, adapter routing
apps/control-ui/           contract-driven operator visibility and safe controls
crates/harness-compiler/   DomainPackage -> HarnessPlan CLI
packages/contracts/        JSON Schemas and generated TS types
packages/runtime-core/     node wrappers, budgets, events, enforcement
packages/runtime-langgraph/ HarnessPlan -> StateGraph lowering adapter
packages/runtime-provider/ local HTTP and Azure Foundry provider adapters
packages/persistence/      run ledger, leases, fencing, and migrations
packages/adapters/         model and capability interfaces
packages/execution-auth/    envelope minting and verification
domains/                   demonstration domain packages
tests/conformance/         compiler/runtime golden fixtures
tests/e2e/                 Docker-level proof
deploy/local/              Compose and local configuration
```

Keep the API and worker as separate processes even if they share packages. This preserves the future queue/worker boundary without requiring Service Bus locally.

## 5. Reuse and refactor map

| Existing asset | Action for POC | Reason |
|---|---|---|
| `ladder-graph/crates/lgir-core` | Reuse as the sole LGIR parser, normalizer, and graph validator; expose a stable Rust library call used by `harness-compiler` | It is the current authoritative compiler core and already has deterministic/security tests |
| `ladder-graph` diagnostic and parity fixtures | Import into conformance tests with upstream commit provenance | Prevents graph semantic drift between repos |
| `ladder-graph/docs/langgraph-support-design.md` | Use its strict LGIR-to-LangGraph mappings and unsupported-feature diagnostics as design input | It already identifies the safe topology boundary and rejects executable interpretation of natural-language fields |
| `harness-factory/packages/domain/src/runtime-interpreter.ts` | Use as a semantic oracle and fixture source during LangGraph adapter conformance; do not make it the POC scheduler | It pins executable outcomes and edge cases, while LangGraph replaces its custom scheduling/checkpoint loop |
| `harness-factory/packages/domain/src/source-exports.ts` | Reuse topology/lowering test ideas, not the generated Python scaffold | The export proves graph mapping but intentionally contains handler stubs and is not a governed runtime |
| `harness-factory/packages/domain/src/contracts.ts` | Use as design input; replace duplicated LGIR definitions with generated types from canonical JSON Schema | The current TypeScript contract has drifted beyond Rust fields |
| `harness-factory/packages/domain/src/digest.ts` | Reuse canonical digest behavior and add cross-language golden vectors | Digest identity is already widely tested |
| `harness-factory/apps/web/src/server/harness-runtime.ts` | Extract budget, effect, model, tool, and trajectory logic behind adapter interfaces | Avoid carrying Next.js, tenant administration, and UI into the runtime |
| `harness-factory/apps/web/src/server/orchestrator.ts` | Reuse suspension concepts; LangGraph owns continuation checkpoints while the persistence package retains worker leases/fencing and stable run records | Checkpointing and worker authority are separate concerns |
| Harness Factory migrations and runtime tests | Port only plan/run/event/idempotency patterns and relevant tests | Reusing the entire Supabase application would make the POC larger than the concept being proven |
| Harness Factory Docker hardening | Reuse non-root image, read-only filesystem, health checks, capability drop, and loopback defaults | These settings are already production-like and portable |

Do not use cross-repository filesystem imports in the final build. During implementation, move or extract code with commit provenance, then make this repository independently buildable from a clean checkout.

## 6. Stable cloud migration seams

| Local POC | Cloud phase replacement | Contract that stays unchanged |
|---|---|---|
| Docker Compose | Container Apps deployment | Container entrypoints and health endpoints |
| PostgreSQL container | Azure Database for PostgreSQL | migrations, repositories, leases, checkpoints, run records |
| PostgreSQL ready-work polling | Service Bus notification plus PostgreSQL authority | `WorkItem` identity, idempotency, lease, fencing, result contract |
| Simulator service | APIM-fronted typed capability adapters | `CapabilityRequest` / `CapabilityResult` |
| Local HMAC execution-envelope signer | Entra/workload identity plus production signing or token service | claims, audience, expiry, plan binding, capability scope, fencing semantics |
| Recorded model adapter, plus optional OpenAI-compatible/OpenRouter development adapter | Foundry, Azure OpenAI, or another approved model adapter | provider-neutral `ModelRequest` / `ModelResult` |
| Local plan directory | Blob/registry resolved by digest | canonical `HarnessPlan` bytes and digest |
| Unsigned local plan admission | signed release envelope and revocation check | plan digest and dependency closure |
| Local process identity | managed identity and scoped execution token | permission envelope and execution claims |

No domain package should name Docker, Azure, a hostname, a secret, or a vendor endpoint.

LangGraph is an execution adapter, not part of the domain contract. See [`adr-langgraph-runtime.md`](./adr-langgraph-runtime.md) for state, lowering, persistence, retry, fencing, and conformance rules.

### First live model adapter: OpenRouter

For the POC, OpenRouter is the first live LLM adapter. Reuse the existing Harness Factory integration rather than implementing a second client:

- `createOpenRouter` provider construction;
- environment-based API-key loading;
- catalog response normalization where discovery is needed;
- request IDs, token accounting, reported-cost extraction, latency, status, and idempotent usage receipts;
- timeout and missing-provider failure behavior.

Refactor these pieces out of the Harness Factory `model-gateway` and runtime modules. Do not bring across tenant administration, Next.js request context, Supabase provider resolution, or UI-specific catalog behavior.

Domain packages request a versioned capability tier rather than an OpenRouter model:

| Initial tier | Intended use | Default constraints |
|---|---|---|
| `model.fast.v1` | extraction, classification, formatting | low latency/cost, structured output required |
| `model.standard.v1` | ordinary domain reasoning | balanced budget, structured output when declared |
| `model.deep.v1` | complex investigation or synthesis | higher reasoning and token budget, lower concurrency |
| `model.judge.v1` | independent verification | isolated context and no reuse of the producing call |

A versioned local model-profile registry maps each tier to one exact OpenRouter model ID and fixed inference limits. The compiler resolves the tier to a model-profile digest and places that digest in the HarnessPlan. The Capability Gateway resolves that digest to the configured OpenRouter adapter binding at runtime.

The execution record must retain the requested tier, model-profile digest, adapter/version, exact OpenRouter model ID, provider request ID, parameters, token usage, reported cost when available, latency, and outcome. Missing provider cost is recorded as incomplete telemetry rather than treated as zero.

Only the `capability-gateway` container receives `OPENROUTER_API_KEY`. The control API, worker, compiler, domain packages, compiled plans, events, and API responses must never contain it.

## 7. Implementation slices

### Slice 0 — contract freeze and extraction map (1-2 days)

- Record exact source commits from `harness-factory` and `ladder-graph`.
- Define canonical JSON Schemas for `DomainPackage`, `HarnessSpec`, `HarnessPlan`, `PermissionEnvelope`, `RunRequest`, `RunResult`, `CapabilityRequest/Result`, and runtime events.
- Resolve known Rust/TypeScript LGIR drift, including context scope, loop memory, and terminal outcome fields.
- Publish a primitive support matrix with compile-time rejection codes.

**Exit:** one valid and one invalid package fixture produce agreed diagnostics and canonical bytes.

### Slice 1 — deterministic compiler (3-4 days)

- Build `harnessc validate` and `harnessc compile`.
- Reuse `lgir-core` for safe parsing and workflow analysis.
- Resolve package-local references and calculate every dependency digest.
- Derive minimal per-node permissions and enforce capability/effect/budget rules.
- Emit canonical plan JSON, dependency manifest, diagnostics, and digest.
- Add repeat, reorder, malformed YAML, path escape, unresolved ref, cycle, unbounded loop, and unauthorized capability tests.

**Exit:** 100 repeated and concurrent compiles are byte-identical; invalid authority never produces an executable plan.

### Slice 2 — LangGraph execution core (5-6 days)

- Pin LangGraph.js, core, and PostgreSQL-checkpointer versions.
- Implement a deterministic `HarnessPlan` to `StateGraph` lowering adapter.
- Use the Harness Factory interpreter tests as semantic parity fixtures, then remove the legacy interpreter from the POC runtime path.
- Execute the supported profile from `HarnessPlan` only, with `thread_id = runId`; bind the root checkpoint to `planDigest` through the authoritative run record (LangGraph reserves checkpoint namespaces for subgraphs).
- Define deterministic reducers so parallel nodes can update separate output/error keys without loss.
- Add strict input/output validation, per-node deadlines, run budgets, effect checks, and terminal handling.
- Introduce recorded model and typed capability adapter interfaces.
- Keep `ModelRequest` provider-neutral: it carries a model-profile ID, messages/input, output schema, sampling constraints, deadline, and budget—not a provider endpoint, API key, or provider SDK type. `ModelResult` carries normalized content, structured output, finish reason, usage, latency, and provider receipt metadata.
- Mint a short-lived execution envelope for each node attempt. Required claims are `iss`, `aud`, `iat`, `exp`, `jti`, `run_id`, `node_id`, `attempt`, `plan_digest`, `capabilities`, `effects`, and `fencing_epoch`.
- Adapt LangGraph node/checkpoint activity into stable Harness event sequences and node-attempt receipts.

**Exit:** both domains execute through the same LangGraph adapter, match the deterministic interpreter fixtures, and preserve both parallel branch updates.

### Slice 3 — durable worker, gateway, and API (4-5 days)

- Add plan, run, node-attempt, event, idempotency, lease, and fencing tables plus the LangGraph PostgreSQL checkpointer schema.
- Implement admission, work claiming, lease heartbeat, fencing epoch, retry classification, and terminal persistence.
- Implement the Capability Gateway as a separate process with:
  - execution-envelope signature, audience, expiry, replay, plan, node, attempt, and fencing checks;
  - capability/effect authorization against the compiled node permission envelope;
  - request and response schema validation;
  - fixed logical-capability-to-adapter routing;
  - gateway-owned local provider credentials;
  - sanitized invocation receipts with no secrets or sensitive headers.
- Expose minimal endpoints:
  - `POST /v1/plans` to admit compiled local plans;
  - `POST /v1/runs` with an idempotency key;
  - `GET /v1/runs/{id}`;
  - `GET /health/live` and `GET /health/ready`.
- Ensure a repeated run request returns the original run rather than executing again.

**Exit:** killing and restarting the worker resumes the LangGraph thread from the last durable checkpoint without a duplicate provider call; stale workers cannot commit or invoke the gateway. A forged, expired, replayed, or over-scoped execution envelope is denied.

### Slice 4 — Docker proof and handoff (2-3 days)

- Add hardened multi-stage images and Compose services.
- Add `make bootstrap`, `make compile`, `make up`, `make demo`, `make test`, and `make down`.
- Run both domain demonstrations through HTTP.
- Add clean-checkout CI, architecture decision records, cloud adapter notes, and a measured limitations report.

**Exit:** a new machine with Docker and Make can build, compile, run, restart, and verify both demos without credentials.

### Parallel UI workstream — control surface (5-7 days)

- Implement the shell, harness registry/detail, runs list/detail, Capability Gateway, overview, and system screens from the UI specification.
- Add cursor-paginated read models for plan lists/details, run lists/events, gateway profiles/decisions, overview, and system state.
- Keep all authority and metric derivation on the server; the browser consumes typed view models.
- Include loading, empty, filtered-empty, stale, degraded, long-content, denial, and accessibility states.

**Exit:** an operator can admit a compiled plan, start either demo, watch its graph/timeline advance, inspect model/gateway authority and usage, and diagnose a failed or denied node without seeing credentials or overstating POC authority.

### Expected duration

- One experienced engineer: approximately 3-4 focused weeks.
- Two engineers working across compiler/contracts and runtime/gateway/persistence: approximately 2-3 weeks.

The compiler/runtime estimate assumes reuse of the existing tested code and excludes Azure provisioning. The control-surface workstream can run in parallel against exact mock view contracts, then connect to the API read models.

## 8. Acceptance test

The POC is complete only when this scriptable story passes from a clean checkout:

1. `make bootstrap` builds pinned images and starts PostgreSQL.
2. `make compile DOMAIN=kyc-screening-demo` emits a plan and stable digest.
3. Compiling the same package again produces byte-identical output.
4. A modified undeclared tool, unsafe effect, cycle, or unbounded loop is rejected with a stable diagnostic code.
5. `make demo DOMAIN=kyc-screening-demo` returns the expected fixture outcome and a complete event trail.
6. The worker is terminated after a tool result is committed and restarted; the run completes without calling that tool twice.
7. Repeating the same request with the same idempotency key returns the existing run.
8. `make demo DOMAIN=invoice-review-demo` succeeds without a runtime code or image change.
9. The runtime rejects raw source YAML, a tampered plan digest, an undeclared adapter call, invalid input, and a budget overrun.
10. The gateway rejects missing, forged, expired, replayed, wrong-audience, stale-fence, wrong-plan, wrong-node, undeclared-capability, and effect-escalation envelopes.
11. Runtime container inspection confirms that provider credentials are absent; only the gateway container receives simulator/provider credentials.
12. Parallel branches retain both state updates and a join waits for the declared upstream set.
13. Each run record exposes the engine adapter, LangGraph library, checkpoint ID, checkpoint namespace, and durability mode used.
14. `make test` passes compiler golden tests, cross-language digest vectors, LangGraph lowering/parity tests, runtime primitive conformance, gateway authorization tests, checkpoint/restart fault tests, and Docker end-to-end tests without external network credentials.

## 9. Decisions to lock before coding

1. **Canonical schema ownership:** keep LGIR workflow semantics in Ladder Graph Rust; keep HarnessPlan and runtime protocol schemas in this repository.
2. **Code import mechanism:** prefer a deliberate extraction with provenance over long-lived filesystem links. Decide later whether the shared compiler becomes a published crate or a separately versioned compiler image.
3. **POC runtime engine:** TypeScript/Node with a pinned LangGraph.js `StateGraph` adapter. Rust remains the compilation authority; LangGraph never parses source packages or grants capabilities.
4. **Durability authority:** PostgreSQL is canonical. LangGraph checkpointer tables own opaque continuation state; Harness tables own stable run/audit/read models; queues are notification/scale mechanisms only.
5. **Effects:** the POC performs read-only simulated capabilities. It proves idempotency and effect denial, not real external writes.
6. **Domain authority:** demo agents produce findings and recommendations only. They do not mutate a KYC or invoice system of record.
7. **Credential-envelope meaning:** the envelope is a signed authorization credential, not a container for provider secrets. Local HMAC signing proves the protocol; cloud identity/token issuance replaces the signer without changing its claims or gateway checks.
8. **Model-provider neutrality:** the default test adapter is recorded/deterministic. OpenRouter support, if enabled for development, is one gateway adapter selected by deployment configuration. Domain packages and compiled plans bind to model-profile capabilities, so moving to Foundry or Azure OpenAI does not require recompiling domain behavior unless the governed model profile itself changes.
9. **Framework containment:** pin LangGraph and the Postgres checkpointer, record their versions, and require a new lowering-adapter version plus full conformance replay for semantic upgrades.

## 10. First implementation backlog

| ID | Deliverable | Depends on |
|---|---|---|
| P0 | ADRs, source commit inventory, support matrix | none |
| P1 | Canonical schemas and generated TypeScript types | P0 |
| P2 | `lgir-core` integration and package-safe parser | P0-P1 |
| P3 | HarnessPlan compiler, canonicalization, and digest | P2 |
| P4 | KYC and invoice domain fixtures | P1 |
| P5 | LangGraph.js lowering adapter and interpreter-parity conformance suite | P1, P3 |
| P6 | Capability Gateway, execution envelopes, adapter interfaces, and simulator | P5 |
| P7 | PostgreSQL migrations, repositories, leases, fencing | P1 |
| P8 | Control API and worker host | P5-P7 |
| P9 | Restart, idempotency, tamper, and budget fault tests | P8 |
| P10 | Docker, Make targets, clean-checkout CI, runbook | P3-P9 |
| P11 | Contract-driven control surface and API read models | P1, P3, P8 |

The milestone is not “the demo runs.” It is “two domain packages compile and run unchanged on one durable generic runtime, and the produced plan/runtime contracts are the same contracts the cloud phase will consume.”
