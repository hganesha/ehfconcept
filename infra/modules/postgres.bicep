// PostgreSQL Flexible Server, VNet-injected with private DNS. There is no public
// endpoint: only workloads inside the virtual network can reach it.
//
// Password authentication is enabled because packages/persistence and
// packages/case-store build connection pools from a DATABASE_URL connection
// string. Entra-only authentication and per-identity database roles are AZ-005;
// until that lands, one administrator credential is shared by the services and
// the per-identity grant table in the migration plan cannot be enforced.

@description('Server name. Globally unique, 3-63 lowercase characters.')
param name string

@description('Azure region.')
param location string

@description('Tags applied to every resource in this module.')
param tags object

@description('Delegated subnet resource ID for VNet injection.')
param delegatedSubnetId string

@description('Private DNS zone resource ID.')
param privateDnsZoneId string

@description('Administrator login name.')
param administratorLogin string

@secure()
@description('Administrator password. Supplied by scripts/azure/ensure-secret.sh, which reads it from Key Vault when it already exists.')
param administratorPassword string

@description('Application database name.')
param databaseName string = 'ehf'

@allowed(['11', '12', '13', '14', '15', '16', '17'])
@description('PostgreSQL major version. The local stack runs 17.')
param postgresVersion string = '17'

@description('Compute SKU.')
param skuName string = 'Standard_B2s'

@allowed(['Burstable', 'GeneralPurpose', 'MemoryOptimized'])
@description('Compute tier.')
param skuTier string = 'Burstable'

@description('Storage in GB.')
param storageSizeGB int = 32

@description('Backup retention in days.')
param backupRetentionDays int = 7

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2025-01-01-preview' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: {
    version: postgresVersion
    administratorLogin: administratorLogin
    administratorLoginPassword: administratorPassword
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Enabled'
      tenantId: subscription().tenantId
    }
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: 'Disabled'
    }
    network: {
      delegatedSubnetResourceId: delegatedSubnetId
      privateDnsZoneArmResourceId: privateDnsZoneId
      publicNetworkAccess: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-01-01-preview' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

output serverId string = server.id
output serverName string = server.name
output fullyQualifiedDomainName string = server.properties.fullyQualifiedDomainName
output databaseName string = database.name
