// One user-assigned managed identity per workload. Identities are never shared
// between services: a compromised service must not inherit another's access.
//
// Entra application registrations, app roles, group assignments, and federated
// credentials are tenant-directory objects and cannot be created from an ARM
// deployment. Provision them with the documented Microsoft Graph bootstrap
// (see docs/deploy/azure-deployment-runbook.md, part 1.3) and pass their IDs in
// as parameters.

@description('Azure region.')
param location string

@description('Tags applied to every resource in this module.')
param tags object

@description('Workload identity names, one per service.')
param identityNames array

resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = [
  for identityName in identityNames: {
    name: identityName
    location: location
    tags: tags
  }
]

@description('Name, resource ID, principal ID, and client ID for each workload identity.')
output identities array = [
  for (identityName, i) in identityNames: {
    name: identityName
    id: identities[i].id
    principalId: identities[i].properties.principalId
    clientId: identities[i].properties.clientId
  }
]
