# Azure POC migration plan

**Status:** proposed implementation plan
**Scope:** showcase deployment, synthetic data only
**Baseline:** repository state on 17 September 2026
**Target:** Azure Static Web Apps, Azure Container Apps, Azure Database for PostgreSQL Flexible Server, and the existing Microsoft Foundry Hosted Agent runtime

## 1. Executive decision

Deploy the POC as a modular Azure stamp, while keeping the existing contracts and business boundaries intact. Do not rewrite the compiler, `HarnessPlan`, LangGraph lowering, case command model, or capability receipts. Add Azure adapters at the edges and select them with configuration.

The recommended POC topology is:

1. Export the Next.js control UI as a static client and deploy it to Azure Static Web Apps Standard.
2. Add a small `api-edge` Container App and link it to Static Web Apps under `/api`.
3. Deploy `control-api`, `case-api`, `capability-gateway`, and `runtime-dispatcher` as private Azure Container Apps. Deploy migrations as a Container Apps Job.
4. Keep agent execution in the already implemented Microsoft Foundry Hosted Agent and select it with `RUNTIME_PROVIDER=azure_foundry`.
5. Use Microsoft Entra ID for human and workload identity, app roles for authorization, and managed identities for service-to-service and Azure resource access.
6. Use PostgreSQL Flexible Server with private access and Entra-only authentication. Preserve the current schemas and migrations.
7. Export OpenTelemetry to Application Insights/Log Analytics and retain the existing durable run events and receipts as the audit source of truth.
8. Use GitHub Actions with OIDC federation for infrastructure and application delivery. Build immutable images in ACR and promote digests and Foundry agent versions, not mutable tags.

This is an adapter migration, not a platform rewrite. The switch between local and Azure must remain configuration-driven.

## 2. Why the UI needs an adapter

The current `control-ui` is not a static site. It uses Next.js server rendering, route handlers, server-side environment variables, and server-side calls to four local services. Although Azure Static Web Apps can host hybrid Next.js applications, that support is currently preview, and linked Azure API backends are not supported with hybrid rendering. A linked Container Apps backend also exposes only one `/api` backend and has a 45-second request limit.

For a showcase POC, use this stable split:

```text
Browser
  -> Static Web Apps: static Next.js shell + Entra sign-in + route roles
  -> /api/*
  -> linked api-edge Container App
  -> private Container Apps services
```

The `api-edge` is a backend-for-frontend and identity adapter, not a business authority. It must:

- accept traffic only through the Static Web Apps linked-backend identity provider;
- decode the trusted Static Web Apps principal, reject absent or malformed identity, and map it to the platform principal contract;
- enforce coarse UI roles and forward a normalized, signed identity context;
- route requests to the appropriate private service;
- acquire Entra access tokens with its managed identity for downstream calls;
- strip all inbound `x-actor-id`, `x-tenant-id`, `x-ms-client-principal`, and internal authorization headers before constructing trusted replacements;
- never make case, plan, budget, or capability decisions itself.

This requires converting server components that load live data into client-side queries, moving current Next.js route-handler logic into `api-edge`, and setting `output: "export"`. The UI can retain the same visual components and TypeScript view models.

Official constraints: [Static Web Apps API support](https://learn.microsoft.com/en-us/azure/static-web-apps/apis-overview), [linked Container Apps backends](https://learn.microsoft.com/en-us/azure/static-web-apps/apis-container-apps), and [hybrid Next.js support and limitations](https://learn.microsoft.com/en-us/azure/static-web-apps/deploy-nextjs-hybrid).

## 3. Target Azure topology

```text
GitHub repository
  | OIDC federation
  v
GitHub Actions ---------------------> Azure deployment identity
  |                                      |
  | build/test/SBOM                      | Bicep modules
  v                                      v
Azure Container Registry          Resource group / Azure stamp
  |                                      |
  | image digests                        +-- Static Web Apps
  |                                      |    - static control UI
  |                                      |    - Entra user authentication
  |                                      |    - linked /api backend
  |                                      |
  |                                      +-- Container Apps environment
  |                                      |    - api-edge (external, SWA-linked)
  +------------------------------------> |    - control-api (internal)
                                         |    - case-api (internal)
                                         |    - capability-gateway (internal)
                                         |    - runtime-dispatcher (no ingress)
                                         |    - db-migrate job
                                         |
                                         +-- PostgreSQL Flexible Server
                                         |    - private DNS/access
                                         |    - Entra-only authentication
                                         |
                                         +-- Microsoft Foundry project
                                         |    - hosted agent + immutable version
                                         |    - project/model connections
                                         |
                                         +-- Key Vault
                                         |    - execution signing key
                                         |    - unavoidable third-party secrets
                                         |
                                         +-- Application Insights + Log Analytics
                                         +-- ACR
                                         +-- optional Blob, Service Bus, APIM
```

### Deployment units

| Unit | Azure host | Ingress | Identity | Primary responsibility |
| --- | --- | --- | --- | --- |
| `control-ui` | Static Web Apps Standard | Public HTTPS | Entra user | Static control surface only |
| `api-edge` | Container Apps | External, SWA-linked only | System-assigned MI | UI BFF, identity normalization, private routing |
| `control-api` | Container Apps | Internal | System-assigned MI | Plans, runs, authoring lifecycle |
| `case-api` | Container Apps | Internal | System-assigned MI | Case aggregate, ledger, evidence commands |
| `capability-gateway` | Container Apps | Internal | System-assigned MI | Capability authorization, provider calls, receipts |
| `runtime-dispatcher` | Container Apps | None | User-assigned MI | Leases, fencing, Foundry invocation, completion |
| `db-migrate` | Container Apps Job | None | User-assigned migration MI | Ordered schema migrations only |
| hosted agent | Foundry Agent Service | Foundry endpoint | Foundry-created agent identity | Existing agent runtime |

Use one Container Apps environment for the POC. Internal ingress separates services from the internet. Split into platform and executor environments only when network isolation or scale testing is part of the demonstration.

## 4. What already migrates cleanly

The following repository elements should be preserved:

- versioned `HarnessPlan`, `RuntimeInvocation`, and `RuntimeInvocationResult` contracts;
- `RuntimeProvider` with `local_http` and `azure_foundry` implementations;
- `DefaultAzureCredential` and the `https://ai.azure.com/.default` Foundry token scope;
- provider binding digest and immutable agent name/version recording;
- PostgreSQL migrations and the current `harness_control`, `harness_runtime`, `case_core`, `case_ledger`, `evidence`, and observability tables;
- fencing epochs, idempotency, durable events, gateway receipts, and content digests;
- W3C trace-context propagation and current span vocabulary;
- model/tool calls passing through the capability gateway rather than directly from the runtime;
- local deterministic/recorded adapters for tests.

The current Azure Foundry provider is therefore a foundation, not a stub. The remaining work is deployment compatibility, identity, asynchronous status/cancellation conformance, and promotion automation.

## 5. Required adapter packages

Keep each interface provider-neutral and make the local implementation the default in tests.

### 5.1 Principal and authorization adapter

Create `packages/identity`:

```ts
interface PrincipalResolver {
  resolve(request: HttpRequest): Promise<Principal>;
}

type Principal = {
  subjectId: string;
  tenantId: string;
  actorType: "human" | "workload";
  roles: string[];
  source: "local" | "swa" | "entra";
};

interface Authorizer {
  require(principal: Principal, action: PlatformAction, resource: ResourceRef): void;
}
```

Implementations:

- `LocalHeaderPrincipalResolver`: development only; preserves current local headers.
- `StaticWebAppsPrincipalResolver`: used only by `api-edge`; validates the linked-backend context.
- `EntraJwtPrincipalResolver`: validates issuer, tenant, audience, signature, expiry, app roles/scopes, and authorized client applications for internal HTTP services.

Replace these unsafe cloud behaviors:

- `x-actor-id` defaulting to `local-author` in `control-api`;
- direct trust in `x-tenant-id` in `case-api`;
- a configured UI-wide `CASE_UI_TENANT_ID` acting as authority.

Tenant must be derived from trusted identity and an authorized tenant assignment. A caller-provided tenant can only be a requested scope and must match that assignment.

Suggested human app roles:

| App role | POC permissions |
| --- | --- |
| `Harness.Reader` | View plans, runs, traces, receipts, and cases |
| `Harness.Author` | Create/edit/validate drafts and import agent metadata |
| `Harness.Approver` | Approve and publish plans; separate from author where demonstrated |
| `Harness.Operator` | Start/cancel/retry runs and view operational details |
| `Case.Analyst` | Add evidence/facts/findings and submit review actions |
| `Case.Reviewer` | Independent QA and final human review |
| `Platform.Auditor` | Read-only ledger and authorization evidence |

Use route roles for coarse UI access and enforce every action again in the target API. Static Web Apps authentication is not a substitute for API authorization. See [Static Web Apps authentication and authorization](https://learn.microsoft.com/en-us/azure/static-web-apps/authentication-authorization).

### 5.2 Workload token adapter

Create `packages/azure-auth`:

```ts
interface AccessTokenProvider {
  getToken(audience: string, signal?: AbortSignal): Promise<string>;
}
```

Implementations:

- `StaticTokenProvider` for local Docker tests;
- `ManagedIdentityTokenProvider` backed by `DefaultAzureCredential` for Container Apps;
- the existing Foundry credential path becomes a consumer of this interface.

Use a distinct app registration/audience per protected API boundary or one internal API registration with narrowly assigned app roles. Container Apps authentication validates the token, but application code must still enforce expected `roles` claims and resource authorization. See [Container Apps Entra authentication](https://learn.microsoft.com/en-us/azure/container-apps/authentication-entra) and [managed identities](https://learn.microsoft.com/en-us/azure/container-apps/managed-identity).

### 5.3 Execution-envelope signing adapter

The short-lived execution envelope is dynamic delegated authority and should remain separate from Entra authentication. Replace the shared HS256 secret in Azure:

```ts
interface ExecutionEnvelopeSigner {
  sign(claims: ExecutionEnvelopeClaims): Promise<string>;
}

interface ExecutionEnvelopeVerifier {
  verify(token: string): Promise<ExecutionEnvelopeClaims>;
}
```

Implementations:

- `HmacExecutionEnvelopeProvider` for local compatibility;
- `KeyVaultRsaExecutionEnvelopeSigner` for the dispatcher/token broker;
- `JwksExecutionEnvelopeVerifier` for runtime and capability gateway verification.

Store the private RSA key in Key Vault, grant only `sign` to the signing identity, and give verifiers no secret-read permission. Include `kid`, rotate keys with an overlap window, and retain the current maximum lifetime of 120 seconds. Continue validating audience, issuer, plan digest, permission digest, capabilities, effects, run/node/attempt, and fencing epoch.

Transport authorization and execution authority are both required:

```text
Entra token says: this workload is the runtime.
Execution envelope says: this run/node/attempt may call these capabilities now.
```

### 5.4 PostgreSQL connection adapter

Replace the single password-bearing `DATABASE_URL` path with `DatabaseConnectionProvider`:

```ts
interface DatabaseConnectionProvider {
  poolConfig(): Promise<PoolConfig>;
}
```

Implementations:

- `ConnectionStringDatabaseProvider` for local Compose;
- `EntraPostgresDatabaseProvider` using `DefaultAzureCredential`, TLS verification, the Azure PostgreSQL token audience, and token refresh for new pooled connections.

Provision a PostgreSQL principal for each managed identity and grant only the schemas/actions it needs. Use a separate migration identity. Do not run applications as the Entra administrator.

Minimum database role split:

| Identity | Database rights |
| --- | --- |
| `mi-api-edge` | None |
| `mi-control-api` | Read/write `harness_control`; run/event API operations |
| `mi-case-api` | Read/write `case_core`, `case_ledger`, `evidence` |
| `mi-capability-gateway` | Read plans/runs; read/write gateway receipts and usage |
| `mi-runtime-dispatcher` | Claim/renew/complete runs; read admitted plans |
| `mi-db-migrate` | DDL only during the migration job |

Enable Entra-only authentication and private connectivity on Flexible Server. Microsoft documents managed identity/token authentication and using the token as the PostgreSQL password: [Entra authentication concepts](https://learn.microsoft.com/en-us/azure/postgresql/security/security-entra-concepts) and [configuration](https://learn.microsoft.com/en-us/azure/postgresql/security/security-entra-configure).

### 5.5 Configuration and secret adapter

Create one validated `PlatformConfig` loader rather than reading `process.env` throughout the services.

- Non-secret values remain Container Apps environment variables for the POC.
- Third-party secrets, if still needed, use Key Vault references or a Key Vault-backed provider.
- No Foundry, Azure, database, or ACR credentials are stored as secrets; use managed identity.
- Record only secret names, resource IDs, endpoints, versions, and digests in deployment output.
- Fail startup when Azure mode contains a local fallback secret or local endpoint.

Add an optional App Configuration provider only if live configuration or feature-flag demonstration is required. It is not needed merely to say the POC is Azure-native.

### 5.6 Evidence artifact adapter

The case store already keeps opaque artifact references. Complete the intended boundary:

```ts
interface ArtifactStore {
  putVerified(stream: Readable, expectedDigest: string, metadata: ArtifactMetadata): Promise<ArtifactRef>;
  get(ref: ArtifactRef): Promise<Readable>;
}
```

Implement `PostgresArtifactStore` locally and `AzureBlobArtifactStore` in Azure. Use workload identity, disable shared-key access and public access, and store the immutable blob version plus SHA-256 in the canonical evidence record. For this POC, synthetic artifacts and versioning are sufficient; WORM retention and legal hold are production gates, not claims the POC should make.

### 5.7 Telemetry exporter and trace-link adapter

Keep the existing instrumentation API and switch only the exporter/viewer:

- local: OTLP HTTP to Jaeger;
- Azure: OTLP to the Container Apps managed OpenTelemetry agent and Application Insights;
- UI: replace Jaeger-specific URLs with a `TraceLinkProvider` that constructs an Application Insights transaction-search link or opens a platform trace page by `traceId`.

Add structured logs and metrics without placing prompts, model responses, case payloads, tokens, execution envelopes, or evidence in telemetry. Container Apps supports an environment-level managed OpenTelemetry agent for traces/logs to Application Insights; it does not collect data until the code is instrumented. See [Container Apps OpenTelemetry agents](https://learn.microsoft.com/en-us/azure/container-apps/opentelemetry-agents) and [Container Apps observability](https://learn.microsoft.com/en-us/azure/container-apps/observability).

### 5.8 Optional queue adapter

The POC can retain PostgreSQL polling because it is already durable and working. To demonstrate the architecture's messaging layer, add this as an independently enabled module:

```ts
interface WorkSignalBus {
  publishReady(signal: WorkReadySignal): Promise<void>;
  subscribe(handler: (signal: WorkReadySignal) => Promise<void>): Promise<void>;
}
```

Implement `PostgresPollingSignalBus` and `AzureServiceBusSignalBus`. PostgreSQL remains authoritative; Service Bus is only an at-least-once wake-up signal. The dispatcher must re-read run state, acquire the database lease, and enforce the fencing epoch before any effect. This module must not block the first Azure deployment.

### 5.9 Runtime state/checkpoint adapter

This is required for the Foundry deployment, not an optional production refinement. The current local runtime host still uses `RUNTIME_CHECKPOINT_DATABASE_URL` for LangGraph checkpoints and node journaling. Do not give the Foundry agent identity direct PostgreSQL access.

Create a narrow `RuntimeStateStore` boundary:

```ts
interface RuntimeStateStore {
  loadCheckpoint(run: RunRef): Promise<Checkpoint | null>;
  saveCheckpoint(run: FencedRunRef, checkpoint: Checkpoint): Promise<CheckpointRef>;
  recordNodeTransition(run: FencedRunRef, transition: NodeTransition): Promise<void>;
}
```

Implementations:

- `PostgresRuntimeStateStore` for the local host and contract tests;
- `RemoteRuntimeStateStore` for the Foundry container;
- a private `runtime-state` endpoint in the control plane that validates the Foundry agent's Entra identity, execution envelope, run/attempt, and current fencing epoch before touching PostgreSQL.

Checkpoint writes must be idempotent and content-digested. A stale agent can read only the bounded invocation state and cannot write after its fence changes. When this adapter is live, remove `RUNTIME_CHECKPOINT_DATABASE_URL` from the Hosted Agent definition. If this work is intentionally deferred for an early smoke deployment, use an in-memory checkpointer only for a single non-resumable synthetic invocation and label that deployment as a connectivity smoke test, not the Azure POC milestone.

## 6. Foundry Hosted Agent integration

The existing `AzureFoundryRuntimeProvider` already obtains an Entra token, invokes an endpoint, wraps the provider message, and validates the provider-neutral result. Complete the integration as follows:

1. Package `runtime-host` as the Hosted Agent container protocol wrapper, without worker lease ownership.
2. Declare the Invocations protocol version required by the deployed agent.
3. Read platform-provided `FOUNDRY_*` values inside the hosted container; do not redeclare reserved values.
4. Build and push the runtime image with a unique tag and capture its digest.
5. Create a new immutable agent version in the environment's Foundry project.
6. Wait for the version to become active, run the conformance suite, and then update the dispatcher binding.
7. Grant the dispatcher identity only the Foundry project/agent invocation permission it needs.
8. Grant the Foundry-created agent identity only permission to invoke the capability gateway and runtime-state routes. It receives no PostgreSQL, Key Vault secret, Blob evidence, or direct model/vendor role.
9. Record Foundry project resource ID, agent ID/name, agent version, image digest, execution-profile digest, provider invocation/session metadata, and trace correlation for each run.
10. Implement provider status and cancellation before claiming parity with the local provider.

Hosted agents receive a dedicated Entra identity, a managed endpoint, and platform-injected environment values. The documented lifecycle is image/source deployment, agent version creation, activation polling, and endpoint invocation. See [Foundry Agent Service overview](https://learn.microsoft.com/en-us/azure/ai-foundry/agents/overview), [deploy a hosted agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/deploy-hosted-agent), [hosted agent runtime contract](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/hosted-agent-contract), and [Foundry REST reference](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/aiproject).

### Runtime configuration switch

```yaml
runtime:
  provider: azure_foundry
  contractVersion: runtime.invocation.v1
  azure:
    projectEndpoint: https://<account>.services.ai.azure.com/api/projects/<project>
    agentName: ehf-runtime
    agentVersion: <immutable-version>
    invocationEndpoint: <resolved-endpoint>
    tokenScope: https://ai.azure.com/.default
```

Only the dispatcher reads this binding. Domain packages and compiled plans must not contain environment endpoints or credentials.

## 7. Identity and authorization model

### Human path

```text
Entra user
 -> Static Web Apps authentication
 -> SWA role gate
 -> linked api-edge
 -> PrincipalResolver
 -> API action/resource authorization
 -> canonical service
```

For the POC, make the Entra provider single-tenant and disable other identity providers. Map Entra groups to application roles through a controlled assignment process. Demonstrate at least reader, author/operator, reviewer, and auditor personas.

### Workload path

| Caller | Target | Credential | Required application role |
| --- | --- | --- | --- |
| `api-edge` MI | control API | Entra token | `Control.Api.Access` |
| `api-edge` MI | case API | Entra token | `Case.Api.Access` |
| dispatcher MI | Foundry | Entra token | least-privilege Foundry invocation role |
| hosted agent identity | capability gateway | Entra token + execution envelope | `Capability.Invoke` + envelope grants |
| capability gateway MI | Key Vault/provider | Entra token | exact data-plane role only |
| application MIs | PostgreSQL | Entra DB token | matching PostgreSQL role |
| GitHub deploy MI | ARM/ACR | OIDC federation | environment-scoped deployment roles |

Do not reuse a single managed identity across all services. Use system-assigned identities for ordinary service access and user-assigned identities where lifecycle stability is required, especially GitHub deployment, migrations, and the dispatcher binding.

### Authorization evidence

Every protected action should emit a bounded authorization decision containing:

- principal object/subject ID and actor type;
- tenant and resource identifiers;
- action and required role/policy;
- allow/deny outcome and stable reason code;
- run, plan, permission, case, or fencing digest references where relevant;
- trace ID and timestamp.

Never log bearer tokens, complete JWT claims, SWA principal payloads, prompts, or case content.

## 8. Observability plan

### Telemetry path

```text
Browser correlation ID
 -> api-edge server span
 -> control/case API span
 -> dispatcher span
 -> Foundry invocation span
 -> hosted runtime workflow spans
 -> capability authorization + model/tool spans
 -> PostgreSQL/HTTP dependency spans
 -> Application Insights / Log Analytics
```

Preserve the implemented hierarchy:

```text
harness.run
  runtime.invoke
    workflow.transition
      capability.request
        capability.invoke
          authorization.evaluate
          model.inference | tool.execution
```

Add these resource attributes to every service: `service.name`, `service.version`, `deployment.environment.name`, `cloud.region`, image digest, revision name, runtime-provider kind, and safe Foundry agent version.

### POC dashboards

Create one Azure Workbook with:

- run throughput and terminal outcome;
- p50/p95 run and capability latency;
- denial count by safe reason code;
- model/tool call count, token usage, and known cost;
- active leases, stale fences, retries, and failure rate;
- Container Apps replicas/restarts/CPU/memory;
- PostgreSQL connections/CPU/storage;
- end-to-end trace search by `runId`, `caseId`, and `traceId` using hashed or approved identifiers.

Create alerts for API 5xx, dispatcher stalled, run failure ratio, PostgreSQL saturation, revision restart loop, Foundry invocation failure, and missing telemetry heartbeat. Durable run events and receipts remain authoritative if telemetry is sampled or delayed.

## 9. Infrastructure as code modules

Add the following structure:

```text
infra/
  main.bicep
  modules/
    identity.bicep
    monitoring.bicep
    network.bicep
    registry.bicep
    key-vault.bicep
    postgres.bicep
    container-apps-environment.bicep
    container-app.bicep
    container-job.bicep
    static-web-app.bicep
    foundry-binding.bicep
    blob-storage.bicep          # optional in first deployment
    service-bus.bicep           # optional
    api-management.bicep        # optional
  environments/
    poc.bicepparam
    dev.bicepparam
    prod.example.bicepparam
```

Module rules:

- Modules return resource IDs, endpoints, principal IDs, and audience values; they do not output secrets.
- Every resource has environment, owner, repository, data-classification, and cost-center tags.
- Each module has an `enabled` switch where genuinely optional; required security controls have no off switch in Azure mode.
- Container image inputs are digests.
- Foundry binding inputs are project resource ID, project endpoint, agent name, and immutable agent version.
- Environment parameters select capacity/SKU only; application contracts do not vary by environment.
- `what-if` runs on pull requests and deployment uses the reviewed template artifact.

`identity.bicep` should create Azure managed identities and Azure RBAC assignments. Entra application registrations, app roles, group assignments, and federated credentials are tenant-directory objects; provision them with an idempotent Microsoft Graph bootstrap step (or an approved Terraform/Entra module) and feed their IDs into Bicep parameters. Do not hide manual portal-created identity objects behind undocumented parameters.

### POC network profile

Use a Container Apps workload-profiles environment with VNet integration and internal ingress for all non-edge services. Give PostgreSQL private access and private DNS. Static Web Apps remains public with Entra authentication. The SWA-linked `api-edge` must use the platform-created linked identity provider so only proxied `/api` traffic is accepted.

The linked-backend feature does not support a network-isolated backend. That is acceptable only for the synthetic-data showcase because the linked identity provider restricts traffic. For a production/private-access evolution, replace the public SWA edge with Front Door/APIM plus direct Entra access tokens, or host the UI/BFF inside the private application boundary. Do not claim the POC topology is the final regulated network design.

## 10. GitHub integration and delivery

Use GitHub Actions only through Entra workload identity federation; do not store Azure client secrets or long-lived publish profiles. Microsoft documents GitHub OIDC federation for an Entra application or user-assigned managed identity: [authenticate Azure from GitHub Actions with OIDC](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect).

### Workflows

```text
.github/workflows/
  validate.yml              # typecheck, tests, compiler checks, Bicep lint/build
  infra-plan.yml            # Bicep what-if on PR
  deploy-foundation.yml     # environment-scoped infrastructure
  build-images.yml          # build, scan, SBOM, sign, push by digest
  deploy-apps.yml           # Container App revisions + migration job
  deploy-ui.yml             # static export and SWA deploy
  deploy-foundry-agent.yml  # register version, wait active, conformance tests
  promote.yml               # digest/version promotion with approval
  smoke.yml                 # identity, trace, run, case, denial tests
```

### Environments

Create GitHub environments `poc`, `dev`, and `prod` with independent federated credentials and Azure identities. Protect `prod` with reviewers, branch restrictions, and a no-floating-tags policy. The POC workflow may deploy automatically from `main` after validation, but Foundry version promotion and database migrations should remain explicit jobs with captured evidence.

### Promotion unit

Write a deployment manifest for each release:

```json
{
  "sourceRevision": "<git-sha>",
  "infraArtifactDigest": "sha256:...",
  "uiArtifactDigest": "sha256:...",
  "serviceImages": {"control-api": "...@sha256:..."},
  "foundryAgent": {"name": "ehf-runtime", "version": "...", "imageDigest": "sha256:..."},
  "migrationVersion": "...",
  "configurationDigest": "sha256:..."
}
```

Promote this manifest between environments. Rebuilding for production creates a different artifact and is not promotion.

## 11. Environment configuration

Use an explicit platform mode and reject invalid combinations at startup.

| Setting | Local | Azure POC |
| --- | --- | --- |
| `PLATFORM_MODE` | `local` | `azure` |
| `IDENTITY_PROVIDER` | `local_headers` | `entra` |
| `DATABASE_AUTH_MODE` | `connection_string` | `managed_identity` |
| `RUNTIME_PROVIDER` | `local_http` | `azure_foundry` |
| `EXECUTION_SIGNER` | `hmac` | `key_vault_rsa` |
| `ARTIFACT_BACKEND` | `postgres` | `azure_blob` or `postgres` in increment 1 |
| `WORK_SIGNAL_BUS` | `postgres_poll` | `postgres_poll` initially; `service_bus` optional |
| `OTEL_EXPORT_MODE` | `jaeger_otlp` | `azure_monitor_otlp` |
| `TRACE_LINK_PROVIDER` | `jaeger` | `application_insights` |

Azure startup invariants:

- reject `RUNTIME_HOST_AUTH_TOKEN` and `EXECUTION_ENVELOPE_SECRET`;
- reject database URLs containing passwords;
- require TLS verification and private PostgreSQL hostname;
- require immutable Foundry agent version and image digest metadata;
- require tenant ID and expected audiences;
- require an Azure credential to resolve before readiness succeeds;
- never fall back to the recorded model adapter when Azure mode expects a real provider; fail closed and report readiness degradation.

## 12. Phased implementation

### Phase 0 — decisions and tenancy (1–2 days)

- Confirm Azure tenant, subscription, region, resource-group naming, GitHub organization/repository, Foundry project, and synthetic-data-only scope.
- Confirm the deployed Hosted Agent protocol/version and endpoint.
- Create POC role assignments and test personas.
- Decide whether Blob, Service Bus, and APIM are in the showcase or deferred modules.

**Exit:** approved parameter sheet and no unresolved endpoint/tenant placeholders.

### Phase 1 — application seams (3–5 days)

- Add `PlatformConfig`, principal resolver/authorizer, access-token provider, database connection provider, and asymmetric execution-envelope interfaces.
- Add the runtime state/checkpoint boundary so the hosted runtime does not require PostgreSQL credentials.
- Add `api-edge` and replace trusted local headers at the cloud boundary.
- Refactor the UI to a static export and `/api` client.
- Add Azure trace-link provider.
- Keep local adapters and Compose tests green.

**Exit:** the full local demo runs through `api-edge`; forged actor/tenant headers are rejected in Azure mode; the remote runtime path passes checkpoint/fencing contract tests without database credentials.

### Phase 2 — Azure foundation (3–5 days)

- Implement Bicep modules for identities, VNet/DNS, ACR, monitoring, Key Vault, PostgreSQL, Container Apps, and SWA.
- Configure Entra app registration, app roles, and workload audiences.
- Configure GitHub OIDC environments.
- Create managed-identity PostgreSQL roles and deploy migrations with the job identity.

**Exit:** empty Azure stamp deploys repeatably; no application secret is required for Azure, ACR, Foundry, or PostgreSQL.

### Phase 3 — services and observability (2–4 days)

- Build and deploy digest-pinned service images.
- Configure internal ingress and service-to-service tokens.
- Send traces/logs to Application Insights and create the POC workbook/alerts.
- Deploy the static UI and link `api-edge`.

**Exit:** authenticated personas can use the UI; private services reject direct or unauthorized calls; one request traces across UI edge, APIs, and database.

### Phase 4 — Foundry binding (2–4 days)

- Package/deploy the hosted runtime wrapper.
- Register an immutable agent version and grant the dedicated agent identity only capability access.
- Switch the dispatcher to `azure_foundry`.
- Run invoke, duplicate, timeout, cancellation, stale-fence, gateway-denial, and trace propagation tests.

**Exit:** an end-to-end KYC run executes in Foundry and all capability effects pass through the gateway with correlated authorization evidence.

### Phase 5 — optional architecture showcase modules (2–5 days)

- Enable Blob evidence adapter.
- Enable Service Bus work-signal adapter and KEDA scaling.
- Add APIM in front of the capability gateway if APIM policy/RBAC is a required demo layer.
- Add private endpoints and stricter egress controls where supported by the chosen Foundry/network modes.

**Exit:** each enabled module passes its contract suite, and disabling it returns to the simpler POC adapter without changing domain contracts.

## 13. Acceptance tests

### Deployment

- A new resource group can be deployed from parameters and GitHub OIDC with no manual secret copy.
- Every Container App revision reports the expected image digest and release manifest.
- Database migrations run once and are idempotent.
- Destroy/redeploy of stateless resources does not lose PostgreSQL authority records.

### Identity and authorization

- Anonymous UI access is redirected or denied.
- A reader cannot author, publish, operate, or review.
- An author cannot perform an approver-only action in the separation-of-duties demonstration.
- Forged `x-actor-id`, `x-tenant-id`, and SWA principal headers are ignored/rejected.
- A workload with a valid Entra token but missing app role is denied.
- An expired/stale execution envelope or fencing epoch is denied and recorded.
- The hosted agent cannot read PostgreSQL, evidence Blob, or Key Vault secrets directly.

### Runtime

- The same compiled plan succeeds with `local_http` and `azure_foundry` against the provider contract suite.
- Foundry agent name/version and execution-profile digest are recorded with the run.
- Duplicate invocation is idempotent.
- Timeout, cancellation, provider failure, and stale worker cannot create an unrecorded effect.
- All model/tool calls pass through `capability-gateway`.

### Data

- Applications connect to PostgreSQL with managed identity and verified TLS.
- Each service is denied access outside its PostgreSQL grants.
- Case command, case event, run transition, gateway receipt, and evidence reference remain transactionally consistent.
- Backup/restore is demonstrated for synthetic POC data.

### Observability

- A user action can be followed by `traceId` through edge, API, dispatcher, Foundry runtime, and capability gateway.
- Denials appear as business/security outcomes, not false platform failures.
- Telemetry contains no prompts, response bodies, case payloads, credentials, or full execution claims.
- Dashboard and alert tests generate expected signals.

## 14. POC versus production boundary

The Azure POC may truthfully demonstrate native identity, workload authorization, managed Foundry execution, private backend services, passwordless database access, immutable deployment references, and end-to-end observability. It must not be presented as production-ready until the following are completed:

- private enterprise ingress and the final SWA/edge decision;
- target-region/SKU/quota validation and Foundry preview/feature review;
- formal policy, retention, WORM/legal-hold, residency, and data-classification approval;
- full egress deny/allow-list testing;
- high availability, disaster recovery, backup restore, key rotation, and break-glass drills;
- penetration testing, threat modeling, Defender/Sentinel integration, and operational ownership;
- provider cancellation/recovery conformance and removal of runtime direct database checkpoint access;
- scale, connection-pool, model-quota, and cost tests;
- production separation of author, approver, deployer, operator, analyst, and reviewer duties.

## 15. Known repository gaps this plan closes

| Current POC behavior | Azure change |
| --- | --- |
| UI is a standalone Next.js server | Static export on SWA plus `api-edge` BFF |
| UI calls several internal service URLs | One `/api` linked backend and private routing |
| `x-actor-id` can default to `local-author` | Actor comes from verified principal |
| `x-tenant-id` is accepted as authority | Tenant comes from verified assignment |
| Service calls use static bearer tokens | Managed identity Entra tokens and app roles |
| Execution envelope uses shared HS256 secret | Key Vault RSA signing and public-key verification |
| PostgreSQL uses password connection strings | Entra-only managed-identity tokens |
| Jaeger-specific trace links | Application Insights trace-link adapter |
| Trace-only OTLP setup | Azure Monitor traces/logs, platform metrics, workbook, alerts |
| Local evidence bytes in PostgreSQL | Optional Blob artifact adapter |
| PostgreSQL polling only | Optional Service Bus signal adapter |
| Foundry endpoint is manually configured | GitHub/azd or REST version deployment and manifest promotion |
| One general backend Docker image | Digest-pinned service revisions with per-service identity |

## 16. Recommended first backlog

1. `AZ-001`: introduce validated `PlatformConfig` and Azure startup invariants.
2. `AZ-002`: create principal/authorization adapters and remove header-derived authority in Azure mode.
3. `AZ-003`: add `api-edge` and downstream managed-identity client.
4. `AZ-004`: convert `control-ui` to static export and `/api` calls.
5. `AZ-005`: add managed-identity PostgreSQL connection provider and per-service roles.
6. `AZ-006`: add Key Vault asymmetric execution-envelope signer/verifier.
7. `AZ-007`: complete Azure Monitor exporter, trace links, workbook, and alerts.
8. `AZ-008`: create core Bicep modules and `poc.bicepparam`.
9. `AZ-009`: create GitHub OIDC validation/build/deploy workflows and release manifest.
10. `AZ-010`: remove Hosted Agent database access with the remote runtime state/checkpoint adapter.
11. `AZ-011`: package and promote the existing runtime as a Foundry Hosted Agent version.
12. `AZ-012`: run dual-provider conformance and end-to-end identity/denial tests.
13. `AZ-013`: optionally enable Blob evidence, Service Bus signaling, and APIM modules.

The first demonstrable milestone is `AZ-001` through `AZ-012`. The optional modules should not delay proving the central story: a signed plan is admitted by the control plane, dispatched with managed identity to an immutable Foundry agent version, constrained by a short-lived execution envelope, routed through the capability gateway, committed through canonical services to PostgreSQL, and observable end to end in Azure Monitor.
