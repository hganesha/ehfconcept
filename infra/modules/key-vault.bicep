// Key Vault for platform secrets. RBAC-authorized so access is granted through
// role assignments rather than access policies, and purge-protected because this
// vault is where the asymmetric execution-envelope signing key belongs once
// AZ-006 lands.
//
// This module creates the vault only. Secret values are seeded out of band by
// scripts/azure/seed-secrets.sh so that no secret is ever written into a
// deployment template, parameter file, or deployment history.

@description('Key Vault name. Globally unique, 3-24 characters.')
param name string

@description('Azure region.')
param location string

@description('Tags applied to every resource in this module.')
param tags object

@minValue(7)
@maxValue(90)
@description('Soft-delete retention in days.')
param softDeleteRetentionInDays int = 7

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

output keyVaultId string = vault.id
output keyVaultName string = vault.name
output keyVaultUri string = vault.properties.vaultUri
