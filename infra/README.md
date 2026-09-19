# Infrastructure as code

Bicep templates and GitHub Actions workflows that deploy the POC stamp described
in [the Azure deployment runbook](../docs/deploy/azure-deployment-runbook.md).
The runbook remains the explanation of *what* is deployed and *why*, including
the gap register; this directory is the automated form of the same stamp.

Backlog items `AZ-008` (core Bicep modules and parameters) and `AZ-009` (OIDC
validation, build, and deploy workflows) in the
[migration plan](../docs/plans/azure-poc-migration-plan.md).

## Verified against

`main` at `1418c25` ("Complete P0/P1 production hardening").

The service contracts these templates configure — environment variables, startup
commands, image layout — come from `compose.yaml` and the per-service startup
invariants. They move with the code, so after merging a newer `main`, re-run the
parity check before deploying:

```bash
# Every variable each compose service sets must appear in that service's
# apps.bicep module, counting the shared telemetryEnv / caseStoreEnv /
# platformEnv / workloadTokenEnv arrays it concatenates.
python3 - <<'CHECK'
import yaml, re, pathlib
compose = yaml.safe_load(open("compose.yaml"))
bicep = pathlib.Path("infra/apps.bicep").read_text()
names = lambda b: set(re.findall(r"name: '([A-Z][A-Z0-9_]+)'", b))
shared = {v: names(re.search(rf"var {v} = \[(.*?)\n\]", bicep, re.S).group(1))
          for v in ("telemetryEnv", "caseStoreEnv", "platformEnv", "workloadTokenEnv")}
blocks = dict(re.findall(r"module (\w+) 'modules/container-app\.bicep' = if \(!migrationOnly\) \{(.*?)\n\}", bicep, re.S))
for c, b in {"control-api": "controlApi", "case-api": "caseApi", "capability-gateway": "gateway",
             "runtime-host-local": "runtimeHost", "runtime-dispatcher": "dispatcher",
             "control-ui": "controlUi"}.items():
    have = names(blocks[b])
    for var, vals in shared.items():
        if re.search(rf"\b{var}\b", blocks[b]):
            have |= vals
    want = set(compose["services"][c].get("environment", {})) - {"POSTGRES_USER", "POSTGRES_PASSWORD", "POSTGRES_DB"}
    print(f"{c:20} missing={sorted(want - have) or '-'}")
CHECK
```

Also re-check the image layout: `Dockerfile` prunes per service with
`SERVICE_FILTER`, so a new service means a new image in `build-images.yml` and a
new parameter in `apps.bicep`.

## Four stages

Each stage exists because of a dependency the previous one creates. They are not
an arbitrary split.

```text
1. main.bicep         network, registry, monitoring, Key Vault, workload
                      identities, RBAC, Container Apps environment
                      └─ no secret, no image: nothing to wait for

2. seed-secrets.sh    generates pg-admin-password, execution-envelope-secret,
                      and runtime-host-token into the vault
                      └─ needs the vault from stage 1

3. database.bicep     PostgreSQL, reading its administrator password from the
                      vault with kv.getSecret()
                      └─ needs the password from stage 2

4. apps.bicep         migration job, five services, trace sink, control surface
                      └─ needs database-url (set from the stage 3 endpoint)
                         and digest-pinned images
```

No secret value is ever a template parameter, a command-line argument, or a
deployment-history entry. `main.bicep` declares no `@secure()` parameter at all;
`database.bicep` resolves its one secret through a Key Vault reference; every
container secret is a `keyVaultref` resolved by that app's own managed identity
at revision start.

## Layout

```text
infra/
  main.bicep                          stage 1
  database.bicep                      stage 3
  apps.bicep                          stage 4
  bicepconfig.json                    linter rules; warnings fail CI
  environments/
    poc.bicepparam                    foundation parameters
    poc.database.bicepparam           database parameters
    poc.apps.bicepparam               workload parameters
  modules/
    network.bicep                     VNet, delegated subnets, private DNS
    identity.bicep                    one user-assigned identity per workload
    registry.bicep                    ACR, admin user disabled
    monitoring.bicep                  Log Analytics + Application Insights
    key-vault.bicep                   RBAC-authorized, purge-protected vault
    rbac.bicep                        AcrPull + Key Vault Secrets User per identity
    postgres.bicep                    VNet-injected flexible server
    container-apps-environment.bicep  workload profiles, VNet, P2P encryption
    container-app.bicep               one app; every service shares this module
    container-job.bicep               manual-trigger job for migrations
```

## Parameters come from the environment

Values that only exist at deployment time (foundation outputs, image digests)
are read by the `.bicepparam` files with `readEnvironmentVariable`, so a
deployment has exactly one parameter source. Azure CLI does not reliably accept
inline `--parameters` overrides alongside a `.bicepparam` file, and a file that
is sometimes authoritative and sometimes overridden is worse than one that never
is.

| Variable | Stage | Source |
| --- | --- | --- |
| `NAME_PREFIX`, `ENVIRONMENT_SUFFIX` | all | your naming convention; default `hf` / `poc` |
| `KEY_VAULT_NAME`, `POSTGRES_SERVER_NAME`, `POSTGRES_SUBNET_ID`, `POSTGRES_DNS_ZONE_ID` | 3 | `main.bicep` outputs |
| `CONTAINER_APPS_ENVIRONMENT_NAME`, `REGISTRY_LOGIN_SERVER`, `KEY_VAULT_URI` | 4 | `main.bicep` outputs |
| `MIGRATE_IMAGE`, `CONTROL_API_IMAGE`, `CASE_API_IMAGE`, `GATEWAY_IMAGE`, `RUNTIME_HOST_IMAGE`, `DISPATCHER_IMAGE`, `UI_IMAGE` | 4 | `build-images.yml`; each must contain `@sha256:` |
| `MIGRATION_ONLY` | 4 | `true` for the first pass of a release |
| `SOURCE_REVISION` | 4 | commit SHA, recorded on the control surface |
| `RUNTIME_PROVIDER`, `FOUNDRY_*` | 4 | only when switching execution to Foundry |
| `MODEL_PROVIDER_SECRET_NAME` | 4 | `openrouter-api-key`, or empty for the recorded adapter |

Exporting `KEY_VAULT_NAME` and `POSTGRES_SERVER_NAME` for stage 3 also pins those
names in stage 1, which is intentional: re-running the foundation after the
database exists must not derive a different name for either.

Edit `tags` in each parameter file before the first deployment:
`foundation.azure.yaml` requires `owner`, `costCenter`, `environment`, `domain`,
`dataClassification`, `residency`, `criticality`, `serviceId`, `managedBy`, and
`repository`, and two of them ship as `REPLACE_WITH_...`.

## Deploying by hand

```bash
export RG=rg-hf-poc-eastus2-01

# Stage 1
az deployment group create -g "$RG" -f infra/main.bicep \
  -p infra/environments/poc.bicepparam --query properties.outputs -o json > outputs.json

# Stage 2
export KEY_VAULT_NAME="$(jq -r .keyVaultName.value outputs.json)"
./scripts/azure/seed-secrets.sh "$KEY_VAULT_NAME"

# Stage 3
export POSTGRES_SERVER_NAME="$(jq -r .postgresServerName.value outputs.json)"
export POSTGRES_SUBNET_ID="$(jq -r .postgresSubnetId.value outputs.json)"
export POSTGRES_DNS_ZONE_ID="$(jq -r .postgresPrivateDnsZoneId.value outputs.json)"
az deployment group create -g "$RG" -f infra/database.bicep \
  -p infra/environments/poc.database.bicepparam --query properties.outputs -o json > db.json
./scripts/azure/set-database-url.sh "$KEY_VAULT_NAME" "$(jq -r .fullyQualifiedDomainName.value db.json)"

# Stage 4 (after building images; see the runbook part 5)
export CONTAINER_APPS_ENVIRONMENT_NAME="$(jq -r .containerAppsEnvironmentName.value outputs.json)"
export REGISTRY_LOGIN_SERVER="$(jq -r .registryLoginServer.value outputs.json)"
export KEY_VAULT_URI="$(jq -r .keyVaultUri.value outputs.json)"
export MIGRATE_IMAGE="${REGISTRY_LOGIN_SERVER}/ehf/migrate@sha256:..."
export CONTROL_API_IMAGE="${REGISTRY_LOGIN_SERVER}/ehf/control-api@sha256:..."
export CASE_API_IMAGE="${REGISTRY_LOGIN_SERVER}/ehf/case-api@sha256:..."
export GATEWAY_IMAGE="${REGISTRY_LOGIN_SERVER}/ehf/gateway@sha256:..."
export RUNTIME_HOST_IMAGE="${REGISTRY_LOGIN_SERVER}/ehf/runtime-host@sha256:..."
export DISPATCHER_IMAGE="${REGISTRY_LOGIN_SERVER}/ehf/dispatcher@sha256:..."
export UI_IMAGE="${REGISTRY_LOGIN_SERVER}/ehf/control-ui@sha256:..."

MIGRATION_ONLY=true az deployment group create -g "$RG" -f infra/apps.bicep \
  -p infra/environments/poc.apps.bicepparam -o none
az containerapp job start -g "$RG" -n job-hf-migrate          # wait for Succeeded

az deployment group create -g "$RG" -f infra/apps.bicep \
  -p infra/environments/poc.apps.bicepparam --query properties.outputs -o json
```

## Workflows

```text
.github/workflows/
  validate.yml           compiler, cargo test, pnpm check, bicep lint/build,
                         shellcheck; gates every deployment
  infra-plan.yml         what-if on pull requests touching infra/
  deploy-foundation.yml  stages 1-3
  build-images.yml       az acr build per service (SERVICE_FILTER), digest
                         resolution, release manifest
  deploy-apps.yml        stage 4: migrations first, then workloads
  smoke.yml              deployment-shape checks, on demand and daily
```

Authentication is workload identity federation only. There is no Azure client
secret in this repository and none should be added — `azure/login@v2` exchanges
the GitHub OIDC token for an Azure token at run time.

### Required GitHub configuration

Create a GitHub environment (`poc`) with these **variables** — none is a secret:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | client ID of the federated deployment identity (runbook 1.6) |
| `AZURE_TENANT_ID` | Entra tenant ID |
| `AZURE_SUBSCRIPTION_ID` | subscription holding the resource group |
| `AZURE_RESOURCE_GROUP` | the stamp's resource group |
| `AZURE_CONTAINER_REGISTRY` | registry name, from `main.bicep` output |
| `NAME_PREFIX` | optional; defaults to `hf` |

Protect the environment with required reviewers before pointing it at anything
that is not a synthetic-data POC.

### Ordering guarantees

`deploy-apps.yml` deploys the migration job on the new image, runs it to
completion, and only then rolls the services. A failed migration stops the run
with every service still on the previous image. The workflow also refuses any
image reference without `@sha256:`, so a mutable tag cannot reach a revision.

Each service has its own image: `Dockerfile` prunes the workspace to one
service with `SERVICE_FILTER` and bakes in the Rust compiler of record, so the
build step produces seven images rather than two.

## What this does not create

Entra directory objects are out of scope for ARM deployments and are **not**
created here:

- the application registration for the control surface, its seven app roles, its
  service principal, and its client secret;
- user and group role assignments;
- the federated credential on the deployment identity;
- Container Apps built-in authentication on the control surface, which needs the
  FQDN the deployment produces.

Runbook parts 1.3, 1.6, and 9.2–9.3 cover those with the Graph and CLI commands
they require. The migration plan's rule applies: provision them with a
documented, idempotent bootstrap and feed their IDs in as parameters — do not
hide manually created identity objects behind undocumented parameters.

Also not created, because the code does not support them yet: the Foundry hosted
agent (`AZ-011`), Blob evidence storage (`AZ-013`), Service Bus work signalling
(`AZ-013`), and Static Web Apps hosting for the control surface, which needs the
static-export and `api-edge` work in `AZ-003`/`AZ-004`. `apps.bicep` accepts the
Foundry binding parameters so the dispatcher can be switched by configuration
once that wrapper exists.

## Validating changes locally

```bash
az bicep build --file infra/main.bicep --stdout > /dev/null
az bicep build --file infra/database.bicep --stdout > /dev/null
az bicep build --file infra/apps.bicep --stdout > /dev/null
for p in infra/environments/*.bicepparam; do az bicep build-params --file "$p" --stdout > /dev/null; done
```

All three templates and all three parameter files compile with zero warnings
under `bicepconfig.json`. Keep it that way: the linter settings treat an unused
parameter, a hardcoded environment URL, and a secret in an output as errors.
