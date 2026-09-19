// Container Apps environment: workload profiles, VNet-integrated, with
// peer-to-peer traffic encryption.
//
// The encryption flag matters here. The services call each other over plain
// http:// internal FQDNs because that is what CAPABILITY_GATEWAY_URL,
// CASE_API_URL, and CONTROL_API_INTERNAL_URL expect, so the environment
// encrypts that traffic in transit on their behalf.
//
// This module uses a preview API version because the managed OpenTelemetry agent
// (appInsightsConfiguration and openTelemetryConfiguration) is not in the stable
// surface yet. Drop to 2025-01-01 and remove those two blocks if your
// subscription policy forbids preview API versions; container logs still reach
// Log Analytics, and the harness spans still reach the trace sink the services
// are configured with.

@description('Environment name.')
param name string

@description('Azure region.')
param location string

@description('Tags applied to every resource in this module.')
param tags object

@description('Infrastructure subnet delegated to Microsoft.App/environments.')
param infrastructureSubnetId string

@description('Log Analytics workspace name, in this resource group.')
param logAnalyticsWorkspaceName string

@description('Application Insights component name, in this resource group.')
param appInsightsName string

@description('Set true to keep every app, including the control surface, off the public internet.')
param internalOnly bool = false

@description('Enable zone redundancy. Requires a region with availability zones and raises cost.')
param zoneRedundant bool = false

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource environment 'Microsoft.App/managedEnvironments@2025-02-02-preview' = {
  name: name
  location: location
  tags: tags
  properties: {
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    vnetConfiguration: {
      infrastructureSubnetId: infrastructureSubnetId
      internal: internalOnly
    }
    zoneRedundant: zoneRedundant
    peerTrafficConfiguration: {
      encryption: {
        enabled: true
      }
    }
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspace.properties.customerId
        sharedKey: workspace.listKeys().primarySharedKey
      }
    }
    appInsightsConfiguration: {
      connectionString: appInsights.properties.ConnectionString
    }
    openTelemetryConfiguration: {
      tracesConfiguration: {
        destinations: ['appInsights']
      }
      logsConfiguration: {
        destinations: ['appInsights']
      }
    }
  }
}

output environmentId string = environment.id
output environmentName string = environment.name
output defaultDomain string = environment.properties.defaultDomain
output staticIp string = environment.properties.staticIp
