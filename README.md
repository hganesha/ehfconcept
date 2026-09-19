# Executable Harness Framework — local POC

This repository proves the core architecture as a local, Docker-runnable vertical slice. A domain author writes a `DomainPackage` plus a Ladder Graph workflow. The Rust `harnessc` compiler validates the workflow with the pinned `lgir-core`, resolves capability and model-profile bindings, and emits an immutable, content-addressed `HarnessPlan`. The runtime lowers that plan into LangGraph.js without giving LangGraph authority over permissions or credentials.

## What is implemented

- Rust source-to-plan compiler pinned to Ladder Graph revision `fec01bf...`
- KYC and invoice demo packages
- provider-neutral runtime invocation contract with a lease-owning dispatcher and a separately authenticated HTTP runtime host
- local HTTP and Azure Foundry runtime provider adapters; the provider binding is configuration-derived and recorded by digest
- LangGraph.js plan adapter in the isolated host with Postgres checkpoints (`thread_id = runId`; the run ledger binds that globally unique run to its immutable plan digest)
- Postgres run ledger, node attempts, events, leases, and fencing epochs
- capability gateway requiring both a workload credential and a short-lived execution envelope, with plan/permission verification, transactionally reserved budgets, and idempotent receipts
- an execution-envelope broker in the control plane: the dispatcher issues a run-scoped grant, the runtime exchanges it per node, and the broker re-reads the lease and fence before signing. The runtime holds no signing key.
- identity and authorization across every service: a principal resolver (local headers for development, Entra JWT for Azure), an explicit role-to-action table, per-tenant scoping, separation of duties between author and approver, and bounded authorization decision records
- OpenRouter model-profile tiers plus deterministic recorded mode when no API key is configured
- simulator adapters for sanctions, vendor, and purchase-order lookups
- control API for plan admission, run commands, run queries, and event queries
- integrated Next.js control surface backed by the control API, capability gateway, and tenant-scoped case API; it includes scalable categorized harness/case graphs, node inspection, case activity history, and trace links
- author plane for importing or creating domain sources, graph and node inspection, YAML editing, validation, evaluation, approval, publication, capability registration, and auditable lifecycle transitions. Plan emission is delegated to the pinned `harnessc` binary, which is the only compiler: the author plane resolves and validates the authoring surface and then shells out.
- Docker Compose stack with Postgres, migration, API, gateway, and worker
- end-to-end OpenTelemetry traces exported over OTLP to the local Jaeger UI
- canonical KYC case store with configurable PostgreSQL schemas for current state, append-only ledger, and evidence
- transactional BusinessCommands with sequence preconditions, semantic idempotency, hash-chained events, lineage, and outbox records
- content-addressed local evidence artifacts behind a replaceable storage boundary

The OpenRouter credential is present only in the capability-gateway container. Plans and workers carry a model profile ID, never an API key. Without a credential the gateway answers with the deterministic recorded adapter in local mode and fails closed in Azure mode, so a deployment cannot report model calls it did not make.

### Trust boundaries

| Component | Holds | Does not hold |
| --- | --- | --- |
| `runtime-dispatcher` | lease, fence, runtime-grant signing key | envelope signing key, provider credentials |
| `control-api` | envelope signing key, run journal, plan admission | provider credentials |
| `runtime-host` | a per-invocation grant it cannot mint | signing keys, run journal credentials, provider credentials |
| `capability-gateway` | provider credentials, envelope verifier | plan authorship, case authority |
| `case-api` | case, ledger and evidence stores, envelope verifier | signing keys, provider credentials |

A runtime asks the control plane for authority per node and journals through it, so it needs no database credential of its own. Its remaining database handle is the LangGraph checkpoint store; `RUNTIME_CHECKPOINT_BACKEND=memory` removes that too, at the cost of resumability.

## Run it

Requirements: Docker, Rust, Node 24+, pnpm 11+, `curl`, and `jq`. The image builds
`harnessc` in a Rust stage, because the author plane cannot emit a plan without it.

```bash
make check
make up
make demo
make demo-case
make demo-kyc-e2e
```

Without `OPENROUTER_API_KEY`, model calls use the deterministic recorded adapter, which makes the POC testable offline. To exercise OpenRouter:

```bash
cp .env.local.example .env.local # only needed if .env.local is absent
# Edit .env.local and set OPENROUTER_API_KEY, then:
docker compose up -d --force-recreate capability-gateway
make demo
```

`.env.local` is git-ignored, excluded from Docker build contexts, and injected only into the capability-gateway container. Confirm configuration without revealing the key with `curl http://localhost:4101/v1/status` or the Gateway page in the control surface.

`make demo-kyc-e2e` demonstrates the pilot path across both authorities: the compiled LangGraph harness performs sanctions screening and the model recommendation, then the case service records identity and screening evidence, facts, findings, work completion, recommendation, independent QA, human review, final gate, and effective disposition. It prints the run ID, trace ID, case ID, provider mode, final case state, and ledger verification result.

Open the control surface at `http://localhost:4200`. The Cases section exposes the tenant-scoped canonical KYC aggregate, categorized evidence lineage, digest-chained activity ledger, linked harness run, and Jaeger trace. Inspect the runtime API at `http://localhost:4100`, the gateway at `http://localhost:4101`, the case service at `http://localhost:4102`, and distributed traces in Jaeger at `http://localhost:16686`. Each run response contains its durable `traceId` and `rootSpanId`, and the run and case detail views link directly into Jaeger. Stop the stack with `make down`; add `-v` manually if you intentionally want to delete the local database volume.

The Author Plane at `http://localhost:4200/author` treats editable source and executable plans as different assets. A draft may be edited and validated repeatedly; compilation creates a content-addressed plan snapshot; evaluation, approval, and publication are explicit audited transitions. Published plans are admitted to the existing runtime control plane. The Agents & skills tab creates reusable provider-neutral contracts or imports manifests, prompts, and `SKILL.md` files from GitHub. On the canvas, a registered agent can replace an eligible node or be inserted after the selection; the action round-trips into canonical package/workflow YAML. Node `config.caseWrites` entries let authors declare canonical BusinessCommand types plus JSON Schema payload contracts, which remain JSONB-compatible without allowing direct database writes. The Gateway tab manages a capability catalog; a capability is still usable by a run only after compilation places it in that plan's permission envelope.

The case store defaults to the `case_core`, `case_ledger`, and `evidence` schemas in the same PostgreSQL database. Override `CASE_DATABASE_URL`, `CASE_CORE_SCHEMA`, `CASE_LEDGER_SCHEMA`, and `EVIDENCE_SCHEMA` to isolate it differently. Schema identifiers are validated before migration or query construction. Local evidence bytes use the `postgres` artifact adapter; the canonical object stores a digest-addressed opaque artifact reference so a later Blob adapter does not change case or command contracts.

The trace hierarchy follows the implementation standard: `harness.run` → `runtime.invoke` → `workflow.transition` → `capability.request` → `capability.invoke` → `authorization.evaluate` plus `model.inference` or `tool.execution`. W3C `traceparent` is propagated only between trusted runtime services. Spans contain approved operational identifiers, digest prefixes, bounded outcomes, timing, tokens, and cost—never case payloads, prompts, model responses, credentials, or execution-envelope claims. Durable run events and gateway receipts remain authoritative when telemetry is sampled or unavailable.

Verify an exported trace and its cross-service topology with `make trace RUN_ID=RUN-...`. The control API also exposes `GET /v1/runs/:runId/trace`, including a local Jaeger deep link.

## Platform mode

The same images run locally and in Azure; the difference is configuration. `PLATFORM_MODE=azure`
switches the identity provider to Entra and makes the local-mode conveniences refusals rather
than defaults: a header-trusting principal resolver cannot be constructed, static service tokens
and shared signing secrets are rejected at startup, a password-bearing or local-host database URL
is rejected, and the recorded model adapter no longer stands in for an absent provider credential.
Services fail to boot rather than serving traffic half-configured.

| Setting | Local | Azure |
| --- | --- | --- |
| `PLATFORM_MODE` | `local` | `azure` |
| `IDENTITY_PROVIDER` | `local_headers` | `entra` |
| `EDGE_SERVICE_TOKEN` / `RUNTIME_SERVICE_TOKEN` | shared tokens | rejected; managed-identity tokens |
| `EXECUTION_ENVELOPE_SECRET` | HMAC, control plane and verifiers | rejected; asymmetric signing |
| `MODEL_RECORDED_FALLBACK` | `allow` | `deny` |
| `RUNTIME_CHECKPOINT_BACKEND` | `postgres` | `memory` until a remote checkpoint store exists |

## Stable boundaries for the cloud phase

The transferable seams are the `HarnessPlan` contract, compiler output, runtime adapter interface, execution envelope, capability request/result receipts, event vocabulary, and Postgres persistence model. A cloud phase can replace the local queue polling, secret signer, and deployment substrate without changing domain packages or bypassing the gateway.

The default local binding is `RUNTIME_PROVIDER=local_http`, with the dispatcher calling `runtime-host-local` over the internal Compose network. To select the implemented Foundry dispatcher adapter in an Azure deployment, set `RUNTIME_PROVIDER=azure_foundry`, `FOUNDRY_AGENT_INVOCATION_ENDPOINT`, `FOUNDRY_AGENT_NAME`, and immutable `FOUNDRY_AGENT_VERSION`; `DefaultAzureCredential` obtains the `https://ai.azure.com/.default` token. The Azure Hosted Agent still needs the documented Invocations-protocol wrapper and deployment/promotion steps before that path can be exercised. The local host no longer journals to PostgreSQL: run state, node attempts and durable events go through a private control-plane surface that re-checks the grant, the lease and the fence before recording anything. Its only remaining database handle is the LangGraph checkpoint store, selected by `RUNTIME_CHECKPOINT_BACKEND`; `memory` removes it entirely and makes the invocation non-resumable.

See [the POC plan](docs/plans/local-runtime-poc.md), [the author-plane contract](docs/plans/author-plane-poc.md), [the Azure POC migration plan](docs/plans/azure-poc-migration-plan.md), [the runtime-isolation and Azure migration runbook](docs/plans/runtime-isolation-azure-migration.md), [the LangGraph ADR](docs/plans/adr-langgraph-runtime.md), [the case-store POC](docs/plans/case-store-poc.md), and [the control-surface contract](docs/plans/poc-control-surface-ui-spec.md).
