#!/usr/bin/env bash
set -euo pipefail

case_api_url="${CASE_API_URL:-http://localhost:4102}"
control_api_url="${CONTROL_API_URL:-http://localhost:4100}"
tenant_id="${CASE_DEMO_TENANT_ID:-tenant_demo}"
demo_id="${CASE_DEMO_ID:-$(date +%s)-$$}"
policy_digest="${CASE_DEMO_POLICY_DIGEST:-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}"
permission_digest="${CASE_DEMO_PERMISSION_DIGEST:-cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc}"
plan_digest="$(curl -fsS "${control_api_url}/v1/plans" | jq -r '.plans[] | select(.metadata.domain == "kyc") | .planDigest' | head -n 1)"

if [[ -z "${plan_digest}" ]]; then
  echo "No admitted KYC plan found. Run make demo first." >&2
  exit 1
fi

actor='{"type":"HUMAN","principalId":"poc-analyst","roles":["KYC.Analyst"]}'
create_body="$(jq -n \
  --arg tenantId "${tenant_id}" \
  --arg policySnapshotDigest "${policy_digest}" \
  --arg harnessPlanDigest "${plan_digest}" \
  --argjson actor "${actor}" \
  '{tenantId:$tenantId, policySnapshotDigest:$policySnapshotDigest, harnessPlanDigest:$harnessPlanDigest, actor:$actor}')"
created="$(curl -fsS -X POST "${case_api_url}/v1/cases" \
  -H 'content-type: application/json' \
  -H "idempotency-key: demo:kyc:case:${demo_id}" \
  --data-binary "${create_body}")"
case_id="$(jq -r '.case.caseId' <<<"${created}")"

command() {
  local command_type="$1"
  local command_suffix="$2"
  local payload="$3"
  local body
  local sequence
  sequence="$(curl -fsS "${case_api_url}/v1/cases/${case_id}" -H "x-tenant-id: ${tenant_id}" | jq -r '.case.caseSequence')"
  body="$(jq -n \
    --arg commandId "cmd_demo_${demo_id}_${command_suffix}" \
    --arg commandType "${command_type}" \
    --arg commandVersion "kyc.command.${command_suffix}.v1" \
    --arg tenantId "${tenant_id}" \
    --arg caseId "${case_id}" \
    --arg planDigest "${plan_digest}" \
    --arg permissionEnvelopeDigest "${permission_digest}" \
    --arg policySnapshotDigest "${policy_digest}" \
    --arg idempotencyKey "${tenant_id}:${case_id}:${demo_id}:${command_suffix}" \
    --argjson actor "${actor}" \
    --argjson payload "${payload}" \
    --argjson caseSequence "${sequence}" \
    '{commandId:$commandId,commandType:$commandType,commandVersion:$commandVersion,tenantId:$tenantId,caseId:$caseId,actor:$actor,authority:{planDigest:$planDigest,permissionEnvelopeDigest:$permissionEnvelopeDigest,policySnapshotDigest:$policySnapshotDigest},payload:$payload,preconditions:{caseSequence:$caseSequence},idempotencyKey:$idempotencyKey}')"
  local response
  response="$(curl -fsS -X POST "${case_api_url}/v1/cases/${case_id}/commands" -H 'content-type: application/json' --data-binary "${body}")"
  printf '%s' "${response}"
}

subject_result="$(command AddSubject add_subject '{"subjectType":"individual","displayName":"Demo Customer","attributes":{"country":"US"},"identifiers":[{"identifierType":"customer_reference","value":"DEMO-001","maskedValue":"***001","source":"demo"}]}')"
subject_id="$(jq -r '.createdIdentifiers.subjectId' <<<"${subject_result}")"

evidence_content="$(printf '%s' '{"provider":"recorded-sanctions","datasetVersion":"2026-09-17","matches":[]}' | base64 | tr -d '\n')"
evidence_body="$(jq -n \
  --arg tenantId "${tenant_id}" \
  --arg caseId "${case_id}" \
  --arg contentBase64 "${evidence_content}" \
  --arg subjectRef "${subject_id}" \
  --argjson createdBy "${actor}" \
  '{tenantId:$tenantId,caseId:$caseId,type:"screening_result",mediaType:"application/json",contentBase64:$contentBase64,source:{type:"TOOL",dataset:"sanctions-global",datasetVersion:"2026-09-17",capability:"screening.sanctions.search@3.2.0",retrievedAt:"2026-09-17T18:41:12.481Z"},subjectRefs:[$subjectRef],trust:{tier:"LICENSED_PROVIDER",instructionTrust:"UNTRUSTED_DATA"},createdBy:$createdBy}')"
evidence_result="$(curl -fsS -X POST "${case_api_url}/v1/evidence:register" -H 'content-type: application/json' -H "idempotency-key: ${tenant_id}:${case_id}:${demo_id}:screening-evidence" --data-binary "${evidence_body}")"
evidence_id="$(jq -r '.evidence.evidenceId' <<<"${evidence_result}")"

command LinkEvidence link_evidence "$(jq -n --arg evidenceId "${evidence_id}" '{evidenceId:$evidenceId,purpose:"KYC_SCREENING"}')" >/dev/null
claim_result="$(command ProposeClaim propose_claim "$(jq -n --arg subjectRef "${subject_id}" --arg evidenceId "${evidence_id}" '{subjectRef:$subjectRef,predicate:"sanctions_match_count",value:0,evidenceRefs:[$evidenceId],confidence:{value:1,method:"provider_result"}}')")"
claim_id="$(jq -r '.createdIdentifiers.claimId' <<<"${claim_result}")"
fact_result="$(command AcceptClaimAsFact accept_fact "$(jq -n --arg claimId "${claim_id}" --arg subjectRef "${subject_id}" '{claimRefs:[$claimId],subjectRef:$subjectRef,acceptancePolicyRef:"identity-fact-policy@1.0.0",purpose:"KYC_ONBOARDING"}')")"
fact_id="$(jq -r '.createdIdentifiers.factId' <<<"${fact_result}")"
command RecordScreeningFinding screening_finding "$(jq -n --arg subjectRef "${subject_id}" --arg evidenceId "${evidence_id}" --arg factId "${fact_id}" '{findingType:"sanctions_no_match",subjectRef:$subjectRef,confidence:{value:1,method:"deterministic"},evidenceRefs:[$evidenceId],factRefs:[$factId],reason:"Recorded provider result contained no sanctions matches."}')" >/dev/null
command TransitionCaseStatus transition_validating '{"toStatus":"VALIDATING","reason":"Validated intake is ready for screening."}' >/dev/null
command TransitionCaseStatus transition_screening '{"toStatus":"SCREENING","reason":"Identity validation complete."}' >/dev/null

case_view="$(curl -fsS "${case_api_url}/v1/cases/${case_id}" -H "x-tenant-id: ${tenant_id}")"
verification="$(curl -fsS -X POST "${case_api_url}/v1/cases/${case_id}/ledger:verify" -H "x-tenant-id: ${tenant_id}")"

jq -n \
  --arg caseId "${case_id}" \
  --arg status "$(jq -r '.case.status' <<<"${case_view}")" \
  --argjson caseSequence "$(jq -r '.case.caseSequence' <<<"${case_view}")" \
  --arg evidenceId "${evidence_id}" \
  --argjson ledgerValid "$(jq -r '.valid' <<<"${verification}")" \
  --argjson checkedEvents "$(jq -r '.checkedEvents' <<<"${verification}")" \
  '{caseId:$caseId,status:$status,caseSequence:$caseSequence,evidenceId:$evidenceId,ledgerValid:$ledgerValid,checkedEvents:$checkedEvents}'
