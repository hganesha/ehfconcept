// Workloads for the POC stamp: the migration job, five backend services, the
// trace sink, and the control surface.
//
// Run after main.bicep, after images exist in the registry, and after
// scripts/azure/seed-secrets.sh has populated the vault. Every secret arrives as
// a Key Vault reference resolved by the app's own managed identity at revision
// start, so no secret value passes through this template or its deployment
// history.
//
//   az deployment group create -g <rg> -f infra/apps.bicep \
//     -p infra/environments/poc.apps.bicepparam \
//     -p servicesImage=<acr>/ehf/services@sha256:... uiImage=<acr>/ehf/control-ui@sha256:...
//
// Environment variables below mirror compose.yaml service by service. Changing
// one here without changing it there breaks local/Azure parity, which is the
// property the whole migration plan is built on.

targetScope = 'resourceGroup'

@description('Short organization prefix used in resource names.')
param namePrefix string = 'hf'

@description('Environment discriminator used in resource names.')
param environmentSuffix string = 'poc'

@description('Azure region. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Tags applied to every resource.')
param tags object

@description('Container Apps environment name created by main.bicep.')
param containerAppsEnvironmentName string

@description('Container registry login server.')
param registryLoginServer string

@description('Key Vault URI, without a trailing slash.')
param keyVaultUri string

@description('Digest-pinned image for every Node service. Never a tag.')
param servicesImage string

@description('Digest-pinned image for the Next.js control surface. Never a tag.')
param uiImage string

@description('Key Vault secret holding the PostgreSQL connection string.')
param databaseSecretName string = 'database-url'

@description('Key Vault secret holding the shared execution-envelope signing secret. Replaced by Key Vault RSA signing under AZ-006.')
param envelopeSecretName string = 'execution-envelope-secret'

@description('Key Vault secret holding the runtime host bearer token.')
param runtimeTokenSecretName string = 'runtime-host-token'

@description('Key Vault secret holding the control-surface edge service token.')
param edgeServiceTokenSecretName string = 'edge-service-token'

@description('Key Vault secret holding the runtime workload service token.')
param runtimeServiceTokenSecretName string = 'runtime-service-token'

@description('Key Vault secret holding the dispatcher grant secret it exchanges for per-node envelopes.')
param runtimeGrantSecretName string = 'runtime-grant-secret'

@description('Key Vault secret holding the model provider key. Leave empty to run the deterministic recorded adapter, exactly as the local stack does without a key.')
param modelProviderSecretName string = ''

@description('Tenant the local identity provider assigns. In azure mode the tenant comes from the verified principal instead.')
param caseTenantId string = 'tenant_demo'

// The services assert startup invariants for this mode. `azure` forbids every
// shared secret below, forbids a password-bearing database URL, and requires
// ENTRA_TENANT_ID, ENTRA_API_AUDIENCE, and PLATFORM_TENANT_ID. Those invariants
// cannot be satisfied yet: packages/persistence still builds its pool from a
// connection string, so passwordless PostgreSQL is still AZ-005. Deploying this
// stamp in `local` mode is therefore deliberate and is stated as such in the
// runbook's gap register, not an oversight.
@description('Platform mode asserted at service startup. Keep local until AZ-005 lands; azure mode refuses to boot with the configuration this stamp deploys.')
@allowed(['local', 'azure'])
param platformMode string = 'local'

@description('Identity provider. local_headers trusts the edge service token; entra validates Entra tokens.')
@allowed(['local_headers', 'entra'])
param identityProvider string = 'local_headers'

// postgres keeps runs resumable and is the local default. memory lets the
// runtime deploy with no database credential at all, which is what a hosted
// agent outside the platform's trust boundary needs, at the cost of
// resumability across a restart.
@description('LangGraph checkpoint store for the runtime host.')
@allowed(['postgres', 'memory'])
param runtimeCheckpointBackend string = 'postgres'

@description('Principal the control surface acts as in local identity mode.')
param controlUiActorId string = 'local-author'

@description('Roles for that principal. Deliberately excludes Harness.Approver.')
param controlUiActorRoles string = 'Harness.Reader,Harness.Author,Harness.Operator,Case.Analyst,Case.Reviewer'

@description('Separate approver principal, so publication cannot be self-approved.')
param controlUiApproverId string = 'local-approver'

@description('Roles for the approver principal.')
param controlUiApproverRoles string = 'Harness.Reader,Harness.Approver'

@description('Runtime provider binding. azure_foundry additionally requires the Foundry parameters and the hosted-agent wrapper from AZ-011.')
@allowed(['local_http', 'azure_foundry'])
param runtimeProvider string = 'local_http'

@description('Foundry agent invocation endpoint. Required when runtimeProvider is azure_foundry.')
param foundryAgentInvocationEndpoint string = ''

@description('Foundry agent name. Required when runtimeProvider is azure_foundry.')
param foundryAgentName string = ''

@description('Immutable Foundry agent version. Required when runtimeProvider is azure_foundry.')
param foundryAgentVersion string = ''

@description('Commit SHA of the source revision being deployed, recorded on the control surface.')
param sourceRevision string = ''

@description('Public trace viewer URL. Set only if you published the trace sink behind authentication.')
param traceViewerPublicUrl string = ''

@description('Deploy only the migration job. The delivery workflow runs this first so schema changes land before any service revision starts on the new image.')
param migrationOnly bool = false

@description('Replica counts per service.')
param minReplicas int = 1

@description('Maximum replicas for services that scale.')
param maxReplicas int = 3

var appNames = {
  controlApi: 'ca-${namePrefix}-control-api'
  caseApi: 'ca-${namePrefix}-case-api'
  gateway: 'ca-${namePrefix}-capability-gateway'
  runtimeHost: 'ca-${namePrefix}-runtime-host'
  dispatcher: 'ca-${namePrefix}-runtime-dispatcher'
  ui: 'ca-${namePrefix}-control-ui'
  jaeger: 'ca-${namePrefix}-jaeger'
  migrateJob: 'job-${namePrefix}-migrate'
}

var identityNames = {
  migrate: 'id-${namePrefix}-migrate-${environmentSuffix}'
  controlApi: 'id-${namePrefix}-control-api-${environmentSuffix}'
  caseApi: 'id-${namePrefix}-case-api-${environmentSuffix}'
  gateway: 'id-${namePrefix}-capability-gateway-${environmentSuffix}'
  runtimeHost: 'id-${namePrefix}-runtime-host-${environmentSuffix}'
  dispatcher: 'id-${namePrefix}-runtime-dispatcher-${environmentSuffix}'
  ui: 'id-${namePrefix}-control-ui-${environmentSuffix}'
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: containerAppsEnvironmentName
}

resource migrateIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: identityNames.migrate
}
resource controlApiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: identityNames.controlApi
}
resource caseApiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: identityNames.caseApi
}
resource gatewayIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: identityNames.gateway
}
resource runtimeHostIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: identityNames.runtimeHost
}
resource dispatcherIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: identityNames.dispatcher
}
resource uiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: identityNames.ui
}

// Internal ingress maps port 80 on the environment's private FQDN to each app's
// target port, so only the trace sink's extra OTLP port needs to be named.
var internalDomain = 'internal.${environment.properties.defaultDomain}'
var urlControlApi = 'http://${appNames.controlApi}.${internalDomain}'
var urlCaseApi = 'http://${appNames.caseApi}.${internalDomain}'
var urlGateway = 'http://${appNames.gateway}.${internalDomain}'
var urlRuntimeHost = 'http://${appNames.runtimeHost}.${internalDomain}'
var urlJaegerQuery = 'http://${appNames.jaeger}.${internalDomain}'
var urlJaegerOtlp = '${urlJaegerQuery}:4318/v1/traces'

var databaseSecretUrl = '${keyVaultUri}/secrets/${databaseSecretName}'
var envelopeSecretUrl = '${keyVaultUri}/secrets/${envelopeSecretName}'
var runtimeTokenSecretUrl = '${keyVaultUri}/secrets/${runtimeTokenSecretName}'
var edgeServiceTokenSecretUrl = '${keyVaultUri}/secrets/${edgeServiceTokenSecretName}'
var runtimeServiceTokenSecretUrl = '${keyVaultUri}/secrets/${runtimeServiceTokenSecretName}'
var runtimeGrantSecretUrl = '${keyVaultUri}/secrets/${runtimeGrantSecretName}'

// Shared by every service so telemetry resource attributes stay consistent.
var telemetryEnv = [
  {
    name: 'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'
    value: urlJaegerOtlp
  }
  {
    name: 'OTEL_TRACES_SAMPLER_ARG'
    value: '1'
  }
  {
    name: 'DEPLOYMENT_ENVIRONMENT'
    value: environmentSuffix
  }
  {
    name: 'CLOUD_REGION'
    value: location
  }
]

// Mirrors the runtime-env anchor in compose.yaml. Every service that talks to
// the control plane asserts these at startup.
var platformEnv = [
  {
    name: 'PLATFORM_MODE'
    value: platformMode
  }
  {
    name: 'IDENTITY_PROVIDER'
    value: identityProvider
  }
  {
    name: 'LOCAL_DEFAULT_TENANT_ID'
    value: caseTenantId
  }
]

var caseStoreEnv = [
  {
    name: 'CASE_CORE_SCHEMA'
    value: 'case_core'
  }
  {
    name: 'CASE_LEDGER_SCHEMA'
    value: 'case_ledger'
  }
  {
    name: 'EVIDENCE_SCHEMA'
    value: 'evidence'
  }
  {
    name: 'CASE_ARTIFACT_BACKEND'
    value: 'postgres'
  }
  {
    name: 'CASE_EVIDENCE_REQUIRE_SCAN'
    value: 'false'
  }
  {
    name: 'CASE_EVIDENCE_MAX_BYTES'
    value: '1048576'
  }
]

var modelProviderConfigured = !empty(modelProviderSecretName)

func databaseSecret(identityId string) array => [
  {
    name: 'database-url'
    keyVaultUrl: databaseSecretUrl
    identity: identityId
  }
]

// The three shared workload tokens every control-plane service carries in local
// mode. Azure mode forbids all three; see the platformMode parameter.
func workloadTokenSecrets(identityId string) array => [
  {
    name: 'edge-service-token'
    keyVaultUrl: edgeServiceTokenSecretUrl
    identity: identityId
  }
  {
    name: 'runtime-service-token'
    keyVaultUrl: runtimeServiceTokenSecretUrl
    identity: identityId
  }
  {
    name: 'runtime-grant-secret'
    keyVaultUrl: runtimeGrantSecretUrl
    identity: identityId
  }
]

var workloadTokenEnv = [
  {
    name: 'EDGE_SERVICE_TOKEN'
    secretRef: 'edge-service-token'
  }
  {
    name: 'RUNTIME_SERVICE_TOKEN'
    secretRef: 'runtime-service-token'
  }
  {
    name: 'RUNTIME_GRANT_SECRET'
    secretRef: 'runtime-grant-secret'
  }
]

func httpProbes(port int) array => [
  {
    type: 'Liveness'
    httpGet: {
      path: '/health/live'
      port: port
    }
    initialDelaySeconds: 15
    periodSeconds: 30
    failureThreshold: 3
  }
  {
    type: 'Readiness'
    httpGet: {
      path: '/health/ready'
      port: port
    }
    initialDelaySeconds: 10
    periodSeconds: 10
    failureThreshold: 6
  }
]

// ---------------------------------------------------------------------------
// Schema migrations. Deployed here, executed by the delivery workflow with
// `az containerapp job start`, before any service revision is updated.
// ---------------------------------------------------------------------------
module migrateJob 'modules/container-job.bicep' = {
  name: 'migrate-job'
  params: {
    name: appNames.migrateJob
    location: location
    tags: tags
    environmentId: environment.id
    image: servicesImage
    identityId: migrateIdentity.id
    registryServer: registryLoginServer
    command: ['/bin/sh']
    args: ['-c', 'pnpm db:migrate']
    secrets: databaseSecret(migrateIdentity.id)
    env: concat(
      [
        {
          name: 'DATABASE_URL'
          secretRef: 'database-url'
        }
        {
          name: 'CASE_DATABASE_URL'
          secretRef: 'database-url'
        }
      ],
      caseStoreEnv
    )
  }
}

// ---------------------------------------------------------------------------
// Trace sink. All-in-one Jaeger keeps spans in memory: a restart loses trace
// history. Durable run events and gateway receipts in PostgreSQL remain the
// audit record. Replacing this with an Application Insights trace-link provider
// is AZ-007.
// ---------------------------------------------------------------------------
module jaeger 'modules/container-app.bicep' = if (!migrationOnly) {
  name: 'jaeger'
  params: {
    name: appNames.jaeger
    location: location
    tags: tags
    environmentId: environment.id
    image: 'docker.io/jaegertracing/jaeger:2.11.0'
    // Public image, no secrets: the trace sink gets no identity at all.
    identityId: ''
    registryServer: ''
    args: [
      '--set=receivers.otlp.protocols.http.endpoint=0.0.0.0:4318'
      '--set=receivers.otlp.protocols.grpc.endpoint=0.0.0.0:4317'
    ]
    ingressEnabled: true
    ingressExternal: false
    ingressTargetPort: 16686
    additionalPortMappings: [
      {
        external: false
        targetPort: 4318
        exposedPort: 4318
      }
    ]
    minReplicas: 1
    maxReplicas: 1
  }
}

// ---------------------------------------------------------------------------
// Capability gateway. Sole holder of the model credential: no other service
// receives it, and plans carry a model profile ID rather than a key.
// ---------------------------------------------------------------------------
module gateway 'modules/container-app.bicep' = if (!migrationOnly) {
  name: 'capability-gateway'
  params: {
    name: appNames.gateway
    location: location
    tags: tags
    environmentId: environment.id
    image: servicesImage
    identityId: gatewayIdentity.id
    registryServer: registryLoginServer
    command: ['/bin/sh']
    args: ['-c', 'pnpm --filter @ehf/capability-gateway start']
    ingressTargetPort: 4101
    probes: httpProbes(4101)
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    secrets: concat(
      databaseSecret(gatewayIdentity.id),
      workloadTokenSecrets(gatewayIdentity.id),
      [
        {
          name: 'envelope-secret'
          keyVaultUrl: envelopeSecretUrl
          identity: gatewayIdentity.id
        }
      ],
      modelProviderConfigured
        ? [
            {
              name: 'model-provider-key'
              keyVaultUrl: '${keyVaultUri}/secrets/${modelProviderSecretName}'
              identity: gatewayIdentity.id
            }
          ]
        : []
    )
    env: concat(
      [
        {
          name: 'GATEWAY_PORT'
          value: '4101'
        }
        {
          name: 'DATABASE_URL'
          secretRef: 'database-url'
        }
        {
          name: 'CASE_DATABASE_URL'
          secretRef: 'database-url'
        }
        {
          name: 'EXECUTION_ENVELOPE_SECRET'
          secretRef: 'envelope-secret'
        }
        {
          name: 'MODEL_PROFILES_PATH'
          value: '/app/config/model-profiles.json'
        }
        {
          name: 'TRACE_VIEWER_BASE_URL'
          value: urlJaegerQuery
        }
      ],
      caseStoreEnv,
      platformEnv,
      workloadTokenEnv,
      telemetryEnv,
      modelProviderConfigured
        ? [
            {
              name: 'OPENROUTER_API_KEY'
              secretRef: 'model-provider-key'
            }
            {
              name: 'OPENROUTER_APP_NAME'
              value: 'EHF Azure POC'
            }
          ]
        : []
    )
  }
}

// ---------------------------------------------------------------------------
// Case API: canonical case aggregate, ledger, and evidence commands.
// ---------------------------------------------------------------------------
module caseApi 'modules/container-app.bicep' = if (!migrationOnly) {
  name: 'case-api'
  params: {
    name: appNames.caseApi
    location: location
    tags: tags
    environmentId: environment.id
    image: servicesImage
    identityId: caseApiIdentity.id
    registryServer: registryLoginServer
    command: ['/bin/sh']
    args: ['-c', 'pnpm --filter @ehf/case-api start']
    ingressTargetPort: 4102
    probes: httpProbes(4102)
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    secrets: concat(
      databaseSecret(caseApiIdentity.id),
      workloadTokenSecrets(caseApiIdentity.id),
      [
        {
          name: 'envelope-secret'
          keyVaultUrl: envelopeSecretUrl
          identity: caseApiIdentity.id
        }
      ]
    )
    env: concat(
      [
        {
          name: 'CASE_API_PORT'
          value: '4102'
        }
        {
          name: 'DATABASE_URL'
          secretRef: 'database-url'
        }
        {
          name: 'CASE_DATABASE_URL'
          secretRef: 'database-url'
        }
        {
          name: 'EXECUTION_ENVELOPE_SECRET'
          secretRef: 'envelope-secret'
        }
        // The outbox sink drains and prunes case events; without it the tables
        // grow without bound and the transactional outbox is decorative.
        {
          name: 'OUTBOX_INTERVAL_MS'
          value: '5000'
        }
        {
          name: 'OUTBOX_RETENTION_DAYS'
          value: '7'
        }
        {
          name: 'MODEL_PROFILES_PATH'
          value: '/app/config/model-profiles.json'
        }
        {
          name: 'TRACE_VIEWER_BASE_URL'
          value: urlJaegerQuery
        }
      ],
      caseStoreEnv,
      platformEnv,
      workloadTokenEnv,
      telemetryEnv
    )
  }
}

// ---------------------------------------------------------------------------
// Control API: plan admission, run commands and queries, authoring lifecycle.
// Also the envelope broker: the runtime exchanges the dispatcher's grant here
// for a per-node execution envelope, so the signing secret lives here and not
// in the runtime.
// ---------------------------------------------------------------------------
module controlApi 'modules/container-app.bicep' = if (!migrationOnly) {
  name: 'control-api'
  params: {
    name: appNames.controlApi
    location: location
    tags: tags
    environmentId: environment.id
    image: servicesImage
    identityId: controlApiIdentity.id
    registryServer: registryLoginServer
    command: ['/bin/sh']
    args: ['-c', 'pnpm --filter @ehf/control-api start']
    ingressTargetPort: 4100
    probes: httpProbes(4100)
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    secrets: concat(
      databaseSecret(controlApiIdentity.id),
      workloadTokenSecrets(controlApiIdentity.id),
      [
        {
          name: 'envelope-secret'
          keyVaultUrl: envelopeSecretUrl
          identity: controlApiIdentity.id
        }
      ]
    )
    env: concat(
      [
        {
          name: 'CONTROL_API_PORT'
          value: '4100'
        }
        {
          name: 'DATABASE_URL'
          secretRef: 'database-url'
        }
        {
          name: 'CASE_DATABASE_URL'
          secretRef: 'database-url'
        }
        {
          name: 'MODEL_PROFILES_PATH'
          value: '/app/config/model-profiles.json'
        }
        {
          name: 'TRACE_VIEWER_BASE_URL'
          value: empty(traceViewerPublicUrl) ? urlJaegerQuery : traceViewerPublicUrl
        }
        {
          name: 'EXECUTION_ENVELOPE_SECRET'
          secretRef: 'envelope-secret'
        }
      ],
      caseStoreEnv,
      platformEnv,
      workloadTokenEnv,
      telemetryEnv
    )
  }
}

// ---------------------------------------------------------------------------
// Runtime host: lowers the compiled plan into LangGraph.
//
// It holds no envelope signing key and no run-journal credential: it exchanges
// the dispatcher's grant for a per-node envelope at the control plane and
// journals through it. The only database handle left is the LangGraph
// checkpoint store, and RUNTIME_CHECKPOINT_BACKEND=memory removes even that, at
// the cost of resumability -- which is what a hosted agent outside the trust
// boundary needs.
// ---------------------------------------------------------------------------
module runtimeHost 'modules/container-app.bicep' = if (!migrationOnly) {
  name: 'runtime-host'
  params: {
    name: appNames.runtimeHost
    location: location
    tags: tags
    environmentId: environment.id
    image: servicesImage
    identityId: runtimeHostIdentity.id
    registryServer: registryLoginServer
    // Invoke the checked-in runtime directly so the container never asks pnpm
    // to repair or relink the workspace at startup.
    command: ['/bin/sh']
    args: ['-c', './node_modules/.bin/tsx apps/runtime-host/src/server.ts']
    ingressTargetPort: 8088
    probes: httpProbes(8088)
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    secrets: concat(
      runtimeCheckpointBackend == 'postgres' ? databaseSecret(runtimeHostIdentity.id) : [],
      [
        {
          name: 'runtime-token'
          keyVaultUrl: runtimeTokenSecretUrl
          identity: runtimeHostIdentity.id
        }
        {
          name: 'runtime-service-token'
          keyVaultUrl: runtimeServiceTokenSecretUrl
          identity: runtimeHostIdentity.id
        }
      ]
    )
    env: concat(
      [
        {
          name: 'RUNTIME_HOST_PORT'
          value: '8088'
        }
        {
          name: 'RUNTIME_CHECKPOINT_BACKEND'
          value: runtimeCheckpointBackend
        }
        {
          name: 'RUNTIME_HOST_AUTH_TOKEN'
          secretRef: 'runtime-token'
        }
        {
          name: 'RUNTIME_SERVICE_TOKEN'
          secretRef: 'runtime-service-token'
        }
        {
          name: 'PLATFORM_MODE'
          value: platformMode
        }
        {
          name: 'ENVELOPE_BROKER_URL'
          value: urlControlApi
        }
        {
          name: 'CAPABILITY_GATEWAY_URL'
          value: urlGateway
        }
        {
          name: 'CASE_API_URL'
          value: urlCaseApi
        }
      ],
      runtimeCheckpointBackend == 'postgres'
        ? [
            {
              name: 'RUNTIME_CHECKPOINT_DATABASE_URL'
              secretRef: 'database-url'
            }
          ]
        : [],
      telemetryEnv
    )
  }
}

// ---------------------------------------------------------------------------
// Runtime dispatcher: owns leases, fencing epochs, and provider invocation.
// No ingress, and never scaled to zero: nothing wakes a stopped poller.
// ---------------------------------------------------------------------------
module dispatcher 'modules/container-app.bicep' = if (!migrationOnly) {
  name: 'runtime-dispatcher'
  params: {
    name: appNames.dispatcher
    location: location
    tags: tags
    environmentId: environment.id
    image: servicesImage
    identityId: dispatcherIdentity.id
    registryServer: registryLoginServer
    command: ['/bin/sh']
    args: ['-c', 'pnpm --filter @ehf/runtime-worker start']
    ingressEnabled: false
    minReplicas: 1
    maxReplicas: 1
    secrets: concat(
      databaseSecret(dispatcherIdentity.id),
      workloadTokenSecrets(dispatcherIdentity.id),
      [
        {
          name: 'runtime-token'
          keyVaultUrl: runtimeTokenSecretUrl
          identity: dispatcherIdentity.id
        }
      ]
    )
    env: concat(
      [
        {
          name: 'DATABASE_URL'
          secretRef: 'database-url'
        }
        {
          name: 'CASE_DATABASE_URL'
          secretRef: 'database-url'
        }
        {
          name: 'RUNTIME_PROVIDER'
          value: runtimeProvider
        }
        {
          name: 'RUNTIME_LOCAL_ENDPOINT'
          value: '${urlRuntimeHost}/invocations'
        }
        {
          name: 'RUNTIME_HOST_AUTH_TOKEN'
          secretRef: 'runtime-token'
        }
        {
          name: 'FOUNDRY_AGENT_INVOCATION_ENDPOINT'
          value: foundryAgentInvocationEndpoint
        }
        {
          name: 'FOUNDRY_AGENT_NAME'
          value: foundryAgentName
        }
        {
          name: 'FOUNDRY_AGENT_VERSION'
          value: foundryAgentVersion
        }
        {
          name: 'FOUNDRY_TOKEN_SCOPE'
          value: 'https://ai.azure.com/.default'
        }
        // DefaultAzureCredential must select this workload's identity, not an
        // arbitrary one, when the Foundry provider is bound.
        {
          name: 'AZURE_CLIENT_ID'
          value: dispatcherIdentity.properties.clientId
        }
        {
          name: 'WORKER_LEASE_SECONDS'
          value: '60'
        }
        {
          name: 'WORKER_POLL_MS'
          value: '1000'
        }
        // Bounded retry with backoff, so a failing node cannot spin the queue.
        {
          name: 'WORKER_RETRY_BASE_MS'
          value: '2000'
        }
        {
          name: 'WORKER_RETRY_MAX_MS'
          value: '60000'
        }
        {
          name: 'TRACE_VIEWER_BASE_URL'
          value: empty(traceViewerPublicUrl) ? urlJaegerQuery : traceViewerPublicUrl
        }
        {
          name: 'MODEL_PROFILES_PATH'
          value: '/app/config/model-profiles.json'
        }
      ],
      caseStoreEnv,
      platformEnv,
      workloadTokenEnv,
      telemetryEnv
    )
  }
}

// ---------------------------------------------------------------------------
// Control surface. The only app with external ingress. Entra sign-in is
// configured after deployment (runbook 9.2-9.3) because the redirect URI needs
// the FQDN this deployment produces.
// ---------------------------------------------------------------------------
module controlUi 'modules/container-app.bicep' = if (!migrationOnly) {
  name: 'control-ui'
  params: {
    name: appNames.ui
    location: location
    tags: tags
    environmentId: environment.id
    image: uiImage
    identityId: uiIdentity.id
    registryServer: registryLoginServer
    ingressExternal: true
    ingressTargetPort: 4200
    probes: httpProbes(4200)
    minReplicas: minReplicas
    maxReplicas: maxReplicas
    secrets: [
      {
        name: 'edge-service-token'
        keyVaultUrl: edgeServiceTokenSecretUrl
        identity: uiIdentity.id
      }
    ]
    env: concat(
      [
        {
          name: 'CONTROL_API_INTERNAL_URL'
          value: urlControlApi
        }
        {
          name: 'CAPABILITY_GATEWAY_INTERNAL_URL'
          value: urlGateway
        }
        {
          name: 'CASE_API_INTERNAL_URL'
          value: urlCaseApi
        }
        {
          name: 'JAEGER_API_INTERNAL_URL'
          value: urlJaegerQuery
        }
        {
          name: 'TRACE_VIEWER_PUBLIC_URL'
          value: traceViewerPublicUrl
        }
        {
          name: 'CASE_UI_TENANT_ID'
          value: caseTenantId
        }
        // The control surface authenticates to the APIs as the edge workload and
        // forwards the acting principal; it does not mint authority of its own.
        {
          name: 'EDGE_SERVICE_TOKEN'
          secretRef: 'edge-service-token'
        }
        // Separation of duties: the author identity cannot approve, so the
        // approver is a distinct principal with only reader and approver roles.
        {
          name: 'CONTROL_UI_ACTOR_ID'
          value: controlUiActorId
        }
        {
          name: 'CONTROL_UI_ACTOR_ROLES'
          value: controlUiActorRoles
        }
        {
          name: 'CONTROL_UI_APPROVER_ID'
          value: controlUiApproverId
        }
        {
          name: 'CONTROL_UI_APPROVER_ROLES'
          value: controlUiApproverRoles
        }
        {
          name: 'CONTROL_UI_VERSION'
          value: '0.1.0'
        }
        {
          name: 'BUILD_COMMIT_SHA'
          value: sourceRevision
        }
        {
          name: 'RUNTIME_PROVIDER'
          value: runtimeProvider
        }
        {
          name: 'FOUNDRY_AGENT_INVOCATION_ENDPOINT'
          value: foundryAgentInvocationEndpoint
        }
        {
          name: 'FOUNDRY_AGENT_NAME'
          value: foundryAgentName
        }
        {
          name: 'FOUNDRY_AGENT_VERSION'
          value: foundryAgentVersion
        }
      ],
      telemetryEnv
    )
  }
}

// Safe dereference: in migrationOnly mode the control surface module is not
// deployed at all, so these resolve to empty rather than failing the deployment.
output controlSurfaceFqdn string = controlUi.?outputs.fqdn ?? ''
output controlSurfaceUrl string = empty(controlUi.?outputs.fqdn ?? '') ? '' : 'https://${controlUi!.outputs.fqdn}'
output migrationJobName string = migrateJob.outputs.jobName
output controlApiInternalUrl string = urlControlApi
output caseApiInternalUrl string = urlCaseApi
output capabilityGatewayInternalUrl string = urlGateway
output traceSinkInternalUrl string = urlJaegerQuery
