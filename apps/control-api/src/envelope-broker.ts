import {
  businessCommandTypeSchema,
  envelopeRequestSchema,
  type BusinessCommandType,
  type HarnessPlan,
} from "@ehf/contracts";
import { mintExecutionEnvelope, verifyRuntimeGrant } from "@ehf/execution-auth";
import { currentFencingEpoch, getPlan, getRun, type Database } from "@ehf/persistence";

export class EnvelopeBrokerError extends Error {
  constructor(readonly code: string, readonly httpStatus = 403) {
    super(code);
  }
}

/** Command types the plan declares this node may submit, in declaration order. */
export function declaredCaseWrites(plan: HarnessPlan, nodeId: string): BusinessCommandType[] {
  const node = plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  const writes = Array.isArray(node?.config.caseWrites) ? node.config.caseWrites : [];
  const declared = writes.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const parsed = businessCommandTypeSchema.safeParse((entry as Record<string, unknown>).commandType);
    return parsed.success ? [parsed.data] : [];
  });
  return [...new Set(declared)];
}

export type BrokerDependencies = {
  db: Database;
  envelopeSecret: string;
  grantSecret: string;
  envelopeTtlSeconds?: number;
};

/**
 * Exchange a runtime grant for a capability envelope scoped to one node.
 *
 * This is the step that used to happen inside the runtime with a shared signing secret.
 * Moving it here means the authority is re-derived from durable state every time: the
 * run must still be running, the fence must still be the one the grant was issued under,
 * and the capabilities and effects come from the admitted plan rather than from anything
 * the caller said. A stale runtime gets a denial instead of a signature.
 */
export async function issueExecutionEnvelope(
  dependencies: BrokerDependencies,
  grantToken: string,
  body: unknown,
): Promise<{ envelope: string; expiresInSeconds: number; caseWrites: BusinessCommandType[] }> {
  const request = envelopeRequestSchema.parse(body);
  let grant;
  try {
    grant = await verifyRuntimeGrant(grantToken, dependencies.grantSecret);
  } catch {
    throw new EnvelopeBrokerError("broker.grant_invalid", 401);
  }
  if (grant.run_id !== request.runId) throw new EnvelopeBrokerError("broker.run_mismatch");
  if (grant.attempt !== request.attempt) throw new EnvelopeBrokerError("broker.attempt_mismatch");

  const run = await getRun(dependencies.db, request.runId);
  if (!run) throw new EnvelopeBrokerError("broker.run_not_found", 404);
  if (run.status !== "running") throw new EnvelopeBrokerError("broker.run_not_running");
  if (run.planDigest !== grant.plan_digest) throw new EnvelopeBrokerError("broker.plan_mismatch");

  // The fence is read now, not taken from the grant: a runtime whose lease was stolen
  // while it was working must not be able to keep buying authority with an old grant.
  const epoch = await currentFencingEpoch(dependencies.db, request.runId);
  if (epoch === null || epoch !== grant.fencing_epoch) throw new EnvelopeBrokerError("broker.stale_fence");

  const plan = await getPlan(dependencies.db, run.planDigest);
  if (!plan) throw new EnvelopeBrokerError("broker.plan_not_admitted", 404);
  const permission = plan.permissionEnvelopes.find((item) => item.nodeId === request.nodeId);
  if (!permission) throw new EnvelopeBrokerError("broker.node_not_permitted");

  const caseWrites = declaredCaseWrites(plan, request.nodeId);
  const ttlSeconds = dependencies.envelopeTtlSeconds ?? 60;
  const envelope = await mintExecutionEnvelope({
    secret: dependencies.envelopeSecret,
    invocationId: request.invocationId,
    runId: request.runId,
    nodeId: request.nodeId,
    attempt: request.attempt,
    planDigest: plan.planDigest,
    permissionDigest: permission.digest,
    capabilities: permission.capabilities,
    effects: permission.effects,
    caseWrites,
    fencingEpoch: epoch,
    ttlSeconds,
  });
  return { envelope, expiresInSeconds: ttlSeconds, caseWrites };
}
