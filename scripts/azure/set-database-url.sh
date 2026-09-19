#!/usr/bin/env bash
# Compose the application connection string from the deployed server and the
# administrator password already in Key Vault, then store it as its own secret.
#
# Run after the database deployment (stage 3) and before the workload deployment
# (stage 4). Re-running is safe: the value is deterministic given the same
# server and password.
#
#   usage: scripts/azure/set-database-url.sh <key-vault-name> <server-fqdn> [database] [login]
#
# sslmode=require is not optional. Flexible Server rejects unencrypted
# connections, and node-postgres verifies the server certificate against the
# system CA bundle when the parameter is present.
set -euo pipefail

vault="${1:?usage: set-database-url.sh <key-vault-name> <server-fqdn> [database] [login]}"
fqdn="${2:?usage: set-database-url.sh <key-vault-name> <server-fqdn> [database] [login]}"
database="${3:-ehf}"
login="${4:-ehfadmin}"

password="$(az keyvault secret show --vault-name "$vault" --name "pg-admin-password" --query value -o tsv)"
if [[ -z "$password" ]]; then
  echo "pg-admin-password is missing from ${vault}; run seed-secrets.sh first" >&2
  exit 1
fi

# URL-encode the password so a generated character can never break the URL.
encoded_password="$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$password")"
url="postgresql://${login}:${encoded_password}@${fqdn}:5432/${database}?sslmode=require"

az keyvault secret set --vault-name "$vault" --name "database-url" --value "$url" -o none
echo "database-url set for ${login}@${fqdn}/${database} (value not printed)"
