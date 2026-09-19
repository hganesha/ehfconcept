// Database parameters for the POC stamp (stage 3).
//
// The server name, subnet, DNS zone, and vault are foundation outputs, supplied
// through the environment so this file stays the single parameter source:
//
//   POSTGRES_SERVER_NAME, POSTGRES_SUBNET_ID, POSTGRES_DNS_ZONE_ID, KEY_VAULT_NAME
//
// The administrator password is not a parameter at all: database.bicep reads it
// from the vault with kv.getSecret().

using '../database.bicep'

param name = readEnvironmentVariable('POSTGRES_SERVER_NAME', '')
param keyVaultName = readEnvironmentVariable('KEY_VAULT_NAME', '')
param delegatedSubnetId = readEnvironmentVariable('POSTGRES_SUBNET_ID', '')
param privateDnsZoneId = readEnvironmentVariable('POSTGRES_DNS_ZONE_ID', '')

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

param administratorLogin = 'ehfadmin'
param databaseName = 'ehf'
param postgresVersion = '17'
param skuName = 'Standard_B2s'
param skuTier = 'Burstable'
param storageSizeGB = 32
