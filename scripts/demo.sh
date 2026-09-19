#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/identity.sh"

api="${CONTROL_API_URL:-http://127.0.0.1:4100}"
plan="${1:-artifacts/plans/kyc.plan.json}"
if [[ $# -ge 2 ]]; then
  run_input="$2"
else
  run_input='{"name":"Ada Lovelace","country":"GB"}'
fi

admitted="$(curl --fail --silent --show-error "${edge_auth[@]}" -H 'content-type: application/json' --data-binary "@$plan" "$api/v1/plans")"
digest="$(printf '%s' "$admitted" | jq -r '.plan.planDigest')"
run="$(curl --fail --silent --show-error "${edge_auth[@]}" \
  -H 'content-type: application/json' \
  -H "idempotency-key: demo-$(date +%s)" \
  --data "{\"planDigest\":\"$digest\",\"input\":$run_input}" \
  "$api/v1/runs")"
run_id="$(printf '%s' "$run" | jq -r '.run.runId')"
printf 'run: %s\n' "$run_id"

for _ in $(seq 1 60); do
  current="$(curl --fail --silent --show-error "${edge_auth[@]}" "$api/v1/runs/$run_id")"
  status="$(printf '%s' "$current" | jq -r '.status')"
  if [[ "$status" =~ ^(completed|manual_review|denied|failed)$ ]]; then
    printf '%s\n' "$current" | jq
    curl --fail --silent --show-error "${edge_auth[@]}" "$api/v1/runs/$run_id/events" | jq
    exit 0
  fi
  sleep 1
done

echo "run did not finish in 60 seconds" >&2
exit 1
