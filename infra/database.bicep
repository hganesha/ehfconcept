// Stage 3 of three: PostgreSQL Flexible Server.
//
// Deployed separately from the foundation because its administrator password
// must already exist in Key Vault. kv.getSecret() resolves that reference at
// deployment time, so the password never appears in this template, in a
// parameter file, on a command line, or in deployment history.
//
//   az deployment group create -g <rg> -f infra/database.bicep \
//     -p keyVaultName=<kv> name=<server> delegatedSubnetId=<id> privateDnsZoneId=<id>
//
// All four values come from main.bicep outputs.

targetScope = 'resourceGroup'

@description('PostgreSQL server name, from the foundation deployment output.')
param name string

@description('Azure region. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Tags applied to every resource.')
param tags object

@description('Key Vault holding the administrator password.')
param keyVaultName string

@description('Key Vault secret name holding the administrator password.')
param passwordSecretName string = 'pg-admin-password'

@description('Delegated subnet resource ID, from the foundation deployment output.')
param delegatedSubnetId string

@description('Private DNS zone resource ID, from the foundation deployment output.')
param privateDnsZoneId string

@description('Administrator login name.')
param administratorLogin string = 'ehfadmin'

@description('Application database name.')
param databaseName string = 'ehf'

@description('PostgreSQL major version.')
param postgresVersion string = '17'

@description('Compute SKU.')
param skuName string = 'Standard_B2s'

@description('Compute tier.')
param skuTier string = 'Burstable'

@description('Storage in GB.')
param storageSizeGB int = 32

resource keyVault 'Microsoft.KeyVault/vaults@2024-11-01' existing = {
  name: keyVaultName
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    name: name
    location: location
    tags: tags
    delegatedSubnetId: delegatedSubnetId
    privateDnsZoneId: privateDnsZoneId
    administratorLogin: administratorLogin
    administratorPassword: keyVault.getSecret(passwordSecretName)
    databaseName: databaseName
    postgresVersion: postgresVersion
    skuName: skuName
    skuTier: skuTier
    storageSizeGB: storageSizeGB
  }
}

output serverName string = postgres.outputs.serverName
output fullyQualifiedDomainName string = postgres.outputs.fullyQualifiedDomainName
output databaseName string = postgres.outputs.databaseName
output administratorLoginName string = administratorLogin
