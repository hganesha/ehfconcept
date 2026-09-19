// Virtual network for the POC stamp: one delegated subnet for the Container Apps
// environment, one for PostgreSQL flexible server, and the private DNS zone that
// keeps the database off the public internet.

@description('Virtual network name.')
param name string

@description('Azure region.')
param location string

@description('Tags applied to every resource in this module.')
param tags object

@description('Address space for the virtual network.')
param addressPrefix string = '10.60.0.0/16'

@description('Subnet delegated to Microsoft.App/environments. Workload-profile environments require at least a /27.')
param appsSubnetPrefix string = '10.60.0.0/23'

@description('Subnet delegated to Microsoft.DBforPostgreSQL/flexibleServers.')
param postgresSubnetPrefix string = '10.60.4.0/26'

@description('Private DNS zone name. Must end with .private.postgres.database.azure.com.')
param postgresPrivateDnsZoneName string

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [addressPrefix]
    }
    subnets: [
      {
        name: 'snet-apps'
        properties: {
          addressPrefix: appsSubnetPrefix
          delegations: [
            {
              name: 'container-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: 'snet-postgres'
        properties: {
          addressPrefix: postgresSubnetPrefix
          delegations: [
            {
              name: 'postgres-flexible'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
    ]
  }
}

resource postgresDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: postgresPrivateDnsZoneName
  location: 'global'
  tags: tags
}

resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresDnsZone
  name: 'link-${name}'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

output vnetId string = vnet.id
output appsSubnetId string = vnet.properties.subnets[0].id
output postgresSubnetId string = vnet.properties.subnets[1].id
output postgresDnsZoneId string = postgresDnsZone.id
