#!/usr/bin/env bash
# Post-deployment checks that are safe to run unattended from CI.
#
#   usage: scripts/azure/smoke.sh <resource-group> [name-prefix]
#
# This asserts the shape of the deployment: every app provisioned, every
# revision healthy, the dispatcher never scaled to zero, exactly one public app,
# and the control surface refusing anonymous access.
#
# It deliberately does not admit a plan or start a run. Those require reaching
# the private control API, which means opening an ingress window; the runbook
# does that interactively in part 10 and closes it immediately afterwards.
set -euo pipefail

rg="${1:?usage: smoke.sh <resource-group> [name-prefix]}"
prefix="${2:-hf}"
failures=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  PASS  %-46s %s\n' "$label" "$actual"
  else
    printf '  FAIL  %-46s expected %s, got %s\n' "$label" "$expected" "$actual"
    failures=$((failures + 1))
  fi
}

echo "Container apps in ${rg}"
for svc in control-api case-api capability-gateway runtime-host runtime-dispatcher control-ui jaeger; do
  app="ca-${prefix}-${svc}"
  state="$(az containerapp show -g "$rg" -n "$app" --query properties.provisioningState -o tsv 2>/dev/null || echo "Missing")"
  check "$app provisioned" "Succeeded" "$state"

  if [[ "$state" == "Succeeded" ]]; then
    health="$(az containerapp revision list -g "$rg" -n "$app" \
      --query "[?properties.active].properties.healthState | [0]" -o tsv 2>/dev/null || echo "Unknown")"
    check "$app active revision healthy" "Healthy" "$health"
  fi
done

echo
echo "Topology"
dispatcher_min="$(az containerapp show -g "$rg" -n "ca-${prefix}-runtime-dispatcher" \
  --query properties.template.scale.minReplicas -o tsv 2>/dev/null || echo "0")"
check "dispatcher never scales to zero" "1" "$dispatcher_min"

external_count="$(az containerapp list -g "$rg" \
  --query "length([?properties.configuration.ingress.external])" -o tsv 2>/dev/null || echo "0")"
check "exactly one public app" "1" "$external_count"

public_app="$(az containerapp list -g "$rg" \
  --query "[?properties.configuration.ingress.external].name | [0]" -o tsv 2>/dev/null || echo "none")"
check "the public app is the control surface" "ca-${prefix}-control-ui" "$public_app"

echo
echo "Migrations"
job_status="$(az containerapp job execution list -g "$rg" -n "job-${prefix}-migrate" \
  --query "[0].properties.status" -o tsv 2>/dev/null || echo "NeverRun")"
check "latest migration execution" "Succeeded" "$job_status"

echo
echo "Control surface"
fqdn="$(az containerapp show -g "$rg" -n "ca-${prefix}-control-ui" \
  --query properties.configuration.ingress.fqdn -o tsv 2>/dev/null || echo "")"
if [[ -n "$fqdn" ]]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "https://${fqdn}/" || echo "000")"
  # 302 means Entra sign-in is enforced. A 200 means anonymous users reach the
  # control surface, which is a finding, not a pass.
  check "anonymous access is redirected to sign-in" "302" "$code"
else
  echo "  FAIL  control surface has no FQDN"
  failures=$((failures + 1))
fi

echo
if [[ "$failures" -gt 0 ]]; then
  echo "${failures} check(s) failed"
  exit 1
fi
echo "All checks passed"
