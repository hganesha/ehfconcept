# Configurable KYC case store POC

This slice implements the durable boundary described by the canonical case, ledger, and evidence specification. It runs beside the harness runtime in the same PostgreSQL database, but owns separate configurable schemas and a separate API process.

## Local topology

| Authority | Default schema | Local responsibility |
|---|---|---|
| Current case | `case_core` | KYC aggregate, subjects, evidence links, claims, facts, findings, assumptions, contradictions, work items, decisions, reviews, dispositions, execution references |
| Case ledger | `case_ledger` | Ordered hash-chained events, semantic command receipts, chain heads, transactional outbox |
| Evidence | `evidence` | Content-addressed artifacts, immutable evidence metadata, registration receipts, lineage edges, evidence outbox |

Set `CASE_DATABASE_URL`, `CASE_CORE_SCHEMA`, `CASE_LEDGER_SCHEMA`, and `EVIDENCE_SCHEMA` to move or rename the physical store. Identifiers are validated as SQL identifiers before they are used. `CASE_ARTIFACT_BACKEND=postgres` is the only POC artifact adapter. The evidence contract persists an opaque `artifact://` reference and SHA-256 digest so a Blob adapter can replace it without changing case commands or lineage.

Evidence intake defaults to one MiB with `CASE_EVIDENCE_MAX_BYTES`. `CASE_EVIDENCE_REQUIRE_SCAN=false` permits the local recorded fixture to link digest-verified artifacts marked `POC_NOT_SCANNED`. Set it to `true` to fail closed until a scanner produces `VERIFIED_CLEAN`; cloud and regulated environments must enable that policy.

## API

The case service listens on `http://localhost:4102`.

- `POST /v1/cases` creates a KYC case and requires `Idempotency-Key`.
- `GET /v1/cases` and `GET /v1/cases/:caseId` require `X-Tenant-Id`.
- `POST /v1/cases/:caseId/commands` is the only case mutation path.
- `GET /v1/cases/:caseId/events` returns ordered ledger events.
- `POST /v1/cases/:caseId/ledger:verify` recomputes event digests and chain continuity.
- `POST /v1/evidence:register` registers content-addressed evidence and requires `Idempotency-Key`.
- `GET /v1/evidence/:evidenceId` returns metadata, never artifact bytes.

Commands enforce tenant/case scope, pinned plan and policy digests, exact case-sequence preconditions, semantic idempotency, KYC lifecycle transitions, evidence linkage, and selected final-disposition invariants. Each accepted command advances the aggregate and appends its event, chain head, receipt, lineage, and outbox record in the same PostgreSQL transaction.

Run `make demo-case` after `make up` to create a subject, register/link screening evidence, produce a claim, accept it as a fact, record a finding, advance lifecycle state, and independently verify the resulting ledger chain.

Run `make demo-kyc-e2e` for the complete local pilot narrative. It binds the planning baseline's unresolved provider and policy inputs to explicit POC fixtures, executes the compiled LangGraph screening/recommendation harness, links its run and OpenTelemetry trace to the case, and advances through independent QA, required human review, deterministic final gate, and disposition. The planning YAML remains `proposed_not_compiled`; this demo is an explicit pilot binding rather than an assertion that the unresolved production baseline has compiled.

## Deliberately deferred from the production specification

- Entra authentication and compiled PermissionEnvelope signature verification; the POC preserves actor and authority contracts but does not yet establish principal identity.
- Malware/content scanning, Azure Blob WORM, legal hold, retention enforcement, and download brokerage.
- Signed immutable ledger exports, upcasters, as-of aggregate reconstruction, publisher workers, search projections, reconciliation jobs, and regional recovery.
- Full deterministic decision-rule coverage and dual-control assignment workflows.

These are adapter or policy layers around the retained case, evidence, command, lineage, and event contracts; they do not require replacing the implemented aggregate boundary.
