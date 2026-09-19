# Azure deployment runbook — POC stamp in a dedicated resource group

**Status:** executable runbook for the repository as it stands today
**Scope:** showcase deployment, synthetic data only, one resource group, one region
**Target topology:** Azure Container Apps + Azure Database for PostgreSQL Flexible Server + Azure Container Registry + Key Vault + Log Analytics/Application Insights, with Microsoft Entra ID sign-in in front of the control surface
**Companion documents:** [Azure POC migration plan](../plans/azure-poc-migration-plan.md) (target architecture), [runtime isolation and Azure migration](../plans/runtime-isolation-azure-migration.md) (Foundry runtime path)

---

## 0. Read this before you start

### 0.1 What this runbook deploys

Every service in `compose.yaml` becomes an Azure Container App in a single, dedicated resource group:

```text
Browser
  │  Entra ID sign-in (Container Apps built-in authentication)
  ▼
ca-hf-control-ui        external ingress, public HTTPS FQDN
  │  server-side calls over the environment's internal network
  ├─► ca-hf-control-api          internal ingress :4100
  ├─► ca-hf-capability-gateway   internal ingress :4101
  ├─► ca-hf-case-api             internal ingress :4102
  └─► ca-hf-jaeger               internal ingress :16686 (+ :4318 OTLP)

ca-hf-runtime-dispatcher   no ingress, polls the run queue
  └─► ca-hf-runtime-host     internal ingress :8088 (LangGraph execution)
        ├─► ca-hf-capability-gateway
        └─► ca-hf-case-api

job-hf-migrate             manual Container Apps job, runs `pnpm db:migrate`

psql-hf-poc…               PostgreSQL Flexible Server, VNet-injected, private DNS
kv-hf-poc…                 Key Vault: envelope secret, runtime token, DB URL, model key
cr hf poc…                 Container Registry: two digest-pinned images
log-/appi-hf-poc…          Log Analytics + Application Insights
```

Two images are built from the repository:

| Image | Dockerfile | Used by |
| --- | --- | --- |
| `ehf/services` | `Dockerfile` | migrate job, control-api, case-api, capability-gateway, runtime-host, runtime-dispatcher |
| `ehf/control-ui` | `Dockerfile.ui` | control-ui |

### 0.2 What this runbook does **not** claim

The repository today is the local POC described in `README.md`. This runbook deploys **that code**, unchanged, onto Azure managed services. It deliberately does not pretend the Azure-native identity work is finished. The following items from the [migration plan](../plans/azure-poc-migration-plan.md) are **not** implemented in the code and therefore **not** delivered by these steps:

| Gap | Backlog item | Consequence in this deployment |
| --- | --- | --- |
| `x-actor-id` defaults to `local-author` in `control-api` | `AZ-002` | Actor identity is not derived from the signed-in user. Entra sign-in gates *access to the UI*, not per-action authorization. |
| `x-tenant-id` is trusted as sent; `CASE_UI_TENANT_ID` acts as authority | `AZ-002` | Tenant is configuration, not a verified claim. |
| No `api-edge` BFF; UI is a Next.js **server**, not a static export | `AZ-003`, `AZ-004` | The UI is deployed as a Container App, not Static Web Apps. Internal service URLs stay server-side, which is why the UI container must remain the only externally exposed app. |
| PostgreSQL uses a password connection string | `AZ-005` | Entra-only database authentication is **not** enabled. The password lives in Key Vault and is injected as a secret reference. |
| Execution envelope uses a shared HS256 secret | `AZ-006` | No Key Vault RSA signing. The shared secret lives in Key Vault and is injected into the gateway, runtime host, and dispatcher. |
| Trace links are Jaeger-specific | `AZ-007` | Jaeger runs as an internal Container App so the UI's trace pages keep working. Application Insights is wired in parallel for platform telemetry. |
| Runtime host needs `RUNTIME_CHECKPOINT_DATABASE_URL` | `AZ-010` | The runtime host holds database credentials. This is the blocker for moving execution to a Foundry Hosted Agent. |
| Foundry Hosted Agent wrapper (Invocations protocol) not written | `AZ-011` | `RUNTIME_PROVIDER=azure_foundry` cannot be exercised yet. Part 12 documents the switch and the gate in front of it. |

Deploy this as a **synthetic-data showcase**. Do not put real customer data in it, and do not present it as the regulated production design. Section 14 of the migration plan lists the production gates.

### 0.3 Prerequisites

On your workstation:

| Tool | Minimum | Check |
| --- | --- | --- |
| Azure CLI | 2.67 | `az version` |
| Container Apps CLI extension | latest | `az extension add --name containerapp --upgrade` |
| Rust toolchain | stable | `cargo --version` (needed to compile harness plans for the smoke test) |
| `jq` | 1.6 | `jq --version` |
| `openssl` | any | `openssl version` |
| `uuidgen` | any | `uuidgen` (or substitute `python3 -c "import uuid;print(uuid.uuid4())"`) |

Docker is **not** required: images are built remotely with `az acr build`.

In Azure and Entra you need:

- **Subscription:** `Contributor` **and** `Role Based Access Control Administrator` (or `Owner`) — Part 3 creates role assignments.
- **Entra directory:** `Application Developer` or `Cloud Application Administrator` — Part 1 creates an app registration and app roles.
- A region where Container Apps, PostgreSQL Flexible Server, and (optionally) Microsoft Foundry are all available. This runbook uses `eastus2`, matching `docs/implementation/config/foundation.azure.yaml`.

### 0.4 Conventions

- Every command is idempotent-friendly: re-running the runbook against an existing stamp either succeeds or fails loudly. It never silently reuses another environment's resources.
- Every command targets `$RG`. Nothing is created outside that resource group except the Entra app registration, which is a directory object and has no resource group.
- Images are deployed **by digest**, never by mutable tag.
- Run all commands from the repository root.

---

## Part 1 — App identities

Identity comes first: the Entra app registration is a directory object with no dependency on any Azure resource, and every managed identity created later needs the resource group to exist.

### 1.1 Sign in and select the subscription

```bash
az login --tenant <your-tenant-id>
az account set --subscription <your-subscription-id>
az account show --query "{subscription:name, id:id, tenant:tenantId}" -o table
```

Register the resource providers used by this stamp (each returns immediately; registration completes in the background):

```bash
for ns in Microsoft.App Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL \
          Microsoft.KeyVault Microsoft.ManagedIdentity Microsoft.Network \
          Microsoft.OperationalInsights Microsoft.Insights; do
  az provider register --namespace "$ns"
done

# Wait until all report "Registered" before continuing.
for ns in Microsoft.App Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL \
          Microsoft.KeyVault Microsoft.ManagedIdentity Microsoft.Network \
          Microsoft.OperationalInsights Microsoft.Insights; do
  printf '%-40s %s\n' "$ns" "$(az provider show --namespace "$ns" --query registrationState -o tsv)"
done
```

### 1.2 Set the variable block

Paste this once per shell session. Every later command depends on it. Keep it in a file you can re-source (`source ./azure-poc.env`) — it contains **no secrets**.

```bash
# ---- identity / placement -------------------------------------------------
export SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
export TENANT_ID="$(az account show --query tenantId -o tsv)"
export LOC="eastus2"
export ORG="hf"                 # harness factory
export ENVNAME="poc"
export ORDINAL="01"

# ---- resource names -------------------------------------------------------
export RG="rg-${ORG}-${ENVNAME}-${LOC}-${ORDINAL}"
export VNET="vnet-${ORG}-${ENVNAME}-${LOC}-${ORDINAL}"
export LAW="log-${ORG}-${ENVNAME}-${LOC}-${ORDINAL}"
export APPI="appi-${ORG}-${ENVNAME}-${LOC}-${ORDINAL}"
export CAE="cae-${ORG}-${ENVNAME}-${LOC}-${ORDINAL}"

# Globally unique names. Add your own suffix if creation reports a conflict.
export ACR="cr${ORG}${ENVNAME}$(echo "$SUBSCRIPTION_ID" | tr -d '-' | cut -c1-8)"
export KV="kv-${ORG}-${ENVNAME}-$(echo "$SUBSCRIPTION_ID" | tr -d '-' | cut -c1-6)"
export PG="psql-${ORG}-${ENVNAME}-$(echo "$SUBSCRIPTION_ID" | tr -d '-' | cut -c1-8)"
export PG_DB="ehf"
export PG_ADMIN="ehfadmin"

# ---- container app names --------------------------------------------------
export APP_CONTROL_API="ca-${ORG}-control-api"
export APP_CASE_API="ca-${ORG}-case-api"
export APP_GATEWAY="ca-${ORG}-capability-gateway"
export APP_RUNTIME_HOST="ca-${ORG}-runtime-host"
export APP_DISPATCHER="ca-${ORG}-runtime-dispatcher"
export APP_UI="ca-${ORG}-control-ui"
export APP_JAEGER="ca-${ORG}-jaeger"
export JOB_MIGRATE="job-${ORG}-migrate"

# ---- entra ----------------------------------------------------------------
export ENTRA_APP_NAME="app-${ORG}-control-surface-${ENVNAME}"

# ---- tags (foundation.azure.yaml requires all of these) -------------------
export OWNER="<your-email-or-team>"
export COST_CENTER="<cost-center>"
export TAGS="owner=${OWNER} costCenter=${COST_CENTER} environment=${ENVNAME} \
domain=kyc dataClassification=synthetic residency=us criticality=low \
serviceId=harness-factory managedBy=az-cli repository=hganesha/ehfconcept"
```

Verify the generated names are legal before proceeding:

```bash
echo "ACR=$ACR (must be 5-50 lowercase alphanumerics)  len=${#ACR}"
echo "KV=$KV  (must be 3-24 chars)                     len=${#KV}"
echo "PG=$PG  (must be 3-63 lowercase)                 len=${#PG}"
```

### 1.3 Create the Entra app registration for the control surface

This is the human identity boundary. Container Apps built-in authentication (Part 9) uses it to force Entra sign-in before any request reaches the UI container.

Define the app roles first. These match the persona table in the migration plan; each needs a stable GUID:

```bash
cat > /tmp/ehf-app-roles.json <<JSON
[
  {"id":"$(uuidgen)","allowedMemberTypes":["User"],"description":"View plans, runs, traces, receipts, and cases","displayName":"Harness Reader","isEnabled":true,"value":"Harness.Reader"},
  {"id":"$(uuidgen)","allowedMemberTypes":["User"],"description":"Create, edit, and validate drafts","displayName":"Harness Author","isEnabled":true,"value":"Harness.Author"},
  {"id":"$(uuidgen)","allowedMemberTypes":["User"],"description":"Approve and publish plans","displayName":"Harness Approver","isEnabled":true,"value":"Harness.Approver"},
  {"id":"$(uuidgen)","allowedMemberTypes":["User"],"description":"Start, cancel, and retry runs","displayName":"Harness Operator","isEnabled":true,"value":"Harness.Operator"},
  {"id":"$(uuidgen)","allowedMemberTypes":["User"],"description":"Add evidence, facts, findings, and review actions","displayName":"Case Analyst","isEnabled":true,"value":"Case.Analyst"},
  {"id":"$(uuidgen)","allowedMemberTypes":["User"],"description":"Independent QA and final human review","displayName":"Case Reviewer","isEnabled":true,"value":"Case.Reviewer"},
  {"id":"$(uuidgen)","allowedMemberTypes":["User"],"description":"Read-only ledger and authorization evidence","displayName":"Platform Auditor","isEnabled":true,"value":"Platform.Auditor"}
]
JSON

az ad app create \
  --display-name "$ENTRA_APP_NAME" \
  --sign-in-audience AzureADMyOrg \
  --app-roles @/tmp/ehf-app-roles.json \
  --web-redirect-uris "https://placeholder.invalid/.auth/login/aad/callback" \
  --enable-id-token-issuance true

export ENTRA_APP_ID="$(az ad app list --display-name "$ENTRA_APP_NAME" --query "[0].appId" -o tsv)"
az ad sp create --id "$ENTRA_APP_ID"
export ENTRA_SP_ID="$(az ad sp show --id "$ENTRA_APP_ID" --query id -o tsv)"
echo "ENTRA_APP_ID=$ENTRA_APP_ID"
echo "ENTRA_SP_ID=$ENTRA_SP_ID"
```

The redirect URI is a placeholder because the UI FQDN does not exist yet. Step 9.2 replaces it.

Require role assignment so only assigned users can sign in:

```bash
az ad sp update --id "$ENTRA_SP_ID" --set appRoleAssignmentRequired=true
```

Create the client secret that Container Apps authentication needs, and hold it in a shell variable only — Part 4 moves it into Key Vault and you should never write it to a file:

```bash
export ENTRA_CLIENT_SECRET="$(az ad app credential reset \
  --id "$ENTRA_APP_ID" --append --years 1 \
  --display-name "container-apps-easyauth" \
  --query password -o tsv)"
test -n "$ENTRA_CLIENT_SECRET" && echo "client secret captured (not printed)"
```

> This client secret is the one unavoidable credential in the POC. Container Apps built-in authentication requires it. Rotate it on the schedule your tenant mandates, and re-run `az ad app credential reset` plus step 4.2 when you do.

Assign personas. Repeat for each test user and each role value:

```bash
assign_role() {
  local upn="$1" role_value="$2"
  local user_id role_id
  user_id="$(az ad user show --id "$upn" --query id -o tsv)"
  role_id="$(az ad sp show --id "$ENTRA_SP_ID" \
    --query "appRoles[?value=='${role_value}'].id | [0]" -o tsv)"
  az rest --method POST \
    --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${ENTRA_SP_ID}/appRoleAssignedTo" \
    --headers "Content-Type=application/json" \
    --body "{\"principalId\":\"${user_id}\",\"resourceId\":\"${ENTRA_SP_ID}\",\"appRoleId\":\"${role_id}\"}"
}

assign_role "analyst@example.com"  "Case.Analyst"
assign_role "reviewer@example.com" "Case.Reviewer"
assign_role "author@example.com"   "Harness.Author"
assign_role "you@example.com"      "Harness.Operator"
```

Confirm the assignments:

```bash
az rest --method GET \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/${ENTRA_SP_ID}/appRoleAssignedTo" \
  --query "value[].{principal:principalDisplayName, role:appRoleId}" -o table
```

> **Honest limitation.** These roles appear in the `roles` claim of the token Container Apps validates, but the services in this repository do not yet read that claim (`AZ-002`). Until they do, the roles gate *entry to the control surface*, and every signed-in user has the same authority inside it. Do not demonstrate separation of duties from this deployment.

### 1.4 Create the resource group

Everything else in this runbook lives here, and deleting this group removes the whole stamp.

```bash
az group create --name "$RG" --location "$LOC" --tags $TAGS
az group show --name "$RG" --query "{name:name, location:location, state:properties.provisioningState}" -o table
```

### 1.5 Create one user-assigned managed identity per workload

Per the migration plan, identities are not shared across services. User-assigned identities are used throughout because Container Apps needs the identity to exist *before* the app is created in order to pull from ACR and resolve Key Vault references.

```bash
for svc in migrate control-api case-api capability-gateway runtime-host runtime-dispatcher control-ui; do
  az identity create -g "$RG" -n "id-${ORG}-${svc}-${ENVNAME}" -l "$LOC" --tags $TAGS -o none
  echo "created id-${ORG}-${svc}-${ENVNAME}"
done

mi_id()        { az identity show -g "$RG" -n "id-${ORG}-$1-${ENVNAME}" --query id -o tsv; }
mi_principal() { az identity show -g "$RG" -n "id-${ORG}-$1-${ENVNAME}" --query principalId -o tsv; }
mi_client()    { az identity show -g "$RG" -n "id-${ORG}-$1-${ENVNAME}" --query clientId -o tsv; }

export MI_MIGRATE_ID="$(mi_id migrate)"
export MI_CONTROL_API_ID="$(mi_id control-api)"
export MI_CASE_API_ID="$(mi_id case-api)"
export MI_GATEWAY_ID="$(mi_id capability-gateway)"
export MI_RUNTIME_HOST_ID="$(mi_id runtime-host)"
export MI_DISPATCHER_ID="$(mi_id runtime-dispatcher)"
export MI_UI_ID="$(mi_id control-ui)"
export MI_DISPATCHER_CLIENT_ID="$(mi_client runtime-dispatcher)"

az identity list -g "$RG" --query "[].{name:name, clientId:clientId}" -o table
```

### 1.6 (Optional) GitHub OIDC deployment identity

Only needed if you intend to drive redeployments from GitHub Actions instead of your workstation. No client secret is created or stored.

```bash
az identity create -g "$RG" -n "id-${ORG}-deploy-${ENVNAME}" -l "$LOC" --tags $TAGS -o none
export MI_DEPLOY_ID="$(mi_id deploy)"
export MI_DEPLOY_PRINCIPAL="$(mi_principal deploy)"

az identity federated-credential create \
  --name "github-main" \
  --identity-name "id-${ORG}-deploy-${ENVNAME}" \
  --resource-group "$RG" \
  --issuer "https://token.actions.githubusercontent.com" \
  --subject "repo:hganesha/ehfconcept:ref:refs/heads/main" \
  --audiences "api://AzureADTokenExchange"

az role assignment create \
  --assignee-object-id "$MI_DEPLOY_PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role "Contributor" \
  --scope "/subscriptions/${SUBSCRIPTION_ID}/resourceGroups/${RG}"
```

Scope the deployment identity to the resource group, never the subscription.

---

## Part 2 — Platform resources

### 2.1 Network

The Container Apps environment and PostgreSQL each need their own delegated subnet. Workload-profile environments require at least a `/27`; `/23` is used here to leave headroom for revision rollouts.

```bash
az network vnet create -g "$RG" -n "$VNET" -l "$LOC" \
  --address-prefixes "10.60.0.0/16" --tags $TAGS -o none

az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n "snet-apps" \
  --address-prefixes "10.60.0.0/23" \
  --delegations "Microsoft.App/environments" -o none

az network vnet subnet create -g "$RG" --vnet-name "$VNET" -n "snet-postgres" \
  --address-prefixes "10.60.4.0/26" \
  --delegations "Microsoft.DBforPostgreSQL/flexibleServers" -o none

export SUBNET_APPS_ID="$(az network vnet subnet show -g "$RG" --vnet-name "$VNET" -n snet-apps --query id -o tsv)"
export SUBNET_PG_ID="$(az network vnet subnet show -g "$RG" --vnet-name "$VNET" -n snet-postgres --query id -o tsv)"
```

Private DNS zone for the database:

```bash
az network private-dns zone create -g "$RG" -n "${PG}.private.postgres.database.azure.com" --tags $TAGS -o none
az network private-dns link vnet create -g "$RG" \
  --zone-name "${PG}.private.postgres.database.azure.com" \
  --name "link-${VNET}" --virtual-network "$VNET" --registration-enabled false -o none
export PG_DNS_ZONE_ID="$(az network private-dns zone show -g "$RG" -n "${PG}.private.postgres.database.azure.com" --query id -o tsv)"
```

### 2.2 Container registry

```bash
az acr create -g "$RG" -n "$ACR" -l "$LOC" --sku Standard \
  --admin-enabled false --tags $TAGS -o none
export ACR_LOGIN_SERVER="$(az acr show -g "$RG" -n "$ACR" --query loginServer -o tsv)"
echo "ACR_LOGIN_SERVER=$ACR_LOGIN_SERVER"
```

Admin user stays disabled. Every pull uses a managed identity (Part 3).

### 2.3 Log Analytics and Application Insights

```bash
az monitor log-analytics workspace create -g "$RG" -n "$LAW" -l "$LOC" \
  --retention-time 30 --tags $TAGS -o none
export LAW_ID="$(az monitor log-analytics workspace show -g "$RG" -n "$LAW" --query id -o tsv)"
export LAW_CUSTOMER_ID="$(az monitor log-analytics workspace show -g "$RG" -n "$LAW" --query customerId -o tsv)"
export LAW_KEY="$(az monitor log-analytics workspace get-shared-keys -g "$RG" -n "$LAW" --query primarySharedKey -o tsv)"

az monitor app-insights component create -g "$RG" -a "$APPI" -l "$LOC" \
  --workspace "$LAW_ID" --application-type web --tags $TAGS -o none
export APPI_CONNECTION_STRING="$(az monitor app-insights component show -g "$RG" -a "$APPI" --query connectionString -o tsv)"
```

### 2.4 Key Vault

RBAC-authorized, soft-delete on, purge protection on — the last one is not optional for anything that will hold a signing key later (`AZ-006`).

```bash
az keyvault create -g "$RG" -n "$KV" -l "$LOC" \
  --enable-rbac-authorization true \
  --enable-purge-protection true \
  --retention-days 7 \
  --tags $TAGS -o none
export KV_URI="$(az keyvault show -g "$RG" -n "$KV" --query properties.vaultUri -o tsv | sed 's:/*$::')"
echo "KV_URI=$KV_URI"
```

Grant yourself write access to the vault (RBAC mode means the creator has no data-plane rights by default):

```bash
export ME_OBJECT_ID="$(az ad signed-in-user show --query id -o tsv)"
az role assignment create \
  --assignee-object-id "$ME_OBJECT_ID" --assignee-principal-type User \
  --role "Key Vault Secrets Officer" \
  --scope "$(az keyvault show -g "$RG" -n "$KV" --query id -o tsv)"
```

Role assignments take up to a few minutes to propagate. If step 4.2 fails with `Forbidden`, wait and retry.

### 2.5 PostgreSQL Flexible Server

```bash
export PG_ADMIN_PASSWORD="$(openssl rand -base64 33 | tr -d '/+=' | cut -c1-32)"

az postgres flexible-server create -g "$RG" -n "$PG" -l "$LOC" \
  --version 17 \
  --tier Burstable --sku-name Standard_B2s --storage-size 32 \
  --admin-user "$PG_ADMIN" --admin-password "$PG_ADMIN_PASSWORD" \
  --vnet "$VNET" --subnet "$SUBNET_PG_ID" --private-dns-zone "$PG_DNS_ZONE_ID" \
  --active-directory-auth Enabled --password-auth Enabled \
  --tags $TAGS --yes -o none

az postgres flexible-server db create -g "$RG" -s "$PG" -d "$PG_DB" -o none
export PG_FQDN="$(az postgres flexible-server show -g "$RG" -n "$PG" --query fullyQualifiedDomainName -o tsv)"
echo "PG_FQDN=$PG_FQDN"
```

Add yourself as an Entra administrator so you can inspect the database without the password later:

```bash
az postgres flexible-server ad-admin create -g "$RG" -s "$PG" \
  --object-id "$ME_OBJECT_ID" \
  --display-name "$(az ad signed-in-user show --query userPrincipalName -o tsv)" \
  --type User
```

> Password authentication stays enabled because `packages/persistence` and `packages/case-store` build pools from a `DATABASE_URL` connection string. `AZ-005` replaces this with `DefaultAzureCredential` token authentication and per-identity database roles; until that lands, one administrator credential is shared by all services and the per-identity grant table in the migration plan cannot be enforced.

Build the connection string. `sslmode=require` is mandatory — Flexible Server rejects unencrypted connections, and `pg` honours the parameter against the system CA bundle:

```bash
export DATABASE_URL="postgresql://${PG_ADMIN}:${PG_ADMIN_PASSWORD}@${PG_FQDN}:5432/${PG_DB}?sslmode=require"
```

---

## Part 3 — Role assignments

Give each identity the least privilege it needs. Nothing here grants an identity access to another service's resources.

```bash
export ACR_ID="$(az acr show -g "$RG" -n "$ACR" --query id -o tsv)"
export KV_ID="$(az keyvault show -g "$RG" -n "$KV" --query id -o tsv)"

for svc in migrate control-api case-api capability-gateway runtime-host runtime-dispatcher control-ui; do
  principal="$(mi_principal "$svc")"

  # Pull digest-pinned images from the registry.
  az role assignment create \
    --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
    --role "AcrPull" --scope "$ACR_ID" -o none

  # Resolve Key Vault secret references at revision start.
  az role assignment create \
    --assignee-object-id "$principal" --assignee-principal-type ServicePrincipal \
    --role "Key Vault Secrets User" --scope "$KV_ID" -o none

  echo "granted AcrPull + Key Vault Secrets User to id-${ORG}-${svc}-${ENVNAME}"
done
```

Verify before moving on — a missing `AcrPull` surfaces later as an opaque image-pull failure:

```bash
az role assignment list --scope "$ACR_ID" --query "[].{principal:principalName, role:roleDefinitionName}" -o table
az role assignment list --scope "$KV_ID"  --query "[].{principal:principalName, role:roleDefinitionName}" -o table
```

---

## Part 4 — Secrets

### 4.1 Generate the platform secrets

The compose defaults (`local-poc-secret-change-before-sharing`, `local-runtime-host-token-change-before-sharing`) must never reach a deployed stamp.

```bash
export EXECUTION_ENVELOPE_SECRET="$(openssl rand -base64 48)"
export RUNTIME_HOST_AUTH_TOKEN="$(openssl rand -base64 48)"
```

### 4.2 Store them in Key Vault

```bash
az keyvault secret set --vault-name "$KV" -n "database-url"              --value "$DATABASE_URL" -o none
az keyvault secret set --vault-name "$KV" -n "execution-envelope-secret" --value "$EXECUTION_ENVELOPE_SECRET" -o none
az keyvault secret set --vault-name "$KV" -n "runtime-host-token"        --value "$RUNTIME_HOST_AUTH_TOKEN" -o none
az keyvault secret set --vault-name "$KV" -n "pg-admin-password"         --value "$PG_ADMIN_PASSWORD" -o none
az keyvault secret set --vault-name "$KV" -n "entra-client-secret"       --value "$ENTRA_CLIENT_SECRET" -o none

# Optional: real model calls. Omit and the gateway uses the deterministic
# recorded adapter, exactly as it does locally without a key.
# az keyvault secret set --vault-name "$KV" -n "openrouter-api-key" --value "<key>" -o none

az keyvault secret list --vault-name "$KV" --query "[].name" -o tsv
```

Record the secret reference URIs used by every app definition:

```bash
export SECREF_DB="keyvaultref:${KV_URI}/secrets/database-url"
export SECREF_ENVELOPE="keyvaultref:${KV_URI}/secrets/execution-envelope-secret"
export SECREF_RUNTIME_TOKEN="keyvaultref:${KV_URI}/secrets/runtime-host-token"
export SECREF_ENTRA="keyvaultref:${KV_URI}/secrets/entra-client-secret"
```

Only secret **names and URIs** appear in deployment output from here on; no secret value is ever passed on a command line again.

---

## Part 5 — Build and publish images

Builds run inside ACR, so no local Docker daemon is involved. `.dockerignore` already excludes `docs`, `target`, `node_modules`, `.env`, and `.env.local` from the build context.

### 5.1 Tag the release

```bash
export RELEASE_TAG="$(git rev-parse --short HEAD)"
export SOURCE_REVISION="$(git rev-parse HEAD)"
echo "RELEASE_TAG=$RELEASE_TAG"
```

Commit or stash local changes first: the tag must identify exactly what is being deployed.

### 5.2 Build both images

```bash
az acr build --registry "$ACR" --platform linux/amd64 \
  --image "ehf/services:${RELEASE_TAG}" --file Dockerfile .

az acr build --registry "$ACR" --platform linux/amd64 \
  --image "ehf/control-ui:${RELEASE_TAG}" --file Dockerfile.ui .
```

The services build takes several minutes on first run (`pnpm install --frozen-lockfile` for the whole workspace). The UI build additionally runs `pnpm --filter @ehf/control-ui build`.

### 5.3 Resolve digests and pin them

```bash
export SERVICES_DIGEST="$(az acr repository show -n "$ACR" --image "ehf/services:${RELEASE_TAG}" --query digest -o tsv)"
export UI_DIGEST="$(az acr repository show -n "$ACR" --image "ehf/control-ui:${RELEASE_TAG}" --query digest -o tsv)"

export SERVICES_IMAGE="${ACR_LOGIN_SERVER}/ehf/services@${SERVICES_DIGEST}"
export UI_IMAGE="${ACR_LOGIN_SERVER}/ehf/control-ui@${UI_DIGEST}"

echo "SERVICES_IMAGE=$SERVICES_IMAGE"
echo "UI_IMAGE=$UI_IMAGE"
```

Every app and job below references `@sha256:…`, never `:latest` and never the tag. Tags move; digests do not, and the release manifest in step 11.4 records exactly these values.

---

## Part 6 — Container Apps environment

### 6.1 Create the environment

Workload profiles + VNet integration, with the environment itself reachable externally so the UI can be published while every other app stays on internal ingress.

```bash
az containerapp env create -g "$RG" -n "$CAE" -l "$LOC" \
  --enable-workload-profiles \
  --infrastructure-subnet-resource-id "$SUBNET_APPS_ID" \
  --logs-destination log-analytics \
  --logs-workspace-id "$LAW_CUSTOMER_ID" \
  --logs-workspace-key "$LAW_KEY" \
  --enable-peer-to-peer-encryption \
  --tags $TAGS

export CAE_DOMAIN="$(az containerapp env show -g "$RG" -n "$CAE" --query properties.defaultDomain -o tsv)"
echo "CAE_DOMAIN=$CAE_DOMAIN"
```

`--enable-peer-to-peer-encryption` matters here: the services call each other over plain `http://` internal FQDNs (that is what `CAPABILITY_GATEWAY_URL`, `CASE_API_URL`, and `CONTROL_API_INTERNAL_URL` expect), and this flag makes the environment encrypt that traffic in transit for you. If your CLI rejects the flag, upgrade the extension (`az extension add --name containerapp --upgrade`).

### 6.2 Send platform telemetry to Application Insights

```bash
az containerapp env telemetry app-insights set -g "$RG" -n "$CAE" \
  --connection-string "$APPI_CONNECTION_STRING" \
  --enable-open-telemetry-traces true \
  --enable-open-telemetry-logs true
```

This gives you container logs and platform traces in Application Insights. It does **not** replace the application's own OTLP exporter: `packages/telemetry` reads `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and posts the harness span hierarchy there, which is why step 8.1 deploys Jaeger. Replacing Jaeger with a `TraceLinkProvider` over Application Insights is `AZ-007`.

### 6.3 Record the internal service URLs

Internal ingress FQDNs follow a fixed pattern, so they can be computed before the apps exist:

```bash
export URL_CONTROL_API="http://${APP_CONTROL_API}.internal.${CAE_DOMAIN}"
export URL_CASE_API="http://${APP_CASE_API}.internal.${CAE_DOMAIN}"
export URL_GATEWAY="http://${APP_GATEWAY}.internal.${CAE_DOMAIN}"
export URL_RUNTIME_HOST="http://${APP_RUNTIME_HOST}.internal.${CAE_DOMAIN}"
export URL_JAEGER_QUERY="http://${APP_JAEGER}.internal.${CAE_DOMAIN}"
export URL_JAEGER_OTLP="http://${APP_JAEGER}.internal.${CAE_DOMAIN}:4318/v1/traces"
```

Ingress maps port 80 on the internal FQDN to each app's target port, so no port is needed except for Jaeger's additional OTLP port.

---

## Part 7 — Database migrations

Migrations run as a manual Container Apps job with their own identity, exactly once per release, before any service starts.

### 7.1 Create the job

```bash
az containerapp job create -g "$RG" -n "$JOB_MIGRATE" --environment "$CAE" \
  --trigger-type Manual \
  --replica-timeout 1800 --replica-retry-limit 1 \
  --replica-completion-count 1 --parallelism 1 \
  --image "$SERVICES_IMAGE" \
  --cpu 1 --memory 2Gi \
  --registry-server "$ACR_LOGIN_SERVER" --registry-identity "$MI_MIGRATE_ID" \
  --mi-user-assigned "$MI_MIGRATE_ID" \
  --secrets "database-url=${SECREF_DB},identityref:${MI_MIGRATE_ID}" \
  --env-vars \
    "DATABASE_URL=secretref:database-url" \
    "CASE_DATABASE_URL=secretref:database-url" \
    "CASE_CORE_SCHEMA=case_core" \
    "CASE_LEDGER_SCHEMA=case_ledger" \
    "EVIDENCE_SCHEMA=evidence" \
  --command "/bin/sh" \
  --args "-c" "pnpm db:migrate" \
  --tags $TAGS
```

`pnpm db:migrate` runs `@ehf/persistence` then `@ehf/case-store` migrations, in that order — the same command Compose runs.

### 7.2 Execute it and confirm success

```bash
az containerapp job start -g "$RG" -n "$JOB_MIGRATE"

# Poll until Status is Succeeded (usually under two minutes).
az containerapp job execution list -g "$RG" -n "$JOB_MIGRATE" \
  --query "[0].{name:name, status:properties.status, start:properties.startTime}" -o table
```

If it reports `Failed`, read the logs before changing anything:

```bash
export MIGRATE_EXEC="$(az containerapp job execution list -g "$RG" -n "$JOB_MIGRATE" --query "[0].name" -o tsv)"
az containerapp job logs show -g "$RG" -n "$JOB_MIGRATE" --container "$JOB_MIGRATE" --execution "$MIGRATE_EXEC" --tail 200
```

The usual first failure is the database not resolving, which means the job's replica could not reach the private DNS zone — confirm the environment's infrastructure subnet is in the same VNet as the zone link from step 2.1.

Migrations are idempotent. Re-run this job on every release that changes schema.

---

## Part 8 — Backend services

Deploy in dependency order: Jaeger, capability gateway, case API, control API, runtime host, dispatcher. Every app below uses internal ingress or no ingress at all — the control UI in Part 9 is the only externally reachable app.

Common values used by all of them:

```bash
export COMMON_OTEL="OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${URL_JAEGER_OTLP} OTEL_TRACES_SAMPLER_ARG=1 DEPLOYMENT_ENVIRONMENT=${ENVNAME} CLOUD_REGION=${LOC}"
```

### 8.1 Jaeger (trace sink and query API)

A single all-in-one container, internal only, with a second ingress port for OTLP.

```bash
az containerapp create -g "$RG" -n "$APP_JAEGER" --environment "$CAE" \
  --image "docker.io/jaegertracing/jaeger:2.11.0" \
  --ingress internal --target-port 16686 --transport auto \
  --additional-port-mappings "4318:4318" \
  --min-replicas 1 --max-replicas 1 --cpu 1 --memory 2Gi \
  --args "--set=receivers.otlp.protocols.http.endpoint=0.0.0.0:4318" \
         "--set=receivers.otlp.protocols.grpc.endpoint=0.0.0.0:4317" \
  --tags $TAGS
```

> Jaeger all-in-one keeps spans in memory. A restart loses trace history; durable run events and gateway receipts in PostgreSQL remain the audit record, exactly as the README states. Do not treat this container as an audit store.

### 8.2 Capability gateway

Holds the execution-envelope secret and the optional model credential. No other service receives the model key.

```bash
az containerapp create -g "$RG" -n "$APP_GATEWAY" --environment "$CAE" \
  --image "$SERVICES_IMAGE" \
  --registry-server "$ACR_LOGIN_SERVER" --registry-identity "$MI_GATEWAY_ID" \
  --user-assigned "$MI_GATEWAY_ID" \
  --ingress internal --target-port 4101 --transport auto \
  --min-replicas 1 --max-replicas 3 --cpu 1 --memory 2Gi \
  --secrets "database-url=${SECREF_DB},identityref:${MI_GATEWAY_ID}" \
            "envelope-secret=${SECREF_ENVELOPE},identityref:${MI_GATEWAY_ID}" \
  --env-vars \
    "GATEWAY_PORT=4101" \
    "DATABASE_URL=secretref:database-url" \
    "CASE_DATABASE_URL=secretref:database-url" \
    "EXECUTION_ENVELOPE_SECRET=secretref:envelope-secret" \
    "MODEL_PROFILES_PATH=/app/config/model-profiles.json" \
    "TRACE_VIEWER_BASE_URL=${URL_JAEGER_QUERY}" \
    $COMMON_OTEL \
  --command "/bin/sh" --args "-c" "pnpm --filter @ehf/capability-gateway start" \
  --tags $TAGS
```

To enable real model calls, add the Key Vault secret from step 4.2 and update the app. Run this after Part 9, when `UI_FQDN` exists:

```bash
az containerapp secret set -g "$RG" -n "$APP_GATEWAY" \
  --secrets "openrouter-key=keyvaultref:${KV_URI}/secrets/openrouter-api-key,identityref:${MI_GATEWAY_ID}"
az containerapp update -g "$RG" -n "$APP_GATEWAY" \
  --set-env-vars "OPENROUTER_API_KEY=secretref:openrouter-key" \
                 "OPENROUTER_SITE_URL=https://${UI_FQDN:-placeholder}" \
                 "OPENROUTER_APP_NAME=EHF Azure POC"
```

Without it the gateway reports `runtimeMode: Recorded` and serves the deterministic adapter — the same offline behaviour as local Compose.

### 8.3 Case API

```bash
az containerapp create -g "$RG" -n "$APP_CASE_API" --environment "$CAE" \
  --image "$SERVICES_IMAGE" \
  --registry-server "$ACR_LOGIN_SERVER" --registry-identity "$MI_CASE_API_ID" \
  --user-assigned "$MI_CASE_API_ID" \
  --ingress internal --target-port 4102 --transport auto \
  --min-replicas 1 --max-replicas 3 --cpu 1 --memory 2Gi \
  --secrets "database-url=${SECREF_DB},identityref:${MI_CASE_API_ID}" \
  --env-vars \
    "CASE_API_PORT=4102" \
    "DATABASE_URL=secretref:database-url" \
    "CASE_DATABASE_URL=secretref:database-url" \
    "CASE_CORE_SCHEMA=case_core" \
    "CASE_LEDGER_SCHEMA=case_ledger" \
    "EVIDENCE_SCHEMA=evidence" \
    "CASE_ARTIFACT_BACKEND=postgres" \
    "CASE_EVIDENCE_REQUIRE_SCAN=false" \
    "CASE_EVIDENCE_MAX_BYTES=1048576" \
    "MODEL_PROFILES_PATH=/app/config/model-profiles.json" \
    "TRACE_VIEWER_BASE_URL=${URL_JAEGER_QUERY}" \
    $COMMON_OTEL \
  --command "/bin/sh" --args "-c" "pnpm --filter @ehf/case-api start" \
  --tags $TAGS
```

`CASE_ARTIFACT_BACKEND=postgres` keeps evidence bytes in the database. The Blob adapter is `AZ-013` and is not implemented.

### 8.4 Control API

```bash
az containerapp create -g "$RG" -n "$APP_CONTROL_API" --environment "$CAE" \
  --image "$SERVICES_IMAGE" \
  --registry-server "$ACR_LOGIN_SERVER" --registry-identity "$MI_CONTROL_API_ID" \
  --user-assigned "$MI_CONTROL_API_ID" \
  --ingress internal --target-port 4100 --transport auto \
  --min-replicas 1 --max-replicas 3 --cpu 1 --memory 2Gi \
  --secrets "database-url=${SECREF_DB},identityref:${MI_CONTROL_API_ID}" \
  --env-vars \
    "CONTROL_API_PORT=4100" \
    "DATABASE_URL=secretref:database-url" \
    "CASE_DATABASE_URL=secretref:database-url" \
    "MODEL_PROFILES_PATH=/app/config/model-profiles.json" \
    "TRACE_VIEWER_BASE_URL=${URL_JAEGER_QUERY}" \
    $COMMON_OTEL \
  --command "/bin/sh" --args "-c" "pnpm --filter @ehf/control-api start" \
  --tags $TAGS
```

### 8.5 Runtime host

Executes the compiled LangGraph plan. It needs the envelope secret, the shared runtime token, and — until `AZ-010` lands — direct database access for checkpoints.

```bash
az containerapp create -g "$RG" -n "$APP_RUNTIME_HOST" --environment "$CAE" \
  --image "$SERVICES_IMAGE" \
  --registry-server "$ACR_LOGIN_SERVER" --registry-identity "$MI_RUNTIME_HOST_ID" \
  --user-assigned "$MI_RUNTIME_HOST_ID" \
  --ingress internal --target-port 8088 --transport auto \
  --min-replicas 1 --max-replicas 3 --cpu 1 --memory 2Gi \
  --secrets "database-url=${SECREF_DB},identityref:${MI_RUNTIME_HOST_ID}" \
            "envelope-secret=${SECREF_ENVELOPE},identityref:${MI_RUNTIME_HOST_ID}" \
            "runtime-token=${SECREF_RUNTIME_TOKEN},identityref:${MI_RUNTIME_HOST_ID}" \
  --env-vars \
    "RUNTIME_HOST_PORT=8088" \
    "RUNTIME_CHECKPOINT_DATABASE_URL=secretref:database-url" \
    "RUNTIME_HOST_AUTH_TOKEN=secretref:runtime-token" \
    "EXECUTION_ENVELOPE_SECRET=secretref:envelope-secret" \
    "CAPABILITY_GATEWAY_URL=${URL_GATEWAY}" \
    "CASE_API_URL=${URL_CASE_API}" \
    $COMMON_OTEL \
  --command "/bin/sh" --args "-c" "./node_modules/.bin/tsx apps/runtime-host/src/server.ts" \
  --tags $TAGS
```

The command invokes the checked-in `tsx` binary directly, matching the Compose definition, so the container never asks pnpm to relink the workspace at startup.

### 8.6 Runtime dispatcher

No ingress. It owns leases and fencing, so it must never scale to zero — nothing would wake it, because it polls PostgreSQL.

```bash
az containerapp create -g "$RG" -n "$APP_DISPATCHER" --environment "$CAE" \
  --image "$SERVICES_IMAGE" \
  --registry-server "$ACR_LOGIN_SERVER" --registry-identity "$MI_DISPATCHER_ID" \
  --user-assigned "$MI_DISPATCHER_ID" \
  --min-replicas 1 --max-replicas 1 --cpu 1 --memory 2Gi \
  --secrets "database-url=${SECREF_DB},identityref:${MI_DISPATCHER_ID}" \
            "envelope-secret=${SECREF_ENVELOPE},identityref:${MI_DISPATCHER_ID}" \
            "runtime-token=${SECREF_RUNTIME_TOKEN},identityref:${MI_DISPATCHER_ID}" \
  --env-vars \
    "DATABASE_URL=secretref:database-url" \
    "CASE_DATABASE_URL=secretref:database-url" \
    "EXECUTION_ENVELOPE_SECRET=secretref:envelope-secret" \
    "RUNTIME_PROVIDER=local_http" \
    "RUNTIME_LOCAL_ENDPOINT=${URL_RUNTIME_HOST}/invocations" \
    "RUNTIME_HOST_AUTH_TOKEN=secretref:runtime-token" \
    "WORKER_LEASE_SECONDS=60" \
    "WORKER_POLL_MS=1000" \
    "MODEL_PROFILES_PATH=/app/config/model-profiles.json" \
    $COMMON_OTEL \
  --command "/bin/sh" --args "-c" "pnpm --filter @ehf/runtime-worker start" \
  --tags $TAGS
```

Keep `--max-replicas 1` for the POC. Fencing epochs and leases are implemented and would tolerate more, but a single dispatcher makes demo traces readable and removes lease contention as a variable.

### 8.7 Confirm every backend is running

```bash
az containerapp list -g "$RG" \
  --query "[].{name:name, revision:properties.latestRevisionName, ingress:properties.configuration.ingress.external, state:properties.provisioningState}" -o table

for app in "$APP_GATEWAY" "$APP_CASE_API" "$APP_CONTROL_API" "$APP_RUNTIME_HOST" "$APP_DISPATCHER"; do
  echo "--- $app"
  az containerapp logs show -g "$RG" -n "$app" --tail 20 --type console
done
```

A crash loop here is almost always a missing environment variable: `runtime.config_missing:<NAME>`, `runtime.checkpoint_database_url_missing`, or `runtime_host.auth_token_missing` name the exact variable.

---

## Part 9 — Control surface

### 9.1 Deploy the UI

The UI runs as a Next.js standalone server (`output: "standalone"`), reaching the backends server-side. It is the only app with external ingress.

```bash
az containerapp create -g "$RG" -n "$APP_UI" --environment "$CAE" \
  --image "$UI_IMAGE" \
  --registry-server "$ACR_LOGIN_SERVER" --registry-identity "$MI_UI_ID" \
  --user-assigned "$MI_UI_ID" \
  --ingress external --target-port 4200 --transport auto \
  --min-replicas 1 --max-replicas 3 --cpu 1 --memory 2Gi \
  --env-vars \
    "CONTROL_API_INTERNAL_URL=${URL_CONTROL_API}" \
    "CAPABILITY_GATEWAY_INTERNAL_URL=${URL_GATEWAY}" \
    "CASE_API_INTERNAL_URL=${URL_CASE_API}" \
    "JAEGER_API_INTERNAL_URL=${URL_JAEGER_QUERY}" \
    "CASE_UI_TENANT_ID=tenant_demo" \
    "CONTROL_UI_VERSION=0.1.0" \
    "RUNTIME_PROVIDER=local_http" \
    "BUILD_COMMIT_SHA=${SOURCE_REVISION}" \
  --tags $TAGS

export UI_FQDN="$(az containerapp show -g "$RG" -n "$APP_UI" --query properties.configuration.ingress.fqdn -o tsv)"
echo "Control surface: https://${UI_FQDN}"
```

`TRACE_VIEWER_PUBLIC_URL` is deliberately unset: Jaeger is internal, so a browser deep link would not resolve. Step 9.4 offers the two ways to fix that.

### 9.2 Point the Entra app registration at the real FQDN

```bash
az ad app update --id "$ENTRA_APP_ID" \
  --web-redirect-uris "https://${UI_FQDN}/.auth/login/aad/callback"
```

### 9.3 Turn on Entra sign-in

```bash
az containerapp secret set -g "$RG" -n "$APP_UI" \
  --secrets "entra-client-secret=${SECREF_ENTRA},identityref:${MI_UI_ID}"

az containerapp auth microsoft update -g "$RG" -n "$APP_UI" \
  --client-id "$ENTRA_APP_ID" \
  --client-secret-name "entra-client-secret" \
  --issuer "https://login.microsoftonline.com/${TENANT_ID}/v2.0" \
  --tenant-id "$TENANT_ID" \
  --yes

az containerapp auth update -g "$RG" -n "$APP_UI" \
  --enabled true \
  --unauthenticated-client-action RedirectToLoginPage \
  --redirect-provider AzureActiveDirectory \
  --require-https true
```

Verify that an unauthenticated request is redirected rather than served:

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "https://${UI_FQDN}/"
# expect 302 to login.microsoftonline.com
```

Then open `https://${UI_FQDN}` in a browser, sign in as one of the users assigned in step 1.3, and confirm the Cases, Runs, and Author pages load.

> Sign-in is the boundary. The services behind it still read `x-actor-id` and `x-tenant-id` as supplied (`AZ-002`), so every signed-in user acts with the same authority. Say this plainly in any demo.

### 9.4 (Optional) Reach the Jaeger UI

Two supported options; pick one.

**Option A — port-forward for an operator session (nothing is exposed):**

```bash
az containerapp exec -g "$RG" -n "$APP_UI" --command "/bin/sh"
# inside the container:
#   node -e "fetch('http://ca-hf-jaeger.internal.<domain>/api/services').then(r=>r.text()).then(console.log)"
```

**Option B — publish Jaeger behind the same Entra app:**

```bash
az containerapp ingress update -g "$RG" -n "$APP_JAEGER" --type external --target-port 16686
export JAEGER_FQDN="$(az containerapp show -g "$RG" -n "$APP_JAEGER" --query properties.configuration.ingress.fqdn -o tsv)"

az ad app update --id "$ENTRA_APP_ID" --web-redirect-uris \
  "https://${UI_FQDN}/.auth/login/aad/callback" \
  "https://${JAEGER_FQDN}/.auth/login/aad/callback"

az containerapp secret set -g "$RG" -n "$APP_JAEGER" \
  --secrets "entra-client-secret=${SECREF_ENTRA},identityref:${MI_UI_ID}"
az containerapp auth microsoft update -g "$RG" -n "$APP_JAEGER" \
  --client-id "$ENTRA_APP_ID" --client-secret-name "entra-client-secret" \
  --issuer "https://login.microsoftonline.com/${TENANT_ID}/v2.0" --tenant-id "$TENANT_ID" --yes
az containerapp auth update -g "$RG" -n "$APP_JAEGER" \
  --enabled true --unauthenticated-client-action RedirectToLoginPage \
  --redirect-provider AzureActiveDirectory --require-https true

# Now the UI's trace deep links resolve.
az containerapp update -g "$RG" -n "$APP_UI" \
  --set-env-vars "TRACE_VIEWER_PUBLIC_URL=https://${JAEGER_FQDN}"
az containerapp update -g "$RG" -n "$APP_CONTROL_API" \
  --set-env-vars "TRACE_VIEWER_BASE_URL=https://${JAEGER_FQDN}"
```

Never leave Jaeger exposed without either authentication or an IP restriction: spans carry run, plan, and case identifiers.

Note the trade-off. Entra sign-in makes the Jaeger UI usable in a browser but redirects scripted calls to the login page, so `scripts/verify-trace.sh` cannot read the API through it. Step 10.2 therefore uses an IP-restricted window instead of sign-in for the duration of the smoke test.

---

## Part 10 — Verify the deployment

### 10.1 Compile the harness plans locally

Plans are produced by the Rust compiler and admitted over the control API. They are not built inside the image, so compile them on your workstation:

```bash
make compile
ls -l artifacts/plans/kyc.plan.json artifacts/plans/invoice.plan.json
```

### 10.2 Open an operator window on the private APIs

The demo scripts (`scripts/demo.sh`, `scripts/demo-kyc-e2e.sh`) drive the control API, gateway, and case API directly, and `verify-trace.sh` also queries Jaeger. All four are internal. Expose them temporarily, restricted to your own address:

```bash
export MY_IP="$(curl -s https://api.ipify.org)/32"
echo "operator address: $MY_IP"

for app in "$APP_CONTROL_API" "$APP_GATEWAY" "$APP_CASE_API" "$APP_JAEGER"; do
  az containerapp ingress update -g "$RG" -n "$app" --type external
  az containerapp ingress access-restriction set -g "$RG" -n "$app" \
    --rule-name "operator-smoke" --ip-address "$MY_IP" --action Allow \
    --description "temporary smoke-test window"
done

export CONTROL_API_URL="https://$(az containerapp show -g "$RG" -n "$APP_CONTROL_API" --query properties.configuration.ingress.fqdn -o tsv)"
export GATEWAY_URL="https://$(az containerapp show -g "$RG" -n "$APP_GATEWAY" --query properties.configuration.ingress.fqdn -o tsv)"
export CASE_API_URL="https://$(az containerapp show -g "$RG" -n "$APP_CASE_API" --query properties.configuration.ingress.fqdn -o tsv)"
export JAEGER_API_URL="https://$(az containerapp show -g "$RG" -n "$APP_JAEGER" --query properties.configuration.ingress.fqdn -o tsv)"
```

An `Allow` rule denies every other source address. Confirm that before you run anything:

```bash
curl -s -o /dev/null -w "from your IP: %{http_code}\n" "${CONTROL_API_URL}/health/ready"   # expect 200
```

### 10.3 Run the smoke tests

```bash
# 1. Readiness across all three services.
for url in "$CONTROL_API_URL" "$GATEWAY_URL" "$CASE_API_URL"; do
  printf '%-70s %s\n' "$url/health/ready" "$(curl -s -o /dev/null -w '%{http_code}' "$url/health/ready")"
done

# 2. Gateway configuration — confirms model mode without revealing the key.
curl -s "${GATEWAY_URL}/v1/status" | jq

# 3. Plan admission + run execution through the dispatcher and runtime host.
./scripts/demo.sh

# 4. Full KYC path: harness run plus canonical case commands, ledger, and evidence.
./scripts/demo-kyc-e2e.sh

# 5. Trace topology for the run the previous step printed.
#    Reads CONTROL_API_URL and JAEGER_API_URL, both exported in step 10.2.
./scripts/verify-trace.sh "<RUN-ID>"
```

`verify-trace.sh` queries the Jaeger API directly, which is why Jaeger is in the operator window above. It asserts that one trace spans `harness-runtime-dispatcher`, `harness-runtime-host`, and `harness-capability-gateway` — the cross-service topology, not just the presence of spans.

Expected results:

| Check | Pass condition |
| --- | --- |
| `/health/ready` | `200` from all three services (each performs `select 1` against PostgreSQL) |
| `/v1/status` | `runtimeMode: Recorded` without a model key, `OpenRouter` with one |
| `demo.sh` | terminal status `completed`, `manual_review`, or `denied` — not `failed`, not a timeout |
| `demo-kyc-e2e.sh` | prints run ID, trace ID, case ID, final case state, and `ledger verification: ok` |
| `verify-trace.sh` | `harness.run` → `runtime.invoke` → `workflow.transition` → `capability.request` hierarchy present across services |

A `failed` run with no events usually means the dispatcher cannot reach the runtime host: check `RUNTIME_LOCAL_ENDPOINT` resolves and that both apps share `RUNTIME_HOST_AUTH_TOKEN`.

### 10.4 Close the operator window

Do this immediately after the smoke test — it is the only step that ever exposed a business API.

```bash
for app in "$APP_CONTROL_API" "$APP_GATEWAY" "$APP_CASE_API" "$APP_JAEGER"; do
  az containerapp ingress access-restriction remove -g "$RG" -n "$app" --rule-name "operator-smoke"
  az containerapp ingress update -g "$RG" -n "$app" --type internal
done

az containerapp list -g "$RG" \
  --query "[].{name:name, external:properties.configuration.ingress.external}" -o table
# Only the control UI (and Jaeger, if you chose Option B) may show true.
```

### 10.5 Verify through the UI

Sign in at `https://${UI_FQDN}` and confirm:

- **Runs** lists the runs created by the demo scripts, each with its plan digest and trace ID.
- **Cases** shows the tenant-scoped KYC aggregate with categorized evidence and the digest-chained activity ledger.
- **Gateway** reports the capability catalog and the configured model mode.
- **Author** loads a domain source, validates it, and compiles it to a content-addressed plan snapshot.

---

## Part 11 — Operate the stamp

### 11.1 Logs

```bash
# Live tail for one app.
az containerapp logs show -g "$RG" -n "$APP_DISPATCHER" --follow --tail 50 --type console

# Across the stamp, from Log Analytics.
az monitor log-analytics query -w "$LAW_CUSTOMER_ID" --analytics-query "
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(30m)
| project TimeGenerated, ContainerAppName_s, Log_s
| order by TimeGenerated desc
| take 200" -o table
```

### 11.2 Roll out a new release

```bash
export RELEASE_TAG="$(git rev-parse --short HEAD)"
az acr build --registry "$ACR" --platform linux/amd64 --image "ehf/services:${RELEASE_TAG}" --file Dockerfile .
az acr build --registry "$ACR" --platform linux/amd64 --image "ehf/control-ui:${RELEASE_TAG}" --file Dockerfile.ui .

export SERVICES_DIGEST="$(az acr repository show -n "$ACR" --image "ehf/services:${RELEASE_TAG}" --query digest -o tsv)"
export UI_DIGEST="$(az acr repository show -n "$ACR" --image "ehf/control-ui:${RELEASE_TAG}" --query digest -o tsv)"
export SERVICES_IMAGE="${ACR_LOGIN_SERVER}/ehf/services@${SERVICES_DIGEST}"
export UI_IMAGE="${ACR_LOGIN_SERVER}/ehf/control-ui@${UI_DIGEST}"

# Schema first, if the release changes migrations.
az containerapp job update -g "$RG" -n "$JOB_MIGRATE" --image "$SERVICES_IMAGE"
az containerapp job start -g "$RG" -n "$JOB_MIGRATE"

# Then each service.
for app in "$APP_GATEWAY" "$APP_CASE_API" "$APP_CONTROL_API" "$APP_RUNTIME_HOST" "$APP_DISPATCHER"; do
  az containerapp update -g "$RG" -n "$app" --image "$SERVICES_IMAGE"
done
az containerapp update -g "$RG" -n "$APP_UI" --image "$UI_IMAGE"
```

### 11.3 Roll back

Revisions are immutable; reactivate the previous one rather than rebuilding:

```bash
az containerapp revision list -g "$RG" -n "$APP_CONTROL_API" \
  --query "[].{name:name, active:properties.active, created:properties.createdTime, image:properties.template.containers[0].image}" -o table
az containerapp revision activate -g "$RG" -n "$APP_CONTROL_API" --revision "<previous-revision-name>"
```

Database migrations are not rolled back by this. Treat a schema change as forward-only for the POC.

### 11.4 Record the release manifest

The migration plan asks for a promotion unit per release. Generate it from the live stamp so it reflects what is actually running:

```bash
cat > "release-${RELEASE_TAG}.json" <<JSON
{
  "sourceRevision": "${SOURCE_REVISION}",
  "resourceGroup": "${RG}",
  "serviceImages": {
    "control-api": "${SERVICES_IMAGE}",
    "case-api": "${SERVICES_IMAGE}",
    "capability-gateway": "${SERVICES_IMAGE}",
    "runtime-host": "${SERVICES_IMAGE}",
    "runtime-dispatcher": "${SERVICES_IMAGE}",
    "control-ui": "${UI_IMAGE}"
  },
  "runtimeProvider": "local_http",
  "foundryAgent": null,
  "migrationJob": "${JOB_MIGRATE}",
  "entraAppId": "${ENTRA_APP_ID}"
}
JSON
jq . "release-${RELEASE_TAG}.json"
```

Promote this file between environments. Rebuilding for another environment produces a different artifact and is not promotion.

### 11.5 Tear the stamp down

Deleting the resource group removes every Azure resource created by this runbook:

```bash
az group delete --name "$RG" --yes --no-wait
```

The Entra objects are directory-scoped and survive that, so remove them explicitly:

```bash
az ad app delete --id "$ENTRA_APP_ID"
```

Key Vault has purge protection enabled, so the vault name stays reserved for the retention period (7 days as configured). Choose a new suffix if you redeploy sooner.

---

## Part 12 — Optional: switch execution to a Foundry Hosted Agent

> **Gate.** This path is documented, not runnable from the current repository. `README.md` states that the Azure Hosted Agent "still needs the documented Invocations-protocol wrapper and deployment/promotion steps." `packages/runtime-provider` already implements `AzureFoundryRuntimeProvider` (Entra token, `https://ai.azure.com/.default`, immutable agent name/version, execution-profile digest), so the dispatcher side is ready; the agent-side container contract is `AZ-011`, and removing the runtime host's database credential is `AZ-010`. Complete both before running this part.

Once those land:

1. Create the Foundry project and record its endpoint.

   ```bash
   export FOUNDRY_PROJECT_ENDPOINT="https://<account>.services.ai.azure.com/api/projects/<project>"
   ```

2. Build the runtime-host image as the hosted-agent wrapper and push it by digest to `$ACR`.
3. Create an immutable agent version in the Foundry project from that digest, then poll until it reports active.
4. Grant the dispatcher identity only the Foundry invocation role on the project:

   ```bash
   az role assignment create \
     --assignee-object-id "$(mi_principal runtime-dispatcher)" --assignee-principal-type ServicePrincipal \
     --role "<least-privilege Foundry invocation role>" \
     --scope "<foundry-project-resource-id>"
   ```

5. Point the dispatcher at the agent. `AZURE_CLIENT_ID` must be the dispatcher's user-assigned identity so `DefaultAzureCredential` selects it:

   ```bash
   az containerapp update -g "$RG" -n "$APP_DISPATCHER" --set-env-vars \
     "RUNTIME_PROVIDER=azure_foundry" \
     "FOUNDRY_AGENT_INVOCATION_ENDPOINT=<resolved-invocation-endpoint>" \
     "FOUNDRY_AGENT_NAME=ehf-runtime" \
     "FOUNDRY_AGENT_VERSION=<immutable-version>" \
     "FOUNDRY_TOKEN_SCOPE=https://ai.azure.com/.default" \
     "AZURE_CLIENT_ID=${MI_DISPATCHER_CLIENT_ID}"

   az containerapp update -g "$RG" -n "$APP_UI" --set-env-vars \
     "RUNTIME_PROVIDER=azure_foundry" \
     "FOUNDRY_AGENT_NAME=ehf-runtime" \
     "FOUNDRY_AGENT_VERSION=<immutable-version>"
   ```

6. Re-run the provider conformance set before claiming parity: invoke, duplicate invocation, timeout, cancellation, stale fencing epoch, gateway denial, and trace propagation. The same compiled plan must succeed under both `local_http` and `azure_foundry`.
7. Keep `ca-hf-runtime-host` deployed until the Foundry path passes; reverting is a single `RUNTIME_PROVIDER` change back to `local_http`.

Grant the Foundry-created agent identity only capability-gateway access. It gets no PostgreSQL, Key Vault, or direct model role.

---

## Part 13 — Gap register for this stamp

What a reviewer may be told this deployment proves:

- the full harness stack runs on Azure managed services in an isolated resource group;
- images are immutable and digest-pinned, built in ACR, pulled with per-service managed identities and no registry credential;
- every business service is private to the Container Apps environment; only the control surface is public;
- the control surface is behind Microsoft Entra sign-in with assigned app roles;
- platform secrets live in Key Vault and are resolved by per-service identity at revision start, never passed in a template;
- the database is VNet-injected with private DNS and no public endpoint;
- the compiled plan → admission → dispatch → execution → capability gateway → canonical case commit path works end to end, with traces correlated across services.

What it does **not** prove, and must not be claimed:

| Claim to avoid | Why | Closes with |
| --- | --- | --- |
| "Per-user authorization is enforced" | `x-actor-id` still defaults to `local-author`; app roles are not read by the services | `AZ-002` |
| "Tenant isolation is enforced" | `x-tenant-id` and `CASE_UI_TENANT_ID` are configuration, not verified claims | `AZ-002` |
| "Passwordless database access" | Services authenticate with an administrator password from Key Vault; Entra-only auth is off | `AZ-005` |
| "Per-identity database privileges" | All services share one database principal | `AZ-005` |
| "Hardware-backed execution signing" | Execution envelopes use a shared HS256 secret | `AZ-006` |
| "The runtime holds no data credentials" | The runtime host still needs `RUNTIME_CHECKPOINT_DATABASE_URL` | `AZ-010` |
| "Execution runs in Foundry" | `RUNTIME_PROVIDER=local_http`; the hosted-agent wrapper is unwritten | `AZ-011` |
| "Azure-native observability" | Harness spans go to an in-memory Jaeger container; App Insights carries platform telemetry only | `AZ-007` |
| "Production-ready" | See section 14 of the migration plan: DR, key rotation, egress control, pen test, WORM retention, quota validation | — |

---

## Appendix A — Resource inventory

Everything created in the resource group, after a complete run:

| Resource | Name pattern | Purpose |
| --- | --- | --- |
| Resource group | `rg-hf-poc-eastus2-01` | Stamp boundary; delete to remove everything |
| Virtual network | `vnet-hf-poc-…` | `snet-apps` (/23, delegated to `Microsoft.App/environments`), `snet-postgres` (/26) |
| Private DNS zone | `<pg>.private.postgres.database.azure.com` | Database name resolution inside the VNet |
| Container registry | `cr hf poc …` | `ehf/services`, `ehf/control-ui` |
| Log Analytics workspace | `log-hf-poc-…` | Container logs |
| Application Insights | `appi-hf-poc-…` | Platform telemetry from the managed OTel agent |
| Key Vault | `kv-hf-poc-…` | `database-url`, `execution-envelope-secret`, `runtime-host-token`, `pg-admin-password`, `entra-client-secret`, optional `openrouter-api-key` |
| PostgreSQL Flexible Server | `psql-hf-poc-…` | `harness_control`, `harness_runtime`, `case_core`, `case_ledger`, `evidence` |
| Container Apps environment | `cae-hf-poc-…` | Workload profiles, VNet-integrated, peer-to-peer encryption |
| Managed identities (7–8) | `id-hf-<service>-poc` | One per workload, plus optional `id-hf-deploy-poc` |
| Container apps (7) | `ca-hf-*` | 6 workloads + Jaeger |
| Container Apps job | `job-hf-migrate` | Schema migrations |

Outside the resource group: one Entra app registration (`app-hf-control-surface-poc`) with seven app roles, its service principal, and one client secret.

## Appendix B — Adding HTTP health probes

`az containerapp create` does not expose probes. Apply them per app with YAML once the stack is up — the services all serve `/health/live` and `/health/ready`, and `/health/ready` checks the database.

```bash
az containerapp show -g "$RG" -n "$APP_CONTROL_API" -o yaml > /tmp/control-api.yaml
```

Add to `properties.template.containers[0]`:

```yaml
        probes:
          - type: Liveness
            httpGet: { path: /health/live, port: 4100 }
            initialDelaySeconds: 15
            periodSeconds: 30
          - type: Readiness
            httpGet: { path: /health/ready, port: 4100 }
            initialDelaySeconds: 10
            periodSeconds: 10
            failureThreshold: 6
```

```bash
az containerapp update -g "$RG" -n "$APP_CONTROL_API" --yaml /tmp/control-api.yaml
```

Ports per app: control-api `4100`, capability-gateway `4101`, case-api `4102`, runtime-host `8088`, control-ui `4200`. The dispatcher has no HTTP surface and takes no probes.

## Appendix C — Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Revision fails with `ImagePullBackOff` / unauthorized | `AcrPull` missing or not yet propagated for that identity | Re-check Part 3; role assignments can take several minutes |
| App exits with `runtime.config_missing:<NAME>` | Environment variable absent | Compare against the app's block in Part 8; the error names the variable |
| `runtime.checkpoint_database_url_missing` | Runtime host deployed without the DB secret | Step 8.5 |
| `runtime_host.auth_token_missing` | Runtime host or dispatcher lacks the shared token | Steps 8.5 and 8.6; both must reference the same Key Vault secret |
| Revision starts, `/health/ready` returns 500 | Database unreachable or TLS rejected | Confirm `?sslmode=require` in `database-url` and that the private DNS zone is linked to the VNet |
| Key Vault reference fails at revision start | `Key Vault Secrets User` missing, or `identityref` omitted from the secret definition | Part 3; every `keyvaultref` needs a matching `identityref` |
| Runs stay `queued` forever | Dispatcher scaled to zero or crashed | `--min-replicas 1` (step 8.6); check its logs |
| Runs go `failed` with no node events | Dispatcher cannot reach the runtime host | Verify `RUNTIME_LOCAL_ENDPOINT` and the shared token |
| UI loads but panels are empty | Internal URLs wrong | Re-derive them from `CAE_DOMAIN` (step 6.3) and update the UI app |
| Trace links 404 in the browser | Jaeger is internal | Step 9.4 Option B, or leave links unused |
| Sign-in loop | Redirect URI mismatch | Step 9.2 must use the live `UI_FQDN` |
| `az acr build` fails on lockfile | Uncommitted `pnpm-lock.yaml` change | Commit it; the build runs `--frozen-lockfile` |

## Appendix D — Cost and scale notes

Approximate monthly cost for the POC profile, one region, minimum replicas as configured above: PostgreSQL `Standard_B2s` burstable with 32 GB is the largest single line, followed by seven always-on Container Apps replicas at 1 vCPU / 2 GiB, then ACR Standard, Log Analytics ingestion, and Key Vault operations. Validate against the current pricing calculator for your region before quoting a figure — do not repeat an estimate from this document as if it were a quote.

To reduce cost between demos, scale the stamp down without deleting it:

```bash
for app in "$APP_GATEWAY" "$APP_CASE_API" "$APP_CONTROL_API" "$APP_RUNTIME_HOST" "$APP_UI" "$APP_JAEGER"; do
  az containerapp update -g "$RG" -n "$app" --min-replicas 0
done
az containerapp update -g "$RG" -n "$APP_DISPATCHER" --min-replicas 0
az postgres flexible-server stop -g "$RG" -n "$PG"
```

Restore with `--min-replicas 1` and `az postgres flexible-server start`. The dispatcher must be back at 1 before any run will progress: nothing wakes a scaled-to-zero poller.
