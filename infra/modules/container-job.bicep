// Manual-trigger Container Apps job. Used for ordered schema migrations, which
// must complete before any service revision starts and must never run as a
// sidecar of a service that could restart mid-migration.

@description('Job name.')
param name string

@description('Azure region.')
param location string

@description('Tags applied to every resource in this module.')
param tags object

@description('Container Apps environment resource ID.')
param environmentId string

@description('Workload profile name from the environment.')
param workloadProfileName string = 'Consumption'

@description('Image reference. Use a digest, never a tag.')
param image string

@description('User-assigned managed identity resource ID with its own database rights.')
param identityId string

@description('Registry login server.')
param registryServer string

@description('Container entrypoint override.')
param command array = []

@description('Container arguments.')
param args array = []

@description('Environment variables, as {name, value} or {name, secretRef} objects.')
param env array = []

@description('Secrets, as {name, keyVaultUrl, identity} objects.')
param secrets array = []

@description('CPU cores, as a decimal string.')
param cpuCores string = '1.0'

@description('Memory allocation.')
param memory string = '2Gi'

@description('Seconds a replica may run before it is considered failed.')
param replicaTimeout int = 1800

@description('Retries for a failed replica. Migrations are idempotent, but a retry storm is not useful.')
param replicaRetryLimit int = 1

resource job 'Microsoft.App/jobs@2025-01-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: workloadProfileName
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: replicaTimeout
      replicaRetryLimit: replicaRetryLimit
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: [
        {
          server: registryServer
          identity: identityId
        }
      ]
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
          resources: {
            cpu: json(cpuCores)
            memory: memory
          }
        }
      ]
    }
  }
}

output jobId string = job.id
output jobName string = job.name
