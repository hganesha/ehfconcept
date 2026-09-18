# Runtime isolation and Azure migration runbook

**Status:** Increment A implemented locally; Azure deployment and database-free Increment B remain
**Decision:** treat the agent runtime as a replaceable execution provider now, even while it is tested locally. Target Microsoft Foundry Hosted Agents for the Azure-managed runtime, with Azure Container Apps retained as the portability fallback.

## 1. Outcome

The harness compiler, `HarnessPlan`, execution control plane, capability gateway, case APIs, and evidence contracts must not know whether a run executes in the local LangGraph container or in Microsoft Foundry. The only switch is a resolved runtime binding in environment configuration and the signed `ExecutionProfile`.

```text
Control API / scheduler
        |
        v
Runtime dispatcher ---- RuntimeProvider contract ----------------+
        |                                                        |
        +-> local_http -> isolated local runtime container       |
        |                                                        |
        +-> azure_foundry -> Foundry Hosted Agent endpoint ------+
                                  |
                                  v
                         Capability Gateway only

Completion callback/result -> execution ledger -> Case command gate
```

The local container is a different **runtime boundary**, but local Docker alone is not equivalent to Azure's identity, network, session, or sandbox isolation. Those controls must be tested again against a deployed Hosted Agent. Microsoft explicitly notes that local Hosted Agent runs do not enforce the deployed per-user session isolation: [isolate Hosted Agent sessions](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/isolate-sessions-per-user).

## 2. Implemented POC boundary

The current implementation now has an explicit provider boundary:

- `packages/contracts` defines the versioned `RuntimeInvocation` and `RuntimeInvocationResult` schemas.
- `packages/runtime-provider` implements `local_http` and `azure_foundry` dispatcher adapters and derives a stable execution-profile digest from the resolved provider binding.
- `apps/runtime-worker` is now the dispatcher: it claims work, owns lease renewal/fencing, invokes a provider, and commits the terminal run result.
- `apps/runtime-host` is an independently authenticated HTTP host: it validates the invocation, lowers the plan through `packages/runtime-langgraph`, and returns a provider-neutral result.
- `compose.yaml` runs `runtime-dispatcher` and a read-only-root `runtime-host-local` as separate services. Only the gateway and runtime host receive the current HMAC execution-envelope secret.

The remaining isolation debt is explicit: `runtime-host-local` receives `RUNTIME_CHECKPOINT_DATABASE_URL` because LangGraph checkpoints and node-attempt journaling still use PostgreSQL directly. It no longer claims work or commits terminal run state. Increment B replaces that credential with a dispatcher/state API or dedicated checkpoint service before production Azure admission.

## 3. Provider-neutral runtime contract

Create a small `RuntimeProvider` interface in a package that has no LangGraph or Azure SDK dependency:

```ts
type RuntimeProvider = {
  invoke(request: RuntimeInvocation, signal: AbortSignal): Promise<RuntimeAcceptance>;
  getStatus(invocationId: string): Promise<RuntimeStatus>;
  cancel(invocationId: string, reason: string): Promise<void>;
};
```

`RuntimeInvocation` is versioned and contains only transport-safe references and bounded inputs:

| Field | Requirement |
| --- | --- |
| `contractVersion` | Pinned value such as `runtime.invocation.v1` |
| `invocationId`, `runId`, `attempt` | Globally unique and idempotent |
| `planDigest`, `executionProfileDigest` | Immutable authority references |
| `leaseId`, `fencingEpoch`, `deadlineAt` | Required for stale-worker and timeout rejection |
| `executionEnvelope` | Short-lived, audience-bound signed token; never a reusable secret |
| `input` or `contextManifestRef` | Schema-validated, minimized payload |
| `callback` | Trusted completion/status target or dispatcher correlation reference |
| `traceparent` | W3C trace propagation across the trusted boundary |

The response/result is also provider-neutral: acceptance state, provider invocation ID, typed output or failure code, usage, evidence references, execution-record digest, and trace correlation. Provider-specific session IDs, Foundry version IDs, or container revision IDs are metadata, never case truth.

Use two adapters:

- `local_http`: invokes the same container over a private Docker network.
- `azure_foundry`: obtains an Entra token and invokes the Hosted Agent's stable Invocations endpoint.

The non-conversational [Hosted Agent Invocations protocol](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/deploy-hosted-agent) is the best match for a leased harness WorkItem. Do not map a WorkItem to a free-form chat conversation.

## 4. Local isolation steps

Implementation status:

1. **Implemented:** extract execution behind `RuntimeInvocation`; keep LangGraph lowering framework-specific.
2. **Implemented:** keep claiming, lease renewal, fencing, retry ownership, and terminal completion in the dispatcher.
3. **Implemented:** expose authenticated `/invocations` on an internal-only local runtime host.
4. **Implemented:** split Compose into `runtime-dispatcher` and `runtime-host-local`, with separate health checks and a read-only host filesystem.
5. **Transitional:** the host uses separately named `RUNTIME_CHECKPOINT_DATABASE_URL`; provision a least-privilege database role before shared testing.
6. **Partially implemented:** the host has no model/vendor keys and reaches models/tools through the capability gateway, but still has the POC HMAC signer until an Entra-backed execution-token broker replaces it.
7. **Partially implemented:** schema/auth/configuration tests exist; full two-provider cancellation, restart, duplicate, stale-fence, and Azure conformance fixtures remain.
8. **Remaining:** enforce and test runtime egress denial at the container/network layer.

This can be delivered in two increments. Increment A creates a separate process/container and provider contract while retaining a narrowly scoped checkpoint credential. Increment B removes runtime database access and is the required gate before calling the local topology cloud-parity.

## 5. Configuration that migrates cleanly

Keep the provider choice outside `HarnessPlan`. Resolve it into a signed `ExecutionProfile` so an in-flight run cannot change runtime after admission.

```yaml
runtime:
  provider: local_http # local_http | azure_foundry
  contractVersion: runtime.invocation.v1
  requestTimeoutSeconds: 150
  callbackAudience: api://harness-execution
  local:
    endpoint: http://runtime-host-local:8088/invocations
  azure:
    projectEndpoint: ${FOUNDRY_PROJECT_ENDPOINT}
    agentName: ${FOUNDRY_AGENT_NAME}
    agentVersion: ${FOUNDRY_AGENT_VERSION}
    invocationEndpoint: ${FOUNDRY_AGENT_INVOCATION_ENDPOINT}
    tokenScope: https://ai.azure.com/.default
```

Recommended deployment variables:

| Variable | Local | Azure | Notes |
| --- | --- | --- | --- |
| `RUNTIME_PROVIDER` | `local_http` | `azure_foundry` | Only dispatcher reads it |
| `RUNTIME_CONTRACT_VERSION` | Same value | Same value | Reject incompatible hosts |
| `RUNTIME_LOCAL_ENDPOINT` | Internal Compose URL | Unset | Not included in plans |
| `FOUNDRY_PROJECT_ENDPOINT` | Unset | Environment-specific | No customer data in the value |
| `FOUNDRY_AGENT_NAME` | Unset | Stable logical name | Bind with version below |
| `FOUNDRY_AGENT_VERSION` | Unset | Immutable promoted version | Record in every execution |
| `FOUNDRY_AGENT_INVOCATION_ENDPOINT` | Unset | Stable agent endpoint | Prefer the new agent object model |
| `AZURE_CLIENT_ID` | Unset for developer credentials | Dispatcher managed identity if needed | No client secret |
| `CAPABILITY_GATEWAY_URL` | Private Compose URL | Private APIM/gateway URL | Same logical contract |

Do not place secrets in this YAML, `azure.yaml`, a `HarnessPlan`, or agent environment variables. Use managed identity and Key Vault-backed connections where a secret-backed integration cannot be avoided.

## 6. Azure runtime deployment and promotion

### 6.1 One-time foundation

1. Create separate non-production and production Foundry projects, identities, networking, ACR, telemetry, and deployment authorities. Do not deploy production from a developer identity.
2. Select the Hosted Agent network mode and validate it in the target subscription and region. For regulated workloads, use BYO VNet/private dependencies and explicitly test ingress and egress. Current setup and limitations are documented in [Foundry private networking](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/virtual-networks).
3. Reuse the platform's Premium ACR when approved. Disable the admin account, use private connectivity, and grant only image pull to the required Foundry project identity. Private ACR support depends on project/platform conditions, so validate the actual project rather than assuming the planning YAML proves support.
4. Create a dispatcher managed identity. Grant it only the role/data action required to invoke the target agent. The Hosted Agent identity receives only capability-gateway invocation and telemetry permissions; it gets no case database, evidence store, vendor, signing, or Harness Registry write role.
5. Establish private DNS, firewall rules, diagnostic settings, App Insights/OpenTelemetry, policy assignments, quotas, budgets, and alerts before production data is admitted.

### 6.2 Package the runtime

1. Add the Microsoft Hosted Agent protocol wrapper around the provider-neutral executor and expose `/invocations` on the required port.
2. Build and test the exact container locally against the conformance suite.
3. Build for `linux/amd64`; Foundry requires that architecture even when development occurs on Apple Silicon.
4. Generate an SBOM and vulnerability report, sign the OCI artifact, push it to ACR, and resolve the immutable image digest. Never promote `latest` or a tag alone.
5. Store image digest, source commit, build provenance, contract version, LangGraph adapter version, and test evidence in the Harness Registry candidate record.

### 6.3 Deploy a Hosted Agent version

Use a dedicated deployment directory with an `azure.yaml` whose `azure.ai.agent` service is `kind: hosted`, uses the Invocations protocol, and references the existing environment-specific Foundry project/ACR. `azure.yaml` is deployment configuration; it is not the Harness Factory's executable authority.

For a first environment, run `azd provision` and then `azd deploy`; for code-only revisions, run `azd deploy`. The current Azure Developer CLI flow builds/pushes the image, creates an immutable Hosted Agent version, establishes the agent identity/RBAC it manages, and preserves prior versions. Verify the result with `azd ai agent show`. See [deploy a Hosted Agent](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/deploy-hosted-agent) and the [`azure.yaml` reference](https://learn.microsoft.com/en-us/azure/foundry/agents/concepts/azure-yaml-reference).

After deployment:

1. Wait until the exact agent version reports `active`; do not route traffic while it is provisioning.
2. Capture the agent name, immutable version, stable invocation endpoint, image digest, agent identity object ID/blueprint ID, Foundry project resource ID, region, protocols, and deployment timestamp.
3. Reconcile all automatic RBAC assignments. Remove broad defaults that are not needed and add only the downstream permission required to call the capability gateway.
4. Invoke a synthetic request through the dispatcher, not directly from a workstation, and verify token audience, network route, callback, trace, budget, and denial behavior.
5. Run the full conformance and evaluation suites. Produce a signed evaluation attestation bound to the image digest and agent version.

### 6.4 Register and promote

Keep three different records distinct:

| Record | Purpose | Runtime authority? |
| --- | --- | --- |
| ACR | Stores the immutable runtime image | No |
| Foundry Agent/agent version | Azure deployment, endpoint, identity, and version | No, until bound by a Harness release |
| Harness Registry `RuntimeArtifact` | Binds image digest + Foundry project + agent/version + endpoint + identity + attestation | **Yes**, through the signed `ExecutionProfile` |
| Microsoft Entra/Agent 365 registry | Enterprise discovery, ownership, and governance inventory | No |

Register the deployed identity/blueprint in the enterprise agent registry when organizational governance requires it, and store that registry object ID as a cross-reference in `RuntimeArtifact`. Registry presence must never authorize a plan, capability, or case operation.

Microsoft's current agent object model gives newly created agents a unique identity and stable endpoint at creation. There is no separate publish step needed merely to let the harness dispatcher invoke that endpoint. In the new model, **publish** primarily means distribution to Microsoft 365/Teams; that is optional and normally inappropriate for this headless runtime. Legacy Agent Applications use a different resource/identity model and are being superseded. Validate the active tenant experience against [the migration guidance](https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/migrate-agent-applications) before automating promotion.

Promotion sequence:

1. Admit the `RuntimeArtifact` candidate only after digest, identity, network, evaluation, and conformance evidence verifies.
2. Create an immutable `ExecutionProfile` that references the exact runtime artifact and Hosted Agent version.
3. Sign and release the profile through the existing Harness release approval path.
4. Change the environment runtime pointer with compare-and-swap; start with synthetic/shadow traffic, then a small cohort.
5. Monitor technical failures, policy denials, latency, cost, capability receipts, and business guardrails. Do not compare only model text.
6. Advance the cohort only after the configured observation gate passes.

## 7. Cutover from local to Azure

The cutover changes deployment configuration and a signed runtime binding, not domain packages or HarnessPlans:

1. Freeze the candidate image and local conformance result.
2. Deploy the identical digest to non-production Foundry and pass Azure conformance, network, identity, and evaluation gates.
3. Register the Azure `RuntimeArtifact` and release an `ExecutionProfile` referencing it.
4. Set the non-production dispatcher to `RUNTIME_PROVIDER=azure_foundry`, restart it, and verify that new runs resolve the released profile. Existing runs remain pinned to their original provider/version.
5. Repeat deployment and attestation in production; never copy a non-production endpoint or identity into production configuration.
6. Promote by cohort. Retain `local_http` only for development and deterministic tests; retain the prior Azure agent version for rollback.

Rollback is a pointer operation to a previously released `ExecutionProfile`/agent version. Stop new admission to the bad version, allow safe in-flight work to finish or cancel it according to its effect class, reconcile unknown side effects, and never replay a non-idempotent capability blindly.

## 8. Acceptance checklist

- The dispatcher can run the same compiled plan through `local_http` and `azure_foundry` with no plan changes.
- The local runtime is a separate container/process and has no general control-plane or case database credential.
- The Azure runtime is an immutable Hosted Agent version backed by a digest-pinned `linux/amd64` image.
- Provider, endpoint, agent version, identity, image digest, contract version, and trace ID are recorded for every run.
- The Hosted Agent can call only the capability gateway and approved telemetry/control callbacks.
- Duplicate, stale-fence, cancellation, timeout, budget, restart, and gateway-denial tests pass on both providers.
- Azure evaluation evidence is bound to the exact version promoted in the Harness Registry.
- Agent 365/Entra registry information is treated as governance metadata, not executable authority.
- A tested rollback selects a prior signed profile without recompiling domain packages.
