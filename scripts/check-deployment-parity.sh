#!/usr/bin/env bash
# Assert that the Azure templates still configure what the services actually read.
#
# infra/apps.bicep encodes each service's environment. compose.yaml encodes the
# same thing for the local stack, and the services themselves are the reason both
# exist: they assert startup invariants and fail closed on a missing variable. So
# when a service gains a variable locally and the templates do not follow, the
# Azure deployment starts and then misbehaves -- which is exactly the failure this
# catches, before anything is deployed rather than after.
#
#   usage: scripts/check-deployment-parity.sh
#
# Exits non-zero, naming every drifted service, when a variable compose sets on a
# service does not reach that service in apps.bicep, or when a module would emit
# the same variable twice (which Container Apps rejects).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bicep="${repo_root}/infra/apps.bicep"

# docker compose resolves the YAML anchors and ${VAR:-default} substitutions, so
# this compares what a service is actually given rather than what is typed.
compose_json="$(cd "$repo_root" && docker compose config --format json)"

# compose service -> apps.bicep module.
service_modules=(
  "control-api:controlApi"
  "case-api:caseApi"
  "capability-gateway:gateway"
  "runtime-host-local:runtimeHost"
  "runtime-dispatcher:dispatcher"
  "control-ui:controlUi"
)

# Print the source lines of a block, from the line matching $1 to the first line
# that is exactly $2. Used for both module bodies and shared env arrays.
block() {
  awk -v start="$1" -v terminator="$2" '
    index($0, start) { inside = 1 }
    inside { print }
    inside && $0 == terminator { exit }
  ' "$bicep"
}

env_names() {
  grep -oE "name: '[A-Z][A-Z0-9_]+'" | sed -E "s/name: '(.*)'/\1/" || true
}

# Variables a module receives directly, plus those from every shared array it
# concatenates (telemetryEnv, caseStoreEnv, platformEnv, workloadTokenEnv).
bicep_env_for() {
  local module="$1" body direct shared
  body="$(block "module ${module} 'modules/container-app.bicep'" "}")"
  direct="$(printf '%s' "$body" | env_names)"
  shared=""
  for array in telemetryEnv caseStoreEnv platformEnv workloadTokenEnv; do
    if grep -qE "\b${array}\b" <<<"$body"; then
      shared+="$(block "var ${array} = [" "]" | env_names)"$'\n'
    fi
  done
  printf '%s\n%s\n' "$direct" "$shared" | sed '/^$/d' | sort -u
}

duplicates_for() {
  block "module $1 'modules/container-app.bicep'" "}" | env_names | sort | uniq -d
}

# Services this check deliberately does not map to a container-app module:
# postgres and jaeger are infrastructure, and migrate is a Container Apps job.
# Anything else new in compose is a service the templates do not deploy at all,
# which no per-service comparison below would notice.
unmapped=""
while read -r service; do
  case "$service" in
    postgres | jaeger | migrate) continue ;;
  esac
  for pair in "${service_modules[@]}"; do
    [[ "${pair%%:*}" == "$service" ]] && continue 2
  done
  unmapped+="${service} "
done < <(jq -r '.services | keys[]' <<<"$compose_json")

failures=0
if [[ -n "$unmapped" ]]; then
  failures=$((failures + 1))
  printf 'DRIFT  compose defines services the Azure templates do not deploy: %s\n' "${unmapped% }"
fi

for pair in "${service_modules[@]}"; do
  service="${pair%%:*}"
  module="${pair##*:}"

  compose_env="$(jq -r --arg s "$service" '.services[$s].environment // {} | keys[]' <<<"$compose_json" | sort -u)"
  bicep_env="$(bicep_env_for "$module")"

  missing="$(comm -23 <(printf '%s\n' "$compose_env") <(printf '%s\n' "$bicep_env") | tr '\n' ' ' | sed 's/ $//')"
  duplicated="$(duplicates_for "$module" | tr '\n' ' ' | sed 's/ $//')"

  if [[ -n "$missing" || -n "$duplicated" ]]; then
    failures=$((failures + 1))
    printf 'DRIFT  %-20s\n' "$service"
    [[ -n "$missing" ]] && printf '         missing from apps.bicep: %s\n' "$missing"
    [[ -n "$duplicated" ]] && printf '         emitted twice: %s\n' "$duplicated"
  else
    printf 'ok     %-20s %s variables\n' "$service" "$(wc -l <<<"$bicep_env" | tr -d ' ')"
  fi
done

echo
if (( failures > 0 )); then
  cat >&2 <<'MESSAGE'
The Azure templates no longer match the service contracts.

Add each missing variable to that service's module in infra/apps.bicep -- to the
module itself, or to the shared array it already concatenates if every service
takes it -- and to the matching block in docs/deploy/azure-deployment-runbook.md
part 8, which documents the same deployment by hand.
MESSAGE
  exit 1
fi

echo "infra/apps.bicep matches compose.yaml for every service."
