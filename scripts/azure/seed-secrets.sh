#!/usr/bin/env bash
# Seed the platform secrets a POC stamp needs, into Key Vault, idempotently.
#
# Run after the foundation deployment (stage 1) and before the database
# deployment (stage 3). Existing secrets are left untouched, so re-running this
# never rotates a credential the running stack depends on.
#
#   usage: scripts/azure/seed-secrets.sh <key-vault-name>
#
# Secret values are generated here and written straight to the vault. None is
# printed, returned, or passed to a deployment.
set -euo pipefail

vault="${1:?usage: seed-secrets.sh <key-vault-name>}"

# Generate a value only when the secret is absent. A disabled or soft-deleted
# secret counts as absent and az will surface that on set.
ensure_secret() {
  local name="$1" generator="$2"
  if az keyvault secret show --vault-name "$vault" --name "$name" --query id -o tsv >/dev/null 2>&1; then
    printf '%-28s already present, left unchanged\n' "$name"
    return 0
  fi
  local value
  value="$("$generator")"
  az keyvault secret set --vault-name "$vault" --name "$name" --value "$value" -o none
  printf '%-28s created\n' "$name"
}

# 32 URL-safe characters: long enough for a database password, short enough for
# the connection-string form PostgreSQL accepts without escaping.
generate_password() {
  openssl rand -base64 33 | tr -d '/+=' | cut -c1-32
}

# The envelope secret and runtime token are compared verbatim, never parsed, so
# full base64 is fine and gives more entropy per character.
generate_token() {
  openssl rand -base64 48
}

ensure_secret "pg-admin-password" generate_password
ensure_secret "execution-envelope-secret" generate_token
ensure_secret "runtime-host-token" generate_token

# Workload credentials for the control plane. The services refuse to start with
# these present when PLATFORM_MODE=azure, because managed-identity Entra tokens
# are meant to replace them; this stamp runs in local mode, so they are seeded.
ensure_secret "edge-service-token" generate_token
ensure_secret "runtime-service-token" generate_token
ensure_secret "runtime-grant-secret" generate_token

echo
echo "Secrets in ${vault}:"
az keyvault secret list --vault-name "$vault" --query "[].name" -o tsv | sed 's/^/  /'
echo
echo "Not seeded here, because they are not generated:"
echo "  database-url        set by scripts/azure/set-database-url.sh once the server exists"
echo "  entra-client-secret from the app registration (runbook part 1.3)"
echo "  openrouter-api-key  optional; omit to run the deterministic recorded adapter"
