#!/usr/bin/env bash
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib/identity.sh"

control_api="${CONTROL_API_URL:-http://localhost:4100}"
gateway_api="${GATEWAY_URL:-http://localhost:4101}"
case_api="${CASE_API_URL:-http://localhost:4102}"
tenant_id="${CASE_DEMO_TENANT_ID:-tenant_demo}"
customer_name="${1:-Ada Lovelace}"
customer_country="${2:-US}"
demo_id="$(date +%s)-$$"
policy_digest="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
permission_digest="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

system_actor='{"type":"SYSTEM","principalId":"kyc-poc-orchestrator","roles":[]}'
qa_actor='{"type":"SYSTEM","principalId":"kyc-poc-independent-qa","roles":[]}'
analyst_actor='{"type":"HUMAN","principalId":"poc-analyst","roles":["KYC.Analyst"]}'
senior_actor='{"type":"HUMAN","principalId":"poc-senior-reviewer","roles":["KYC.SeniorReviewer"]}'

admitted="$(curl -fsS "${edge_auth[@]}" -X POST "${control_api}/v1/plans" \
  -H 'content-type: application/json' --data-binary @artifacts/plans/kyc.plan.json)"
plan_digest="$(jq -r '.plan.planDigest' <<<"${admitted}")"

created="$(curl -fsS "${edge_auth[@]}" -X POST "${case_api}/v1/cases" \
  -H 'content-type: application/json' -H "idempotency-key: kyc-e2e:${demo_id}:case" \
  --data-binary "$(jq -n --arg tenantId "${tenant_id}" --arg externalRef "KYC-POC-${demo_id}" \
    --arg policy "${policy_digest}" --arg plan "${plan_digest}" --argjson actor "${system_actor}" \
    '{tenantId:$tenantId,externalRef:$externalRef,policySnapshotDigest:$policy,harnessPlanDigest:$plan,actor:$actor}')")"
case_id="$(jq -r '.case.caseId' <<<"${created}")"

command() {
  local actor_json="$1" command_type="$2" suffix="$3" payload="$4" sequence body
  sequence="$(curl -fsS "${edge_auth[@]}" -H "x-tenant-id: ${tenant_id}" \
    "${case_api}/v1/cases/${case_id}" | jq -r '.case.caseSequence')"
  body="$(jq -n --arg commandId "cmd_${demo_id}_${suffix}" --arg commandType "${command_type}" \
    --arg commandVersion "kyc.command.${suffix}.v1" --arg tenantId "${tenant_id}" --arg caseId "${case_id}" \
    --arg plan "${plan_digest}" --arg permission "${permission_digest}" --arg policy "${policy_digest}" \
    --arg idempotencyKey "${tenant_id}:${case_id}:${demo_id}:${suffix}" --argjson actor "${actor_json}" \
    --argjson payload "${payload}" --argjson sequence "${sequence}" \
    '{commandId:$commandId,commandType:$commandType,commandVersion:$commandVersion,tenantId:$tenantId,caseId:$caseId,actor:$actor,authority:{planDigest:$plan,permissionEnvelopeDigest:$permission,policySnapshotDigest:$policy},payload:$payload,preconditions:{caseSequence:$sequence},idempotencyKey:$idempotencyKey}')"
  curl -fsS "${edge_auth[@]}" -X POST "${case_api}/v1/cases/${case_id}/commands" \
    -H 'content-type: application/json' --data-binary "${body}"
}

subject="$(command "${system_actor}" AddSubject add_subject \
  "$(jq -n --arg name "${customer_name}" --arg country "${customer_country}" \
    '{subjectType:"individual",displayName:$name,attributes:{country:$country}}')")"
subject_id="$(jq -r '.createdIdentifiers.subjectId' <<<"${subject}")"
run_input="$(jq -n --arg tenantId "${tenant_id}" --arg caseId "${case_id}" --arg subjectId "${subject_id}" \
  --arg name "${customer_name}" --arg country "${customer_country}" --arg policy "${policy_digest}" \
  '{tenantId:$tenantId,caseId:$caseId,subjectId:$subjectId,name:$name,country:$country,customerType:"individual",riskTier:"standard",policySnapshotDigest:$policy,linkedEvidenceRefs:[]}')"
run_created="$(curl -fsS "${edge_auth[@]}" -X POST "${control_api}/v1/runs" \
  -H 'content-type: application/json' -H "idempotency-key: kyc-e2e:${demo_id}:run" \
  --data-binary "$(jq -n --arg planDigest "${plan_digest}" --argjson input "${run_input}" '{planDigest:$planDigest,input:$input}')")"
run_id="$(jq -r '.run.runId' <<<"${run_created}")"

run_record=''
for _ in $(seq 1 120); do
  run_record="$(curl -fsS "${edge_auth[@]}" "${control_api}/v1/runs/${run_id}")"
  run_status="$(jq -r '.status' <<<"${run_record}")"
  [[ "${run_status}" =~ ^(completed|manual_review|denied|failed)$ ]] && break
  sleep 1
done
if [[ "$(jq -r '.status' <<<"${run_record}")" != "completed" ]]; then
  jq . <<<"${run_record}" >&2
  echo "KYC harness did not complete." >&2
  exit 1
fi

case_view="$(curl -fsS "${edge_auth[@]}" -H "x-tenant-id: ${tenant_id}" "${case_api}/v1/cases/${case_id}")"
recommendation_id="$(jq -r '.decisionRecommendations[-1].recommendation_id' <<<"${case_view}")"
evidence_id="$(jq -r '.decisionRecommendations[-1].evidence_refs[0]' <<<"${case_view}")"
trace_id="$(jq -r '.traceId' <<<"${run_record}")"

command "${system_actor}" LinkExecution link_execution \
  "$(jq -n --arg runId "${run_id}" --arg planDigest "${plan_digest}" --arg traceId "${trace_id}" \
    '{runId:$runId,planDigest:$planDigest,traceId:$traceId,purpose:"KYC_POLICY_INVESTIGATION_AND_RECOMMENDATION"}')" >/dev/null
qa="$(command "${qa_actor}" RecordQAResult qa_result \
  "$(jq -n --arg recommendationRef "${recommendation_id}" --arg evidenceId "${evidence_id}" \
    '{recommendationRef:$recommendationRef,outcome:"PASS",rationale:"Independent QA verified the recommendation and its evidence lineage.",evidenceRefs:[$evidenceId]}')")"
qa_id="$(jq -r '.createdIdentifiers.qaResultId' <<<"${qa}")"
review="$(command "${analyst_actor}" RecordReview analyst_review \
  "$(jq -n --arg objectRef "${recommendation_id}" --arg evidenceId "${evidence_id}" \
    '{reviewType:"KYC_DISPOSITION",outcome:"APPROVE",objectRef:$objectRef,rationale:"Analyst reviewed the evidence and accepted the bounded pilot recommendation.",viewedEvidenceRefs:[$evidenceId]}')")"
review_id="$(jq -r '.createdIdentifiers.reviewId' <<<"${review}")"
gate="$(command "${system_actor}" RecordGateResult final_gate \
  "$(jq -n --arg recommendationRef "${recommendation_id}" --arg qaRef "${qa_id}" --arg reviewRef "${review_id}" \
    '{recommendationRef:$recommendationRef,decision:"AUTHORIZED",ruleResults:[{rule:"runtime_completed",passed:true},{rule:"qa_passed",passed:true,ref:$qaRef},{rule:"human_review_present",passed:true,ref:$reviewRef}]}')")"
gate_id="$(jq -r '.createdIdentifiers.gateResultId' <<<"${gate}")"
command "${senior_actor}" FinalizeDisposition finalize \
  "$(jq -n --arg recommendationRef "${recommendation_id}" --arg gateResultRef "${gate_id}" \
    --arg reviewRef "${review_id}" --arg evidenceId "${evidence_id}" \
    '{outcome:"APPROVED",recommendationRef:$recommendationRef,gateResultRef:$gateResultRef,reviewRef:$reviewRef,rationale:"Senior reviewer authorized the pilot disposition after runtime, QA, and human-review controls.",evidenceRefs:[$evidenceId],followUpObligations:["production_policy_configuration_required"]}')" >/dev/null

case_view="$(curl -fsS "${edge_auth[@]}" -H "x-tenant-id: ${tenant_id}" "${case_api}/v1/cases/${case_id}")"
ledger="$(curl -fsS "${edge_auth[@]}" -X POST -H "x-tenant-id: ${tenant_id}" "${case_api}/v1/cases/${case_id}/ledger:verify")"
runtime_mode="$(curl -fsS "${edge_auth[@]}" "${gateway_api}/v1/status" | jq -r '.runtimeMode')"
jq -n --arg caseId "${case_id}" --arg runId "${run_id}" --arg runtimeMode "${runtime_mode}" \
  --arg traceId "${trace_id}" --arg status "$(jq -r '.case.status' <<<"${case_view}")" \
  --arg recommendation "$(jq -r '.output.outcome' <<<"${run_record}")" \
  --argjson caseSequence "$(jq -r '.case.caseSequence' <<<"${case_view}")" \
  --argjson checkedEvents "$(jq -r '.checkedEvents' <<<"${ledger}")" --argjson ledgerValid "$(jq -r '.valid' <<<"${ledger}")" \
  '{caseId:$caseId,runId:$runId,runtimeMode:$runtimeMode,traceId:$traceId,status:$status,recommendation:$recommendation,caseSequence:$caseSequence,ledgerValid:$ledgerValid,checkedEvents:$checkedEvents}'
