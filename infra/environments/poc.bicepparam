// Foundation parameters for the POC stamp (stage 1).
//
// There is no secret here and none is possible: main.bicep declares no @secure()
// parameter. The database password lives only in Key Vault and is read from
// there by database.bicep in stage 3.

using '../main.bicep'

param namePrefix = readEnvironmentVariable('NAME_PREFIX', 'hf')
param environmentSuffix = readEnvironmentVariable('ENVIRONMENT_SUFFIX', 'poc')

// Set these to adopt a stamp whose globally unique names were chosen by hand,
// for example one built with the CLI commands in the runbook. Left empty, the
// names are derived deterministically from the resource group ID.
param registryNameOverride = readEnvironmentVariable('REGISTRY_NAME', '')
param keyVaultNameOverride = readEnvironmentVariable('KEY_VAULT_NAME', '')
param postgresNameOverride = readEnvironmentVariable('POSTGRES_SERVER_NAME', '')

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

param vnetAddressPrefix = '10.60.0.0/16'
param appsSubnetPrefix = '10.60.0.0/23'
param postgresSubnetPrefix = '10.60.4.0/26'

// The control surface is public and gated by Entra sign-in. Set true only if
// you are fronting the stamp with private connectivity and do not need it.
param environmentInternalOnly = false
