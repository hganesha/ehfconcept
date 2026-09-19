import { SignJWT, importPKCS8, importSPKI, jwtVerify } from "jose";
import {
  executionEnvelopeClaimsSchema,
  runtimeGrantClaimsSchema,
  type BusinessCommandType,
  type EffectClass,
  type ExecutionEnvelopeClaims,
  type RuntimeGrantClaims,
} from "@ehf/contracts";

const ISSUER = "ehf-runtime";
const AUDIENCE = "ehf-capability-gateway";
const GRANT_ISSUER = "ehf-dispatcher";
const GRANT_AUDIENCE = "ehf-envelope-broker";

function key(secret: string): Uint8Array {
  if (secret.length < 24) throw new Error("execution_auth.secret_too_short");
  return new TextEncoder().encode(secret);
}

async function signingMaterial(value: string) {
  if (value.includes("BEGIN PRIVATE KEY")) return { algorithm: "RS256" as const, key: await importPKCS8(value, "RS256") };
  return { algorithm: "HS256" as const, key: key(value) };
}

async function verificationMaterial(value: string) {
  if (value.includes("BEGIN PUBLIC KEY")) return { algorithms: ["RS256"] as const, key: await importSPKI(value, "RS256") };
  return { algorithms: ["HS256"] as const, key: key(value) };
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
  caseWrites?: BusinessCommandType[];
  fencingEpoch: number;
  ttlSeconds?: number;
};

export async function mintExecutionEnvelope(input: MintEnvelopeInput): Promise<string> {
  const ttl = Math.min(120, Math.max(5, input.ttlSeconds ?? 60));
  const material = await signingMaterial(input.secret);
  return new SignJWT({
    run_id: input.runId,
    node_id: input.nodeId,
    attempt: input.attempt,
    plan_digest: input.planDigest,
    permission_digest: input.permissionDigest,
    capabilities: input.capabilities,
    effects: input.effects,
    case_writes: input.caseWrites ?? [],
    fencing_epoch: input.fencingEpoch,
  })
    .setProtectedHeader({ alg: material.algorithm, typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setJti(input.invocationId)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(material.key);
}

export async function verifyExecutionEnvelope(token: string, secret: string): Promise<ExecutionEnvelopeClaims> {
  const material = await verificationMaterial(secret);
  const verified = await jwtVerify(token, material.key, {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: [...material.algorithms],
    clockTolerance: 2,
  });
  return executionEnvelopeClaimsSchema.parse(verified.payload);
}

export type MintRuntimeGrantInput = {
  secret: string;
  grantId: string;
  runId: string;
  attempt: number;
  workerId: string;
  planDigest: string;
  fencingEpoch: number;
  ttlSeconds: number;
};

/**
 * Mint the authority a runtime carries for one invocation.
 *
 * The grant is deliberately not a capability envelope: it names a run, attempt, worker
 * and fence and nothing about what may be spent. Exchanging it for a per-node envelope
 * is a separate, re-checked step at the control plane, so possession of the grant is not
 * possession of a capability.
 */
export async function mintRuntimeGrant(input: MintRuntimeGrantInput): Promise<string> {
  // Long enough to cover the invocation deadline, since the runtime needs it for the
  // whole run, and bounded so a leaked grant expires with the work it was issued for.
  const ttl = Math.min(3_600, Math.max(30, input.ttlSeconds));
  const material = await signingMaterial(input.secret);
  return new SignJWT({
    run_id: input.runId,
    attempt: input.attempt,
    worker_id: input.workerId,
    plan_digest: input.planDigest,
    fencing_epoch: input.fencingEpoch,
  })
    .setProtectedHeader({ alg: material.algorithm, typ: "JWT" })
    .setIssuer(GRANT_ISSUER)
    .setAudience(GRANT_AUDIENCE)
    .setJti(input.grantId)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(material.key);
}

export async function verifyRuntimeGrant(token: string, secret: string): Promise<RuntimeGrantClaims> {
  const material = await verificationMaterial(secret);
  const verified = await jwtVerify(token, material.key, {
    issuer: GRANT_ISSUER,
    audience: GRANT_AUDIENCE,
    algorithms: [...material.algorithms],
    clockTolerance: 2,
  });
  return runtimeGrantClaimsSchema.parse(verified.payload);
}
