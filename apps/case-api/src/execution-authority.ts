import type { FastifyRequest } from "fastify";
import { CaseStoreError } from "@ehf/case-store";
import type { BusinessCommand, ExecutionEnvelopeClaims } from "@ehf/contracts";
import { verifyExecutionEnvelope } from "@ehf/execution-auth";
import type { Principal } from "@ehf/identity";

export const EXECUTION_ENVELOPE_HEADER = "x-execution-envelope";

export function envelopeToken(request: FastifyRequest): string | undefined {
  const value = request.headers[EXECUTION_ENVELOPE_HEADER];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

/**
 * Establish what a workload is allowed to write to a case.
 *
 * A workload token only says which service is calling. It does not say that this run,
 * at this node, was granted the authority to submit a particular canonical command --
 * and case writes used to travel with no credential at all, so anything that could
 * reach the service could write to a case as an agent. The envelope carries the
 * plan-declared command types for the node, so the plan, not the runtime, decides.
 */
export async function verifyCaseWriteAuthority(
  request: FastifyRequest,
  secret: string,
): Promise<ExecutionEnvelopeClaims> {
  const token = envelopeToken(request);
  if (!token) throw new CaseStoreError("authorization.execution_envelope_required", 401);
  if (!secret) throw new CaseStoreError("authorization.envelope_verifier_unavailable", 503);
  try {
    return await verifyExecutionEnvelope(token, secret);
  } catch {
    throw new CaseStoreError("authorization.execution_envelope_invalid", 403);
  }
}

/**
 * Check a command against the authority the envelope actually granted.
 *
 * The command names its own plan and permission envelope; those claims are only
 * believable when they match the envelope the control plane signed for this node.
 */
export function assertCommandWithinEnvelope(command: BusinessCommand, claims: ExecutionEnvelopeClaims): void {
  if (!claims.case_writes.includes(command.commandType)) {
    throw new CaseStoreError("authorization.command_not_declared", 403);
  }
  if (command.authority.planDigest !== claims.plan_digest) {
    throw new CaseStoreError("authorization.command_plan_mismatch", 403);
  }
  if (command.authority.permissionEnvelopeDigest !== claims.permission_digest) {
    throw new CaseStoreError("authorization.command_permission_mismatch", 403);
  }
  if (command.actor.type === "AGENT" && command.actor.executionId && command.actor.executionId !== claims.run_id) {
    throw new CaseStoreError("authorization.command_execution_mismatch", 403);
  }
}

/** Identify the acting run and node in audit records without leaking envelope claims. */
export function executionSubject(claims: ExecutionEnvelopeClaims): string {
  return `run:${claims.run_id}#${claims.node_id}`;
}

export function isWorkload(principal: Principal): boolean {
  return principal.actorType === "workload";
}

/**
 * A person may not record a command as though an agent produced it.
 *
 * AGENT-attributed events are the ledger's record of automated work, and an agent's
 * authority is proven by an execution envelope. Letting an interactive caller assert
 * that actor type would put unverifiable automation into the audit trail.
 */
export function assertActorTypePermitted(command: BusinessCommand, principal: Principal): void {
  if (!isWorkload(principal) && command.actor.type === "AGENT") {
    throw new CaseStoreError("authorization.agent_actor_requires_execution", 403);
  }
}
