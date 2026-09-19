// Container registry for the two images built from this repository. The admin
// user stays disabled: every pull authenticates with a workload managed identity.

@description('Registry name. Globally unique, 5-50 lowercase alphanumerics.')
param name string

@description('Azure region.')
param location string

@description('Tags applied to every resource in this module.')
param tags object

@allowed(['Basic', 'Standard', 'Premium'])
@description('Registry SKU. Standard is sufficient for the POC; Premium adds private endpoints.')
param sku string = 'Standard'

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: sku
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

output registryId string = registry.id
output loginServer string = registry.properties.loginServer
