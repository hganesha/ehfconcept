#!/usr/bin/env bash
set -euo pipefail

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
decision_actor='{"type":"AGENT","principalId":"decision-agent@poc-v1","executionId":"pending","roles":[]}'
qa_actor='{"type":"AGENT","principalId":"qa-agent@poc-v1","executionId":"pending","roles":[]}'
analyst_actor='{"type":"HUMAN","principalId":"poc-analyst","roles":["KYC.Analyst"]}'
senior_actor='{"type":"HUMAN","principalId":"poc-senior-reviewer","roles":["KYC.SeniorReviewer"]}'

plan_file="artifacts/plans/kyc.plan.json"
admitted="$(curl -fsS -X POST "${control_api}/v1/plans" -H 'content-type: application/json' --data-binary "@${plan_file}")"
plan_digest="$(jq -r '.plan.planDigest' <<<"${admitted}")"

run_input="$(jq -n --arg name "${customer_name}" --arg country "${customer_country}" '{name:$name,country:$country}')"
run_created="$(curl -fsS -X POST "${control_api}/v1/runs" \
  -H 'content-type: application/json' \
  -H "idempotency-key: kyc-e2e:${demo_id}" \
  --data-binary "$(jq -n --arg planDigest "${plan_digest}" --argjson input "${run_input}" '{planDigest:$planDigest,input:$input}')")"
run_id="$(jq -r '.run.runId' <<<"${run_created}")"

run_record=''
for _ in $(seq 1 90); do
  run_record="$(curl -fsS "${control_api}/v1/runs/${run_id}")"
  run_status="$(jq -r '.status' <<<"${run_record}")"
  if [[ "${run_status}" =~ ^(completed|manual_review|denied|failed)$ ]]; then break; fi
  sleep 1
done
if [[ "$(jq -r '.status' <<<"${run_record}")" != "completed" ]]; then
  jq . <<<"${run_record}" >&2
  echo "KYC harness did not complete." >&2
  exit 1
fi

runtime_mode="$(curl -fsS "${gateway_api}/v1/status" | jq -r '.runtimeMode')"
trace_id="$(jq -r '.traceId // ""' <<<"${run_record}")"
model_output="$(jq -c '.output' <<<"${run_record}")"
receipts="$(curl -fsS "${control_api}/v1/gateway/receipts?runId=${run_id}&limit=20")"
screening_output="$(jq -c '[.receipts[] | select(.capabilityId == "screening.sanctions.search")][0].result.output' <<<"${receipts}")"
sanctions_match="$(jq -r '.match // false' <<<"${screening_output}")"

create_body="$(jq -n \
  --arg tenantId "${tenant_id}" \
  --arg externalRef "KYC-POC-${demo_id}" \
  --arg policySnapshotDigest "${policy_digest}" \
  --arg harnessPlanDigest "${plan_digest}" \
  --argjson actor "${system_actor}" \
  '{tenantId:$tenantId,externalRef:$externalRef,policySnapshotDigest:$policySnapshotDigest,harnessPlanDigest:$harnessPlanDigest,actor:$actor}')"
case_created="$(curl -fsS -X POST "${case_api}/v1/cases" \
  -H 'content-type: application/json' \
  -H "idempotency-key: kyc-e2e:${demo_id}:case" \
  --data-binary "${create_body}")"
case_id="$(jq -r '.case.caseId' <<<"${case_created}")"

command() {
  local actor_json="$1"
  local command_type="$2"
  local command_suffix="$3"
  local payload="$4"
  local sequence body
  sequence="$(curl -fsS "${case_api}/v1/cases/${case_id}" -H "x-tenant-id: ${tenant_id}" | jq -r '.case.caseSequence')"
  body="$(jq -n \
    --arg commandId "cmd_${demo_id}_${command_suffix}" \
    --arg commandType "${command_type}" \
    --arg commandVersion "kyc.command.${command_suffix}.v1" \
    --arg tenantId "${tenant_id}" \
    --arg caseId "${case_id}" \
    --arg planDigest "${plan_digest}" \
    --arg permissionEnvelopeDigest "${permission_digest}" \
    --arg policySnapshotDigest "${policy_digest}" \
    --arg idempotencyKey "${tenant_id}:${case_id}:${demo_id}:${command_suffix}" \
    --argjson actor "${actor_json}" \
    --argjson payload "${payload}" \
    --argjson caseSequence "${sequence}" \
    '{commandId:$commandId,commandType:$commandType,commandVersion:$commandVersion,tenantId:$tenantId,caseId:$caseId,actor:$actor,authority:{planDigest:$planDigest,permissionEnvelopeDigest:$permissionEnvelopeDigest,policySnapshotDigest:$policySnapshotDigest},payload:$payload,preconditions:{caseSequence:$caseSequence},idempotencyKey:$idempotencyKey}')"
  curl -fsS -X POST "${case_api}/v1/cases/${case_id}/commands" -H 'content-type: application/json' --data-binary "${body}"
}

register_evidence() {
  local evidence_suffix="$1"
  local evidence_type="$2"
  local source_json="$3"
  local trust_json="$4"
  local subject_id="$5"
  local content_json="$6"
  local encoded body
  encoded="$(printf '%s' "${content_json}" | base64 | tr -d '\n')"
  body="$(jq -n \
    --arg tenantId "${tenant_id}" \
    --arg caseId "${case_id}" \
    --arg type "${evidence_type}" \
    --arg contentBase64 "${encoded}" \
    --arg subjectRef "${subject_id}" \
    --argjson source "${source_json}" \
    --argjson trust "${trust_json}" \
    --argjson createdBy "${system_actor}" \
    '{tenantId:$tenantId,caseId:$caseId,type:$type,mediaType:"application/json",contentBase64:$contentBase64,source:$source,subjectRefs:[$subjectRef],trust:$trust,createdBy:$createdBy}')"
  curl -fsS -X POST "${case_api}/v1/evidence:register" \
    -H 'content-type: application/json' \
    -H "idempotency-key: ${tenant_id}:${case_id}:${demo_id}:${evidence_suffix}" \
    --data-binary "${body}"
}

subject_result="$(command "${system_actor}" AddSubject add_subject "$(jq -n --arg name "${customer_name}" --arg country "${customer_country}" '{subjectType:"individual",displayName:$name,attributes:{country:$country}}')")"
subject_id="$(jq -r '.createdIdentifiers.subjectId' <<<"${subject_result}")"
identity_work="$(command "${system_actor}" ProposeWorkItem identity_work '{"workType":"identity_validation","priority":"NORMAL","requiredCapability":"investigation.identity"}')"
identity_work_id="$(jq -r '.createdIdentifiers.workItemId' <<<"${identity_work}")"
command "${system_actor}" TransitionCaseStatus validating '{"toStatus":"VALIDATING","reason":"Identity validation started."}' >/dev/null

identity_source='{"type":"INTERNAL_SYSTEM","dataset":"poc-customer-intake","datasetVersion":"v1","retrievedAt":"2026-09-17T18:41:12.481Z"}'
identity_trust='{"tier":"SELF_ASSERTED","instructionTrust":"UNTRUSTED_DATA"}'
identity_evidence_result="$(register_evidence identity_evidence identity_assertion "${identity_source}" "${identity_trust}" "${subject_id}" "${run_input}")"
identity_evidence_id="$(jq -r '.evidence.evidenceId' <<<"${identity_evidence_result}")"
command "${system_actor}" LinkEvidence link_identity "$(jq -n --arg evidenceId "${identity_evidence_id}" '{evidenceId:$evidenceId,purpose:"KYC_IDENTITY"}')" >/dev/null
identity_claim="$(command "${system_actor}" ProposeClaim identity_claim "$(jq -n --arg subjectRef "${subject_id}" --arg evidenceId "${identity_evidence_id}" --arg name "${customer_name}" '{subjectRef:$subjectRef,predicate:"full_name",value:$name,evidenceRefs:[$evidenceId],confidence:{value:1,method:"customer_intake"}}')")"
identity_claim_id="$(jq -r '.createdIdentifiers.claimId' <<<"${identity_claim}")"
identity_fact="$(command "${analyst_actor}" AcceptClaimAsFact identity_fact "$(jq -n --arg claimId "${identity_claim_id}" --arg subjectRef "${subject_id}" '{claimRefs:[$claimId],subjectRef:$subjectRef,acceptancePolicyRef:"poc-identity-policy@1",purpose:"KYC_ONBOARDING"}')")"
identity_fact_id="$(jq -r '.createdIdentifiers.factId' <<<"${identity_fact}")"
command "${system_actor}" CompleteWorkItem identity_complete "$(jq -n --arg workItemId "${identity_work_id}" --arg factId "${identity_fact_id}" '{workItemId:$workItemId,resultRefs:[$factId]}')" >/dev/null
command "${system_actor}" TransitionCaseStatus screening '{"toStatus":"SCREENING","reason":"Identity validation completed."}' >/dev/null

screening_work="$(command "${system_actor}" ProposeWorkItem screening_work '{"workType":"sanctions_screening","priority":"NORMAL","requiredCapability":"screening.sanctions"}')"
screening_work_id="$(jq -r '.createdIdentifiers.workItemId' <<<"${screening_work}")"
screening_source='{"type":"TOOL","dataset":"fixture-sanctions-v1","datasetVersion":"v1","capability":"screening.sanctions.search@poc","retrievedAt":"2026-09-17T18:41:12.481Z"}'
screening_trust='{"tier":"POC_PROVIDER","instructionTrust":"UNTRUSTED_DATA"}'
screening_evidence_result="$(register_evidence screening_evidence screening_result "${screening_source}" "${screening_trust}" "${subject_id}" "${screening_output}")"
screening_evidence_id="$(jq -r '.evidence.evidenceId' <<<"${screening_evidence_result}")"
command "${system_actor}" LinkEvidence link_screening "$(jq -n --arg evidenceId "${screening_evidence_id}" '{evidenceId:$evidenceId,purpose:"KYC_SCREENING"}')" >/dev/null
screening_claim="$(command "${system_actor}" ProposeClaim screening_claim "$(jq -n --arg subjectRef "${subject_id}" --arg evidenceId "${screening_evidence_id}" --argjson match "${sanctions_match}" '{subjectRef:$subjectRef,predicate:"sanctions_match",value:$match,evidenceRefs:[$evidenceId],confidence:{value:1,method:"provider_result"}}')")"
screening_claim_id="$(jq -r '.createdIdentifiers.claimId' <<<"${screening_claim}")"
screening_fact="$(command "${analyst_actor}" AcceptClaimAsFact screening_fact "$(jq -n --arg claimId "${screening_claim_id}" --arg subjectRef "${subject_id}" '{claimRefs:[$claimId],subjectRef:$subjectRef,acceptancePolicyRef:"poc-screening-policy@1",purpose:"KYC_ONBOARDING"}')")"
screening_fact_id="$(jq -r '.createdIdentifiers.factId' <<<"${screening_fact}")"
finding_type="sanctions_no_match"
[[ "${sanctions_match}" == "true" ]] && finding_type="sanctions_possible_match"
finding="$(command "${system_actor}" RecordScreeningFinding screening_finding "$(jq -n --arg findingType "${finding_type}" --arg subjectRef "${subject_id}" --arg evidenceId "${screening_evidence_id}" --arg factId "${screening_fact_id}" '{findingType:$findingType,subjectRef:$subjectRef,confidence:{value:1,method:"deterministic"},evidenceRefs:[$evidenceId],factRefs:[$factId],reason:"Sanctions provider result recorded by the compiled harness."}')")"
finding_id="$(jq -r '.createdIdentifiers.findingId' <<<"${finding}")"
command "${system_actor}" CompleteWorkItem screening_complete "$(jq -n --arg workItemId "${screening_work_id}" --arg findingId "${finding_id}" '{workItemId:$workItemId,resultRefs:[$findingId]}')" >/dev/null
command "${system_actor}" LinkExecution link_execution "$(jq -n --arg runId "${run_id}" --arg planDigest "${plan_digest}" --arg traceId "${trace_id}" '{runId:$runId,planDigest:$planDigest,traceId:$traceId,purpose:"KYC_SCREENING_AND_RECOMMENDATION"}')" >/dev/null

if [[ "${sanctions_match}" == "true" ]]; then
  echo "Possible sanctions match detected; POC correctly stops before approval." >&2
  exit 2
fi

command "${system_actor}" TransitionCaseStatus ready_for_decision '{"toStatus":"READY_FOR_DECISION","reason":"Required identity and screening work completed."}' >/dev/null
model_recommendation="$(jq -r '.recommendation // "manual_review"' <<<"${model_output}" | tr '[:upper:]' '[:lower:]')"
recommendation_outcome="REVIEW"
[[ "${model_recommendation}" =~ ^(clear|approve|approved)$ ]] && recommendation_outcome="APPROVE"
recommendation="$(command "${decision_actor/\"pending\"/\"${run_id}\"}" SubmitDecisionRecommendation recommendation "$(jq -n --arg outcome "${recommendation_outcome}" --arg findingId "${finding_id}" --arg evidenceId "${screening_evidence_id}" --arg modelRecommendation "${model_recommendation}" '{outcome:$outcome,rationale:("Compiled harness model recommendation: " + $modelRecommendation),findingRefs:[$findingId],evidenceRefs:[$evidenceId]}')")"
recommendation_id="$(jq -r '.createdIdentifiers.recommendationId' <<<"${recommendation}")"
command "${system_actor}" TransitionCaseStatus qa_review '{"toStatus":"QA_REVIEW","reason":"Decision recommendation submitted."}' >/dev/null
qa="$(command "${qa_actor/\"pending\"/\"${run_id}\"}" RecordQAResult qa_result "$(jq -n --arg recommendationRef "${recommendation_id}" --arg evidenceId "${screening_evidence_id}" '{recommendationRef:$recommendationRef,outcome:"PASS",rationale:"Independent POC QA verified evidence linkage and recommendation structure.",evidenceRefs:[$evidenceId]}')")"
qa_id="$(jq -r '.createdIdentifiers.qaResultId' <<<"${qa}")"
command "${qa_actor/\"pending\"/\"${run_id}\"}" RequestHumanReview request_human_review "$(jq -n --arg objectRef "${recommendation_id}" --arg evidenceId "${screening_evidence_id}" '{objectRef:$objectRef,reason:"Pilot configuration requires human approval.",priority:"NORMAL",evidenceRefs:[$evidenceId]}')" >/dev/null
review="$(command "${analyst_actor}" RecordReview analyst_review "$(jq -n --arg objectRef "${recommendation_id}" --arg evidenceId "${screening_evidence_id}" '{reviewType:"KYC_DISPOSITION",outcome:"APPROVE",objectRef:$objectRef,rationale:"Analyst confirmed identity and no-match screening evidence.",viewedEvidenceRefs:[$evidenceId]}')")"
review_id="$(jq -r '.createdIdentifiers.reviewId' <<<"${review}")"
gate="$(command "${system_actor}" RecordGateResult final_gate "$(jq -n --arg recommendationRef "${recommendation_id}" --arg identityWork "${identity_work_id}" --arg screeningWork "${screening_work_id}" --arg qaRef "${qa_id}" --arg reviewRef "${review_id}" '{recommendationRef:$recommendationRef,decision:"AUTHORIZED",ruleResults:[{rule:"identity_work_complete",passed:true,ref:$identityWork},{rule:"screening_work_complete",passed:true,ref:$screeningWork},{rule:"sanctions_clear",passed:true},{rule:"qa_passed",passed:true,ref:$qaRef},{rule:"human_approval_present",passed:true,ref:$reviewRef}]}')")"
gate_id="$(jq -r '.createdIdentifiers.gateResultId' <<<"${gate}")"
command "${senior_actor}" FinalizeDisposition finalize "$(jq -n --arg recommendationRef "${recommendation_id}" --arg gateResultRef "${gate_id}" --arg reviewRef "${review_id}" --arg evidenceId "${screening_evidence_id}" '{outcome:"APPROVED",recommendationRef:$recommendationRef,gateResultRef:$gateResultRef,reviewRef:$reviewRef,rationale:"Authorized low-risk POC disposition after independent QA and human review.",evidenceRefs:[$evidenceId],followUpObligations:["periodic_review_policy_unset_for_poc"]}')" >/dev/null

case_view="$(curl -fsS "${case_api}/v1/cases/${case_id}" -H "x-tenant-id: ${tenant_id}")"
ledger="$(curl -fsS -X POST "${case_api}/v1/cases/${case_id}/ledger:verify" -H "x-tenant-id: ${tenant_id}")"
jq -n \
  --arg caseId "${case_id}" \
  --arg runId "${run_id}" \
  --arg runtimeMode "${runtime_mode}" \
  --arg traceId "${trace_id}" \
  --arg status "$(jq -r '.case.status' <<<"${case_view}")" \
  --arg modelRecommendation "${model_recommendation}" \
  --argjson caseSequence "$(jq -r '.case.caseSequence' <<<"${case_view}")" \
  --argjson checkedEvents "$(jq -r '.checkedEvents' <<<"${ledger}")" \
  --argjson ledgerValid "$(jq -r '.valid' <<<"${ledger}")" \
  '{caseId:$caseId,runId:$runId,runtimeMode:$runtimeMode,traceId:$traceId,status:$status,modelRecommendation:$modelRecommendation,caseSequence:$caseSequence,ledgerValid:$ledgerValid,checkedEvents:$checkedEvents}'
