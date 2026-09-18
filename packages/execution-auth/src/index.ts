import { SignJWT, jwtVerify } from "jose";
import {
  executionEnvelopeClaimsSchema,
  type EffectClass,
  type ExecutionEnvelopeClaims,
} from "@ehf/contracts";

const ISSUER = "ehf-runtime";
const AUDIENCE = "ehf-capability-gateway";

function key(secret: string): Uint8Array {
  if (secret.length < 24) throw new Error("execution_auth.secret_too_short");
  return new TextEncoder().encode(secret);
}

export type MintEnvelopeInput = {
  secret: string;
  invocationId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  planDigest: string;
  permissionDigest: string;
  capabilities: string[];
  effects: EffectClass[];
  fencingEpoch: number;
  ttlSeconds?: number;
};

export async function mintExecutionEnvelope(input: MintEnvelopeInput): Promise<string> {
  const ttl = Math.min(120, Math.max(5, input.ttlSeconds ?? 60));
  return new SignJWT({
    run_id: input.runId,
    node_id: input.nodeId,
    attempt: input.attempt,
    plan_digest: input.planDigest,
    permission_digest: input.permissionDigest,
    capabilities: input.capabilities,
    effects: input.effects,
    fencing_epoch: input.fencingEpoch,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(input.invocationId)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(key(input.secret));
}

export async function verifyExecutionEnvelope(token: string, secret: string): Promise<ExecutionEnvelopeClaims> {
  const verified = await jwtVerify(token, key(secret), {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ["HS256"],
    clockTolerance: 2,
  });
  return executionEnvelopeClaimsSchema.parse(verified.payload);
}
