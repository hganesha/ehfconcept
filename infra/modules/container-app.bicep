// One Container App. Generic on purpose: every service in this stamp differs
// only in image command, port, environment, and secrets, so they share this
// module and differ only in parameters.
//
// Images are always passed as digest references. A tag would let the running
// revision drift from the release manifest.

@description('Container app name.')
param name string

@description('Azure region.')
param location string

@description('Tags applied to every resource in this module.')
param tags object

@description('Container Apps environment resource ID.')
param environmentId string

@description('Workload profile name from the environment.')
param workloadProfileName string = 'Consumption'

@description('Image reference. Use a digest (registry/repo@sha256:...), never a tag.')
param image string

@description('User-assigned managed identity resource ID used for registry pull and Key Vault references. Empty for an app that pulls a public image and reads no secrets.')
param identityId string = ''

@description('Registry login server. Empty for public images that need no authentication.')
param registryServer string = ''

@description('Container entrypoint override.')
param command array = []

@description('Container arguments.')
param args array = []

@description('Environment variables, as {name, value} or {name, secretRef} objects.')
param env array = []

@description('Secrets, as {name, keyVaultUrl, identity} objects. Values never appear in the template.')
param secrets array = []

@description('CPU cores, as a decimal string.')
param cpuCores string = '1.0'

@description('Memory, for example 2Gi. Must match the CPU allocation ratio Container Apps requires.')
param memory string = '2Gi'

@description('Minimum replicas. Never 0 for the dispatcher: nothing wakes a scaled-to-zero poller.')
param minReplicas int = 1

@description('Maximum replicas.')
param maxReplicas int = 3

@description('Whether this app accepts inbound HTTP at all.')
param ingressEnabled bool = true

@description('Whether ingress is reachable from the internet. Only the control surface should be true.')
param ingressExternal bool = false

@description('Container port that ingress forwards to.')
param ingressTargetPort int = 8080

@description('Extra ports exposed alongside the main one, as {external, targetPort, exposedPort} objects.')
param additionalPortMappings array = []

@description('Liveness and readiness probes.')
param probes array = []

var ingressConfiguration = {
  external: ingressExternal
  targetPort: ingressTargetPort
  transport: 'auto'
  allowInsecure: false
  additionalPortMappings: additionalPortMappings
}

var identityConfiguration = empty(identityId)
  ? {
      type: 'None'
    }
  : {
      type: 'UserAssigned'
      userAssignedIdentities: {
        '${identityId}': {}
      }
    }

var registryConfiguration = empty(registryServer)
  ? []
  : [
      {
        server: registryServer
        identity: identityId
      }
    ]

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: name
  location: location
  tags: tags
  identity: identityConfiguration
  properties: {
    environmentId: environmentId
    workloadProfileName: workloadProfileName
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: ingressEnabled ? ingressConfiguration : null
      registries: registryConfiguration
      secrets: secrets
    }
    template: {
      containers: [
        {
          name: name
          image: image
          command: command
          args: args
          env: env
          probes: probes
          resources: {
            cpu: json(cpuCores)
            memory: memory
          }
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output appId string = app.id
output appName string = app.name
output fqdn string = ingressEnabled ? app.properties.configuration.ingress.fqdn : ''
