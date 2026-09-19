// Foundation stamp for the Executable Harness Framework POC.
//
// Stage 1 of three. Deploys everything that needs no secret and no built image:
// network, registry, monitoring, vault, workload identities, role assignments,
// and the Container Apps environment.
//
//   1. main.bicep      <- you are here; creates the vault
//   2. seed-secrets.sh <- generates secrets into the vault
//   3. database.bicep  <- reads its admin password from the vault
//   4. apps.bicep      <- workloads, once images exist
//
//   az deployment group create -g <rg> -f infra/main.bicep \
//     -p infra/environments/poc.bicepparam
//
// This template contains no @secure() parameter by design: a foundation
// deployment should never carry a secret through deployment history.
//
// Entra application registrations, app roles, and user assignments are tenant
// directory objects and cannot be created here. Provision them with the Graph
// bootstrap in docs/deploy/azure-deployment-runbook.md part 1.3.

targetScope = 'resourceGroup'

@description('Short organization prefix used in resource names.')
param namePrefix string = 'hf'

@description('Environment discriminator used in resource names.')
param environmentSuffix string = 'poc'

@description('Azure region. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Tags applied to every resource. foundation.azure.yaml requires owner, costCenter, environment, domain, dataClassification, residency, criticality, serviceId, managedBy, and repository.')
param tags object

@description('Workload identity suffixes. One managed identity is created per entry; none are shared between services.')
param workloadIdentitySuffixes array = [
  'migrate'
  'control-api'
  'case-api'
  'capability-gateway'
  'runtime-host'
  'runtime-dispatcher'
  'control-ui'
]

@description('Override the derived container registry name.')
param registryNameOverride string = ''

@description('Override the derived Key Vault name.')
param keyVaultNameOverride string = ''

@description('Override the derived PostgreSQL server name.')
param postgresNameOverride string = ''

@description('Virtual network address space.')
param vnetAddressPrefix string = '10.60.0.0/16'

@description('Subnet for the Container Apps environment.')
param appsSubnetPrefix string = '10.60.0.0/23'

@description('Subnet for PostgreSQL flexible server.')
param postgresSubnetPrefix string = '10.60.4.0/26'

@description('Set true to keep even the control surface off the public internet. The runbook assumes false.')
param environmentInternalOnly bool = false

var uniquePart = toLower(uniqueString(resourceGroup().id))
var baseName = '${namePrefix}-${environmentSuffix}'

var registryName = empty(registryNameOverride)
  ? 'cr${namePrefix}${environmentSuffix}${substring(uniquePart, 0, 8)}'
  : registryNameOverride
var keyVaultName = empty(keyVaultNameOverride)
  ? 'kv-${baseName}-${substring(uniquePart, 0, 6)}'
  : keyVaultNameOverride
var postgresName = empty(postgresNameOverride)
  ? 'psql-${baseName}-${substring(uniquePart, 0, 8)}'
  : postgresNameOverride

var vnetName = 'vnet-${baseName}'
var workspaceName = 'log-${baseName}'
var appInsightsName = 'appi-${baseName}'
var environmentName = 'cae-${baseName}'
var postgresDnsZoneName = '${postgresName}.private.postgres.database.azure.com'

module network 'modules/network.bicep' = {
  name: 'network'
  params: {
    name: vnetName
    location: location
    tags: tags
    addressPrefix: vnetAddressPrefix
    appsSubnetPrefix: appsSubnetPrefix
    postgresSubnetPrefix: postgresSubnetPrefix
    postgresPrivateDnsZoneName: postgresDnsZoneName
  }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: {
    workspaceName: workspaceName
    appInsightsName: appInsightsName
    location: location
    tags: tags
  }
}

module registry 'modules/registry.bicep' = {
  name: 'registry'
  params: {
    name: registryName
    location: location
    tags: tags
  }
}

module keyVault 'modules/key-vault.bicep' = {
  name: 'key-vault'
  params: {
    name: keyVaultName
    location: location
    tags: tags
  }
}

module identities 'modules/identity.bicep' = {
  name: 'identities'
  params: {
    location: location
    tags: tags
    identityNames: [for suffix in workloadIdentitySuffixes: 'id-${namePrefix}-${suffix}-${environmentSuffix}']
  }
}

module rbac 'modules/rbac.bicep' = {
  name: 'rbac'
  params: {
    registryName: registryName
    keyVaultName: keyVaultName
    principalIds: [for (suffix, i) in workloadIdentitySuffixes: identities.outputs.identities[i].principalId]
  }
  dependsOn: [
    registry
    keyVault
  ]
}

module containerAppsEnvironment 'modules/container-apps-environment.bicep' = {
  name: 'container-apps-environment'
  params: {
    name: environmentName
    location: location
    tags: tags
    infrastructureSubnetId: network.outputs.appsSubnetId
    logAnalyticsWorkspaceName: workspaceName
    appInsightsName: appInsightsName
    internalOnly: environmentInternalOnly
  }
  dependsOn: [
    monitoring
  ]
}

@description('Resource IDs, endpoints, and principal IDs consumed by apps.bicep and the delivery workflows. No secret is output.')
output registryLoginServer string = registry.outputs.loginServer

output keyVaultName string = keyVault.outputs.keyVaultName
output keyVaultUri string = keyVault.outputs.keyVaultUri
output containerAppsEnvironmentName string = containerAppsEnvironment.outputs.environmentName
output containerAppsDefaultDomain string = containerAppsEnvironment.outputs.defaultDomain
output postgresServerName string = postgresName
output postgresSubnetId string = network.outputs.postgresSubnetId
output postgresPrivateDnsZoneId string = network.outputs.postgresDnsZoneId
output workloadIdentities array = identities.outputs.identities
output applicationInsightsName string = monitoring.outputs.appInsightsName
output logAnalyticsWorkspaceId string = monitoring.outputs.workspaceId
output logAnalyticsWorkspaceCustomerId string = monitoring.outputs.workspaceCustomerId
