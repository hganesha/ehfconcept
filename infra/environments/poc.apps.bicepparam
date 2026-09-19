// Workload parameters for the POC stamp (stage 4).
//
// Values that only exist at deployment time come from the environment, so this
// file is the single parameter source and the delivery workflow never has to
// mix a parameter file with command-line overrides:
//
//   CONTAINER_APPS_ENVIRONMENT_NAME, REGISTRY_LOGIN_SERVER, KEY_VAULT_URI
//     -> outputs of the foundation deployment
//   MIGRATE_IMAGE, CONTROL_API_IMAGE, CASE_API_IMAGE, GATEWAY_IMAGE,
//   RUNTIME_HOST_IMAGE, DISPATCHER_IMAGE, UI_IMAGE
//     -> digests from build-images.yml; a tag is rejected by the workflow
//   MIGRATION_ONLY
//     -> true for the first pass, which updates the migration job alone
//
// Locally, export the same variables before running az deployment group create.

using '../apps.bicep'

param namePrefix = readEnvironmentVariable('NAME_PREFIX', 'hf')
param environmentSuffix = readEnvironmentVariable('ENVIRONMENT_SUFFIX', 'poc')

param tags = {
  owner: 'REPLACE_WITH_OWNER'
  costCenter: 'REPLACE_WITH_COST_CENTER'
  environment: 'poc'
  domain: 'kyc'
  dataClassification: 'synthetic'
  residency: 'us'
  criticality: 'low'
  serviceId: 'harness-factory'
  managedBy: 'bicep'
  repository: 'hganesha/ehfconcept'
}

param containerAppsEnvironmentName = readEnvironmentVariable('CONTAINER_APPS_ENVIRONMENT_NAME', '')
param registryLoginServer = readEnvironmentVariable('REGISTRY_LOGIN_SERVER', '')
param keyVaultUri = readEnvironmentVariable('KEY_VAULT_URI', '')
// One image per service: the Dockerfile prunes the workspace with SERVICE_FILTER.
param migrateImage = readEnvironmentVariable('MIGRATE_IMAGE', '')
param controlApiImage = readEnvironmentVariable('CONTROL_API_IMAGE', '')
param caseApiImage = readEnvironmentVariable('CASE_API_IMAGE', '')
param gatewayImage = readEnvironmentVariable('GATEWAY_IMAGE', '')
param runtimeHostImage = readEnvironmentVariable('RUNTIME_HOST_IMAGE', '')
param dispatcherImage = readEnvironmentVariable('DISPATCHER_IMAGE', '')
param uiImage = readEnvironmentVariable('UI_IMAGE', '')
param sourceRevision = readEnvironmentVariable('SOURCE_REVISION', '')

// First pass of a release deploys the migration job alone, so schema changes
// land before any service revision starts on the new image.
param migrationOnly = bool(readEnvironmentVariable('MIGRATION_ONLY', 'false'))

param databaseSecretName = 'database-url'
param envelopeSecretName = 'execution-envelope-secret'
param runtimeTokenSecretName = 'runtime-host-token'
param edgeServiceTokenSecretName = 'edge-service-token'
param runtimeServiceTokenSecretName = 'runtime-service-token'
param runtimeGrantSecretName = 'runtime-grant-secret'

// The services assert startup invariants for this mode. azure forbids every
// shared token above and requires a passwordless database URL, which is not
// possible until packages/persistence authenticates with a managed identity
// (AZ-005). Keep local until then; see the runbook's gap register.
param platformMode = readEnvironmentVariable('PLATFORM_MODE', 'local')
param identityProvider = readEnvironmentVariable('IDENTITY_PROVIDER', 'local_headers')

// postgres keeps runs resumable; memory lets the runtime hold no database
// credential at all, which is what a hosted agent needs.
param runtimeCheckpointBackend = readEnvironmentVariable('RUNTIME_CHECKPOINT_BACKEND', 'postgres')

// Leave empty to run the deterministic recorded model adapter. Set to
// 'openrouter-api-key' after seeding that secret to call a live provider.
param modelProviderSecretName = readEnvironmentVariable('MODEL_PROVIDER_SECRET_NAME', '')

param caseTenantId = 'tenant_demo'

// azure_foundry additionally requires the hosted-agent wrapper (AZ-011) and the
// removal of the runtime host's database credential (AZ-010).
param runtimeProvider = readEnvironmentVariable('RUNTIME_PROVIDER', 'local_http')
param foundryAgentInvocationEndpoint = readEnvironmentVariable('FOUNDRY_AGENT_INVOCATION_ENDPOINT', '')
param foundryAgentName = readEnvironmentVariable('FOUNDRY_AGENT_NAME', '')
param foundryAgentVersion = readEnvironmentVariable('FOUNDRY_AGENT_VERSION', '')

// Set only if you published the trace sink behind authentication. Empty means
// the control surface renders no browser trace deep links.
param traceViewerPublicUrl = readEnvironmentVariable('TRACE_VIEWER_PUBLIC_URL', '')

param minReplicas = 1
param maxReplicas = 3
