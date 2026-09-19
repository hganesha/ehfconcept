import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  agentRegistrationSchema,
  capabilityRegistrationSchema,
  evaluationReportSchema,
  harnessPlanSchema,
  stableDigest,
  verifyPlanDigest,
  skillRegistrationSchema,
  type AgentRegistration,
  type AuthoringStatus,
  type CapabilityRegistration,
  type SkillRegistration,
  type EvaluationReport,
  type CapabilityResult,
  type HarnessPlan,
  type RunRecord,
  type RuntimeEvent,
} from "@ehf/contracts";

const { Pool } = pg;
export type Database = InstanceType<typeof Pool>;

export function createDatabase(connectionString = process.env.DATABASE_URL): Database {
  if (!connectionString) throw new Error("database.url_missing");
  return new Pool({ connectionString, max: 12 });
}

type RunRow = {
  run_id: string;
  idempotency_key: string;
  plan_digest: string;
  status: RunRecord["status"];
  terminal_outcome: string | null;
  input: unknown;
  output: unknown | null;
  attempt: number;
  fencing_epoch: string | number;
  latest_checkpoint_id: string | null;
  current_node_id: string | null;
  error_code: string | null;
  trace_id: string | null;
  root_span_id: string | null;
  trace_flags: number | null;
  cost_usd: string | number;
  cost_complete: boolean;
  model_calls: number;
  capability_calls: number;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  updated_at: Date;
};

function mapRun(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    idempotencyKey: row.idempotency_key,
    planDigest: row.plan_digest,
    status: row.status,
    terminalOutcome: row.terminal_outcome,
    input: row.input,
    output: row.output,
    attempt: row.attempt,
    fencingEpoch: Number(row.fencing_epoch),
    latestCheckpointId: row.latest_checkpoint_id,
    currentNodeId: row.current_node_id,
    errorCode: row.error_code,
    traceId: row.trace_id?.trim() ?? null,
    rootSpanId: row.root_span_id?.trim() ?? null,
    traceFlags: row.trace_flags,
    costUsd: Number(row.cost_usd),
    costComplete: row.cost_complete,
    modelCalls: row.model_calls,
    capabilityCalls: row.capability_calls,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

const runColumns = `run_id, idempotency_key, plan_digest, status, terminal_outcome, input, output, attempt,
  fencing_epoch, latest_checkpoint_id, current_node_id, error_code, trace_id, root_span_id, trace_flags, cost_usd, cost_complete, model_calls,
  capability_calls, created_at, started_at, completed_at, updated_at`;

export async function admitPlan(db: Database, input: unknown, tenantId: string): Promise<{ created: boolean; plan: HarnessPlan }> {
  const plan = harnessPlanSchema.parse(input);
  // Admission is the only gate between an arbitrary document and something the
  // dispatcher will execute and the gateway will treat as authority. Recompute the
  // digest before the insert: a plan whose content does not hash to its claimed
  // digest must never reach the table, because every later check -- permission
  // envelopes, capability resolution, case-command authority -- keys off that digest.
  if (!verifyPlanDigest(plan)) throw new Error("plan.digest_invalid");
  const result = await db.query(`
    insert into harness_control.plans(plan_digest, plan_id, name, domain, version, plan, tenant_id)
    values ($1, $2, $3, $4, $5, $6::jsonb, $7)
    on conflict (plan_digest) do nothing
  `, [plan.planDigest, plan.planId, plan.metadata.name, plan.metadata.domain, plan.metadata.version, JSON.stringify(plan), tenantId]);
  return { created: (result.rowCount ?? 0) > 0, plan };
}

/**
 * Read an admitted plan.
 *
 * `tenantId` scopes the read to a caller's assignment. It is omitted by components
 * acting on behalf of a run that has already been authorized -- the gateway verifying an
 * envelope, the dispatcher executing a claimed run -- where the plan digest itself is
 * the authority and there is no caller tenant to check against.
 */
export async function getPlan(db: Database, digest: string, tenantId?: string): Promise<HarnessPlan | null> {
  const result = tenantId
    ? await db.query<{ plan: unknown }>(
      "select plan from harness_control.plans where plan_digest = $1 and tenant_id = $2", [digest, tenantId])
    : await db.query<{ plan: unknown }>(
      "select plan from harness_control.plans where plan_digest = $1", [digest]);
  return result.rows[0] ? harnessPlanSchema.parse(result.rows[0].plan) : null;
}

export async function listPlans(db: Database, tenantId: string): Promise<HarnessPlan[]> {
  const result = await db.query<{ plan: unknown }>(
    "select plan from harness_control.plans where tenant_id = $1 order by admitted_at desc limit 100",
    [tenantId],
  );
  return result.rows.map((row) => harnessPlanSchema.parse(row.plan));
}

export type PlanRecord = { plan: HarnessPlan; admittedAt: string };

export async function listPlanRecords(db: Database, tenantId: string): Promise<PlanRecord[]> {
  const result = await db.query<{ plan: unknown; admitted_at: Date }>(
    "select plan, admitted_at from harness_control.plans where tenant_id = $1 order by admitted_at desc limit 100",
    [tenantId],
  );
  return result.rows.map((row) => ({
    plan: harnessPlanSchema.parse(row.plan),
    admittedAt: row.admitted_at.toISOString(),
  }));
}

export async function createRun(
  db: Database,
  input: { planDigest: string; runInput: unknown; idempotencyKey: string; tenantId: string },
): Promise<{ created: boolean; run: RunRecord }> {
  const runId = `RUN-${randomUUID()}`;
  const result = await db.query<RunRow>(`
    insert into harness_runtime.runs(run_id, idempotency_key, plan_digest, status, input, tenant_id)
    values ($1, $2, $3, 'queued', $4::jsonb, $5)
    on conflict (idempotency_key) do update set updated_at = harness_runtime.runs.updated_at
    returning ${runColumns}
  `, [runId, input.idempotencyKey, input.planDigest, JSON.stringify(input.runInput), input.tenantId]);
  const row = result.rows[0];
  if (!row) throw new Error("run.create_failed");
  return { created: row.run_id === runId, run: mapRun(row) };
}

export async function getRun(db: Database, runId: string, tenantId?: string): Promise<RunRecord | null> {
  const result = tenantId
    ? await db.query<RunRow>(
      `select ${runColumns} from harness_runtime.runs where run_id = $1 and tenant_id = $2`, [runId, tenantId])
    : await db.query<RunRow>(
      `select ${runColumns} from harness_runtime.runs where run_id = $1`, [runId]);
  return result.rows[0] ? mapRun(result.rows[0]) : null;
}

export async function listRuns(db: Database, tenantId: string, limit = 100): Promise<RunRecord[]> {
  const result = await db.query<RunRow>(
    `select ${runColumns} from harness_runtime.runs where tenant_id = $1 order by updated_at desc limit $2`,
    [tenantId, Math.max(1, Math.min(100, limit))],
  );
  return result.rows.map(mapRun);
}

export type ClaimedRun = RunRecord & { workerId: string };

export async function claimRun(db: Database, workerId: string, leaseSeconds: number): Promise<ClaimedRun | null> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const selected = await client.query<{ run_id: string }>(`
      select run_id
      from harness_runtime.runs
      where (
          (status in ('queued','retrying') and (available_at is null or available_at <= now()))
          or (status = 'running' and lease_expires_at < now())
        )
        and cancellation_requested_at is null
        and attempt < attempt_limit
      order by created_at
      for update skip locked
      limit 1
    `);
    const runId = selected.rows[0]?.run_id;
    if (!runId) {
      await client.query("commit");
      return null;
    }
    const updated = await client.query<RunRow>(`
      update harness_runtime.runs
      set status = 'running', lease_owner = $2,
          lease_expires_at = now() + make_interval(secs => $3),
          fencing_epoch = fencing_epoch + 1,
          attempt = attempt + 1,
          available_at = null,
          started_at = coalesce(started_at, now()), updated_at = now()
      where run_id = $1
      returning ${runColumns}
    `, [runId, workerId, leaseSeconds]);
    await client.query("commit");
    const row = updated.rows[0];
    return row ? { ...mapRun(row), workerId } : null;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function renewLease(
  db: Database,
  runId: string,
  workerId: string,
  fencingEpoch: number,
  leaseSeconds: number,
): Promise<boolean> {
  const result = await db.query(`
    update harness_runtime.runs
    set lease_expires_at = now() + make_interval(secs => $4), updated_at = now()
    where run_id = $1 and lease_owner = $2 and fencing_epoch = $3 and status = 'running'
  `, [runId, workerId, fencingEpoch, leaseSeconds]);
  return (result.rowCount ?? 0) === 1;
}

/**
 * Release a run for another attempt after a transient failure.
 *
 * Fenced like every other write, so a worker that already lost its lease cannot drag a
 * run that someone else is now executing back into the queue.
 */
export async function scheduleRunRetry(
  db: Database,
  input: { runId: string; workerId: string; fencingEpoch: number; errorCode: string; backoffMs: number },
): Promise<boolean> {
  const result = await db.query(`
    update harness_runtime.runs
    set status = 'retrying', lease_owner = null, lease_expires_at = null,
        available_at = now() + make_interval(secs => $4),
        error_code = $5, updated_at = now()
    where run_id = $1 and lease_owner = $2 and fencing_epoch = $3 and status = 'running'
      and attempt < attempt_limit
  `, [input.runId, input.workerId, input.fencingEpoch, Math.max(0, input.backoffMs) / 1000, input.errorCode]);
  return (result.rowCount ?? 0) === 1;
}

/** Runs that exhausted their attempt budget are terminal, not silently stuck as retrying. */
export async function failExhaustedRuns(db: Database): Promise<number> {
  const result = await db.query(`
    update harness_runtime.runs
    set status = 'failed', terminal_outcome = 'failed',
        error_code = coalesce(error_code, 'runtime.attempts_exhausted'),
        lease_owner = null, lease_expires_at = null, completed_at = now(), updated_at = now()
    where status in ('queued','retrying') and attempt >= attempt_limit
  `);
  return result.rowCount ?? 0;
}

export type CancellationOutcome = "already_terminal" | "cancelled" | "requested" | "not_found";

/**
 * Record a cancellation request.
 *
 * Cancellation is a durable command, not a signal. The fence is incremented as part of
 * the same statement, so every envelope and journal write the running attempt still
 * holds is refused from this moment on -- which is what stops a worker that has not yet
 * noticed from producing further effects. A run that is not yet executing goes straight
 * to terminal; a running one is marked and the dispatcher completes it when it stops.
 *
 * It cannot unmake an effect already committed, so the record distinguishes a request
 * from an effective cancellation.
 */
export async function requestRunCancellation(
  db: Database,
  input: { runId: string; tenantId: string; reason: string },
): Promise<{ outcome: CancellationOutcome; run: RunRecord | null }> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const selected = await client.query<RunRow>(
      `select ${runColumns} from harness_runtime.runs where run_id = $1 and tenant_id = $2 for update`,
      [input.runId, input.tenantId],
    );
    const current = selected.rows[0];
    if (!current) {
      await client.query("commit");
      return { outcome: "not_found", run: null };
    }
    if (!["queued", "running", "retrying"].includes(current.status)) {
      await client.query("commit");
      return { outcome: "already_terminal", run: mapRun(current) };
    }
    const running = current.status === "running";
    const updated = await client.query<RunRow>(`
      update harness_runtime.runs
      set cancellation_requested_at = now(),
          cancellation_reason = $2,
          fencing_epoch = fencing_epoch + 1,
          status = case when status = 'running' then status else 'cancelled' end,
          terminal_outcome = case when status = 'running' then terminal_outcome else 'cancelled' end,
          completed_at = case when status = 'running' then completed_at else now() end,
          lease_owner = case when status = 'running' then lease_owner else null end,
          lease_expires_at = case when status = 'running' then lease_expires_at else null end,
          updated_at = now()
      where run_id = $1
      returning ${runColumns}
    `, [input.runId, input.reason]);
    await client.query("commit");
    const row = updated.rows[0];
    return { outcome: running ? "requested" : "cancelled", run: row ? mapRun(row) : null };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Close out a run the requester asked to stop.
 *
 * Guarded by the cancellation marker rather than by the fence, because requesting the
 * cancellation is what moved the fence: the worker that has to record the outcome is
 * deliberately no longer the current epoch. The transition is narrow -- only a running
 * run with a recorded request becomes cancelled -- so it cannot be used to close out
 * anything else.
 */
export async function completeCancelledRun(
  db: Database,
  input: { runId: string; errorCode?: string },
): Promise<boolean> {
  const result = await db.query(`
    update harness_runtime.runs
    set status = 'cancelled', terminal_outcome = 'cancelled',
        error_code = coalesce($2, error_code, 'runtime.cancelled'),
        lease_owner = null, lease_expires_at = null,
        completed_at = now(), updated_at = now()
    where run_id = $1 and status = 'running' and cancellation_requested_at is not null
  `, [input.runId, input.errorCode ?? null]);
  return (result.rowCount ?? 0) === 1;
}

/**
 * Finalize cancelled runs whose worker never acknowledged.
 *
 * A worker can die between the request and the acknowledgement. Nothing will re-claim
 * the run -- claimRun deliberately skips cancelled runs -- so without this sweep it
 * would sit in 'running' forever.
 */
export async function finalizeAbandonedCancellations(db: Database): Promise<number> {
  const result = await db.query(`
    update harness_runtime.runs
    set status = 'cancelled', terminal_outcome = 'cancelled',
        error_code = coalesce(error_code, 'runtime.cancelled_lease_expired'),
        lease_owner = null, lease_expires_at = null,
        completed_at = now(), updated_at = now()
    where status = 'running' and cancellation_requested_at is not null
      and (lease_expires_at is null or lease_expires_at < now())
  `);
  return result.rowCount ?? 0;
}

/** Has a cancellation been requested for this run? Polled by the worker's heartbeat. */
export async function cancellationRequested(db: Database, runId: string): Promise<string | null> {
  const result = await db.query<{ cancellation_reason: string | null; cancellation_requested_at: Date | null }>(
    "select cancellation_reason, cancellation_requested_at from harness_runtime.runs where run_id = $1",
    [runId],
  );
  const row = result.rows[0];
  return row?.cancellation_requested_at ? row.cancellation_reason ?? "cancelled" : null;
}

export async function currentFencingEpoch(db: Database, runId: string): Promise<number | null> {
  const result = await db.query<{ fencing_epoch: string | number }>(
    "select fencing_epoch from harness_runtime.runs where run_id = $1 and status = 'running'",
    [runId],
  );
  return result.rows[0] ? Number(result.rows[0].fencing_epoch) : null;
}

export async function updateRunNode(
  db: Database,
  input: { runId: string; workerId: string; fencingEpoch: number; nodeId: string | null; checkpointId?: string | null },
): Promise<void> {
  const result = await db.query(`
    update harness_runtime.runs
    set current_node_id = $4,
        latest_checkpoint_id = coalesce($5, latest_checkpoint_id),
        updated_at = now()
    where run_id = $1 and lease_owner = $2 and fencing_epoch = $3 and status = 'running'
  `, [input.runId, input.workerId, input.fencingEpoch, input.nodeId, input.checkpointId ?? null]);
  if ((result.rowCount ?? 0) !== 1) throw new Error("runtime.stale_fence");
}

export async function bindRunTrace(
  db: Database,
  input: {
    runId: string;
    attempt: number;
    workerId: string;
    fencingEpoch: number;
    traceId: string;
    spanId: string;
    traceFlags: number;
    serviceName: string;
  },
): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const updated = await client.query(`
      update harness_runtime.runs
      set trace_id = coalesce(trace_id, $5), root_span_id = coalesce(root_span_id, $6),
          trace_flags = coalesce(trace_flags, $7), updated_at = now()
      where run_id = $1 and lease_owner = $2 and fencing_epoch = $3 and attempt = $4 and status = 'running'
    `, [input.runId, input.workerId, input.fencingEpoch, input.attempt, input.traceId, input.spanId, input.traceFlags]);
    if ((updated.rowCount ?? 0) !== 1) throw new Error("runtime.stale_fence");
    await client.query(`
      insert into observability.trace_link(run_id, attempt, trace_id, root_span_id, trace_flags, service_name)
      values ($1,$2,$3,$4,$5,$6)
      on conflict (run_id, attempt, service_name) do update
      set trace_id = excluded.trace_id, root_span_id = excluded.root_span_id,
          trace_flags = excluded.trace_flags, observed_at = now()
    `, [input.runId, input.attempt, input.traceId, input.spanId, input.traceFlags, input.serviceName]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeRun(
  db: Database,
  input: {
    runId: string;
    workerId: string;
    fencingEpoch: number;
    status: "completed" | "manual_review" | "denied" | "failed" | "cancelled";
    terminalOutcome: string;
    output: unknown;
    errorCode?: string;
  },
): Promise<void> {
  const result = await db.query(`
    update harness_runtime.runs
    set status = $4, terminal_outcome = $5, output = $6::jsonb,
        error_code = $7, lease_owner = null, lease_expires_at = null,
        completed_at = now(), updated_at = now()
    where run_id = $1 and lease_owner = $2 and fencing_epoch = $3 and status = 'running'
  `, [
    input.runId,
    input.workerId,
    input.fencingEpoch,
    input.status,
    input.terminalOutcome,
    JSON.stringify(input.output),
    input.errorCode ?? null,
  ]);
  if ((result.rowCount ?? 0) !== 1) throw new Error("runtime.stale_fence");
}

export async function appendEvent(
  db: Database,
  input: Omit<RuntimeEvent, "sequence" | "occurredAt"> & { eventKey: string },
): Promise<RuntimeEvent> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const existing = await client.query<{
      sequence: string | number;
      code: string;
      node_id: string | null;
      status: RuntimeEvent["status"];
      values: Record<string, unknown>;
      occurred_at: Date;
    }>(`
      select sequence, code, node_id, status, values, occurred_at
      from harness_runtime.run_events where run_id = $1 and event_key = $2
    `, [input.runId, input.eventKey]);
    if (existing.rows[0]) {
      await client.query("commit");
      const row = existing.rows[0];
      return {
        runId: input.runId,
        sequence: Number(row.sequence),
        code: row.code,
        nodeId: row.node_id,
        status: row.status,
        values: row.values,
        occurredAt: row.occurred_at.toISOString(),
      };
    }
    const seq = await client.query<{ event_sequence: string | number }>(`
      update harness_runtime.runs
      set event_sequence = event_sequence + 1, updated_at = now()
      where run_id = $1 returning event_sequence
    `, [input.runId]);
    const sequence = Number(seq.rows[0]?.event_sequence);
    if (!Number.isFinite(sequence)) throw new Error("event.run_missing");
    const inserted = await client.query<{ occurred_at: Date }>(`
      insert into harness_runtime.run_events(run_id, sequence, event_key, code, node_id, status, values)
      values ($1, $2, $3, $4, $5, $6, $7::jsonb)
      returning occurred_at
    `, [input.runId, sequence, input.eventKey, input.code, input.nodeId, input.status, JSON.stringify(input.values)]);
    await client.query("commit");
    return {
      runId: input.runId,
      sequence,
      code: input.code,
      nodeId: input.nodeId,
      status: input.status,
      values: input.values,
      occurredAt: inserted.rows[0]!.occurred_at.toISOString(),
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listEvents(db: Database, runId: string, afterSequence = 0): Promise<RuntimeEvent[]> {
  const result = await db.query<{
    sequence: string | number;
    code: string;
    node_id: string | null;
    status: RuntimeEvent["status"];
    values: Record<string, unknown>;
    occurred_at: Date;
  }>(`
    select sequence, code, node_id, status, values, occurred_at
    from harness_runtime.run_events
    where run_id = $1 and sequence > $2
    order by sequence
    limit 1000
  `, [runId, afterSequence]);
  return result.rows.map((row) => ({
    runId,
    sequence: Number(row.sequence),
    code: row.code,
    nodeId: row.node_id,
    status: row.status,
    values: row.values,
    occurredAt: row.occurred_at.toISOString(),
  }));
}

export async function beginNodeAttempt(
  db: Database,
  input: { runId: string; nodeId: string; attempt: number; fencingEpoch: number; value: unknown; traceId?: string; spanId?: string },
): Promise<void> {
  await db.query(`
    insert into harness_runtime.node_attempts(
      run_id, node_id, attempt, fencing_epoch, status, input_digest, trace_id, span_id
    ) values ($1, $2, $3, $4, 'running', $5, $6, $7)
    on conflict (run_id, node_id, attempt) do nothing
  `, [input.runId, input.nodeId, input.attempt, input.fencingEpoch, stableDigest(input.value), input.traceId ?? null, input.spanId ?? null]);
}

export async function finishNodeAttempt(
  db: Database,
  input: { runId: string; nodeId: string; attempt: number; status: string; value?: unknown; errorCode?: string; checkpointId?: string },
): Promise<void> {
  await db.query(`
    update harness_runtime.node_attempts
    set status = $4, output_digest = $5, error_code = $6,
        checkpoint_id = $7, completed_at = now()
    where run_id = $1 and node_id = $2 and attempt = $3
  `, [
    input.runId,
    input.nodeId,
    input.attempt,
    input.status,
    input.value === undefined ? null : stableDigest(input.value),
    input.errorCode ?? null,
    input.checkpointId ?? null,
  ]);
}

export type NodeAttemptRecord = {
  runId: string;
  nodeId: string;
  attempt: number;
  fencingEpoch: number;
  status: string;
  inputDigest: string | null;
  outputDigest: string | null;
  checkpointId: string | null;
  startedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  traceId: string | null;
  spanId: string | null;
};

export async function listNodeAttempts(db: Database, runId: string): Promise<NodeAttemptRecord[]> {
  const result = await db.query<{
    run_id: string; node_id: string; attempt: number; fencing_epoch: string | number; status: string;
    input_digest: string | null; output_digest: string | null; checkpoint_id: string | null;
    started_at: Date; completed_at: Date | null; error_code: string | null;
    trace_id: string | null; span_id: string | null;
  }>(`
    select run_id, node_id, attempt, fencing_epoch, status, input_digest, output_digest,
           checkpoint_id, started_at, completed_at, error_code, trace_id, span_id
    from harness_runtime.node_attempts
    where run_id = $1
    order by started_at, node_id, attempt
  `, [runId]);
  return result.rows.map((row) => ({
    runId: row.run_id,
    nodeId: row.node_id,
    attempt: row.attempt,
    fencingEpoch: Number(row.fencing_epoch),
    status: row.status,
    inputDigest: row.input_digest,
    outputDigest: row.output_digest,
    checkpointId: row.checkpoint_id,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    errorCode: row.error_code,
    traceId: row.trace_id?.trim() ?? null,
    spanId: row.span_id?.trim() ?? null,
  }));
}

export type GatewayReceiptInput = {
  invocationId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  fencingEpoch: number;
  planDigest: string;
  permissionDigest: string;
  capabilityId: string;
  effect: string;
  decision: "allowed" | "denied";
  reasonCode: string;
  requestDigest: string;
  traceId?: string;
  spanId?: string;
};

export async function reserveGatewayReceipt(
  db: Database,
  input: GatewayReceiptInput,
): Promise<{ created: boolean; result: CapabilityResult | null }> {
  const result = await db.query<{ result: CapabilityResult | null }>(`
    insert into harness_gateway.receipts(
      invocation_id, run_id, node_id, attempt, fencing_epoch, plan_digest,
      permission_digest, capability_id, effect, decision, reason_code, request_digest, trace_id, span_id
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    on conflict (invocation_id) do nothing
    returning result
  `, [
    input.invocationId, input.runId, input.nodeId, input.attempt, input.fencingEpoch,
    input.planDigest, input.permissionDigest, input.capabilityId, input.effect,
    input.decision, input.reasonCode, input.requestDigest, input.traceId ?? null, input.spanId ?? null,
  ]);
  if ((result.rowCount ?? 0) > 0) return { created: true, result: null };
  const existing = await db.query<{ result: CapabilityResult | null; request_digest: string }>(
    "select result, request_digest from harness_gateway.receipts where invocation_id = $1",
    [input.invocationId],
  );
  if (existing.rows[0]?.request_digest !== input.requestDigest) throw new Error("gateway.idempotency_conflict");
  return { created: false, result: existing.rows[0]?.result ?? null };
}

export async function completeGatewayReceipt(db: Database, result: CapabilityResult): Promise<void> {
  await db.query(`
    update harness_gateway.receipts
    set result = $2::jsonb, receipt_digest = $3, completed_at = now()
    where invocation_id = $1
  `, [result.invocationId, JSON.stringify(result), result.receiptDigest]);
}

export type GatewayReceiptRecord = {
  invocationId: string;
  runId: string;
  nodeId: string;
  attempt: number;
  fencingEpoch: number;
  planDigest: string;
  permissionDigest: string;
  capabilityId: string;
  effect: string;
  decision: "allowed" | "denied";
  reasonCode: string;
  requestDigest: string;
  result: CapabilityResult | null;
  receiptDigest: string | null;
  traceId: string | null;
  spanId: string | null;
  createdAt: string;
  completedAt: string | null;
};

export async function listGatewayReceipts(
  db: Database,
  options: { runId?: string; decision?: "allowed" | "denied"; limit?: number } = {},
): Promise<GatewayReceiptRecord[]> {
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const result = await db.query<{
    invocation_id: string; run_id: string; node_id: string; attempt: number; fencing_epoch: string | number;
    plan_digest: string; permission_digest: string; capability_id: string; effect: string;
    decision: "allowed" | "denied"; reason_code: string; request_digest: string;
    result: CapabilityResult | null; receipt_digest: string | null; trace_id: string | null;
    span_id: string | null; created_at: Date; completed_at: Date | null;
  }>(`
    select invocation_id, run_id, node_id, attempt, fencing_epoch, plan_digest,
           permission_digest, capability_id, effect, decision, reason_code, request_digest,
           result, receipt_digest, trace_id, span_id, created_at, completed_at
    from harness_gateway.receipts
    where ($1::text is null or run_id = $1)
      and ($2::text is null or decision = $2)
    order by case when decision = 'denied' then 0 else 1 end, created_at desc
    limit $3
  `, [options.runId ?? null, options.decision ?? null, limit]);
  return result.rows.map((row) => ({
    invocationId: row.invocation_id,
    runId: row.run_id,
    nodeId: row.node_id,
    attempt: row.attempt,
    fencingEpoch: Number(row.fencing_epoch),
    planDigest: row.plan_digest,
    permissionDigest: row.permission_digest,
    capabilityId: row.capability_id,
    effect: row.effect,
    decision: row.decision,
    reasonCode: row.reason_code,
    requestDigest: row.request_digest,
    result: row.result,
    receiptDigest: row.receipt_digest,
    traceId: row.trace_id?.trim() ?? null,
    spanId: row.span_id?.trim() ?? null,
    createdAt: row.created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  }));
}

export async function recordCapabilityUsage(
  db: Database,
  input: { runId: string; modelCall: boolean; costUsd: number | null },
): Promise<void> {
  await db.query(`
    update harness_runtime.runs
    set capability_calls = capability_calls + 1,
        model_calls = model_calls + case when $2 then 1 else 0 end,
        cost_usd = cost_usd + coalesce($3::numeric, 0::numeric),
        cost_complete = cost_complete and ($3 is not null),
        updated_at = now()
    where run_id = $1
  `, [input.runId, input.modelCall, input.costUsd]);
}

export type AuthoringDiagnostic = {
  code: string;
  severity: "error" | "warning" | "info";
  path: string;
  message: string;
};

export type AuthoringDraftRecord = {
  draftId: string;
  name: string;
  domain: string;
  version: string;
  status: AuthoringStatus;
  revision: number;
  packageSource: string;
  workflowSource: string;
  parsedPackage: Record<string, unknown>;
  parsedWorkflow: Record<string, unknown>;
  compiledPlan: HarnessPlan | null;
  diagnostics: AuthoringDiagnostic[];
  evaluationReport: EvaluationReport | null;
  approvedBy: string | null;
  publishedPlanDigest: string | null;
  createdAt: string;
  updatedAt: string;
};

type AuthoringDraftRow = {
  draft_id: string; name: string; domain: string; version: string; status: AuthoringStatus;
  revision: number; package_source: string; workflow_source: string;
  parsed_package: Record<string, unknown>; parsed_workflow: Record<string, unknown>;
  compiled_plan: unknown | null; diagnostics: AuthoringDiagnostic[]; evaluation_report: unknown | null;
  approved_by: string | null; published_plan_digest: string | null; created_at: Date; updated_at: Date;
};

function mapAuthoringDraft(row: AuthoringDraftRow): AuthoringDraftRecord {
  return {
    draftId: row.draft_id,
    name: row.name,
    domain: row.domain,
    version: row.version,
    status: row.status,
    revision: row.revision,
    packageSource: row.package_source,
    workflowSource: row.workflow_source,
    parsedPackage: row.parsed_package,
    parsedWorkflow: row.parsed_workflow,
    compiledPlan: row.compiled_plan ? harnessPlanSchema.parse(row.compiled_plan) : null,
    diagnostics: row.diagnostics,
    evaluationReport: row.evaluation_report ? evaluationReportSchema.parse(row.evaluation_report) : null,
    approvedBy: row.approved_by,
    publishedPlanDigest: row.published_plan_digest,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const authoringColumns = `draft_id, name, domain, version, status, revision, package_source, workflow_source,
  parsed_package, parsed_workflow, compiled_plan, diagnostics, evaluation_report, approved_by,
  published_plan_digest, created_at, updated_at`;

export async function createAuthoringDraft(db: Database, input: {
  packageSource: string; workflowSource: string; parsedPackage: Record<string, unknown>;
  parsedWorkflow: Record<string, unknown>; name: string; domain: string; version: string;
  diagnostics: AuthoringDiagnostic[]; actor: string; tenantId: string;
}): Promise<AuthoringDraftRecord> {
  const draftId = `draft_${randomUUID()}`;
  const result = await db.query<AuthoringDraftRow>(`
    insert into harness_control.authoring_drafts(
      draft_id, name, domain, version, status, package_source, workflow_source,
      parsed_package, parsed_workflow, diagnostics, tenant_id
    ) values ($1, $2, $3, $4, 'DRAFT', $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
    returning ${authoringColumns}
  `, [draftId, input.name, input.domain, input.version, input.packageSource, input.workflowSource,
    JSON.stringify(input.parsedPackage), JSON.stringify(input.parsedWorkflow), JSON.stringify(input.diagnostics), input.tenantId]);
  await db.query(`insert into harness_control.authoring_events(event_id, draft_id, revision, event_type, actor, details)
    values ($1, $2, 1, 'draft.created', $3, $4::jsonb)`,
  [`evt_${randomUUID()}`, draftId, input.actor, JSON.stringify({ source: "authoring-plane" })]);
  const row = result.rows[0];
  if (!row) throw new Error("authoring.create_failed");
  return mapAuthoringDraft(row);
}

export async function listAuthoringDrafts(db: Database, tenantId: string): Promise<AuthoringDraftRecord[]> {
  const result = await db.query<AuthoringDraftRow>(
    `select ${authoringColumns} from harness_control.authoring_drafts where tenant_id = $1 order by updated_at desc limit 100`,
    [tenantId],
  );
  return result.rows.map(mapAuthoringDraft);
}

export async function getAuthoringDraft(db: Database, draftId: string, tenantId?: string): Promise<AuthoringDraftRecord | null> {
  const result = tenantId
    ? await db.query<AuthoringDraftRow>(
      `select ${authoringColumns} from harness_control.authoring_drafts where draft_id = $1 and tenant_id = $2`, [draftId, tenantId])
    : await db.query<AuthoringDraftRow>(
      `select ${authoringColumns} from harness_control.authoring_drafts where draft_id = $1`, [draftId]);
  return result.rows[0] ? mapAuthoringDraft(result.rows[0]) : null;
}

/**
 * Actors who shaped this draft's content.
 *
 * Read from the authoring event log rather than a denormalized column, so the check and
 * the audit trail cannot disagree. Lifecycle transitions that only observe the draft --
 * evaluation, approval, publication -- are not authorship.
 */
export async function authoringContributors(db: Database, draftId: string): Promise<string[]> {
  const result = await db.query<{ actor: string }>(`
    select distinct actor from harness_control.authoring_events
    where draft_id = $1 and event_type in ('draft.created', 'draft.updated', 'draft.compiled')
  `, [draftId]);
  return result.rows.map((row) => row.actor);
}

export class SeparationOfDutiesError extends Error {
  constructor(readonly actor: string) {
    super("authoring.separation_of_duties");
  }
}

export async function updateAuthoringSources(db: Database, draftId: string, input: {
  expectedRevision: number; packageSource: string; workflowSource: string;
  parsedPackage: Record<string, unknown>; parsedWorkflow: Record<string, unknown>;
  name: string; domain: string; version: string; diagnostics: AuthoringDiagnostic[]; actor: string;
}): Promise<AuthoringDraftRecord> {
  const result = await db.query<AuthoringDraftRow>(`
    update harness_control.authoring_drafts
    set name=$3, domain=$4, version=$5, package_source=$6, workflow_source=$7,
        parsed_package=$8::jsonb, parsed_workflow=$9::jsonb, diagnostics=$10::jsonb,
        status='DRAFT', revision=revision+1, compiled_plan=null, evaluation_report=null,
        approved_by=null, published_plan_digest=null, updated_at=now()
    where draft_id=$1 and revision=$2 and status <> 'PUBLISHED'
    returning ${authoringColumns}
  `, [draftId, input.expectedRevision, input.name, input.domain, input.version, input.packageSource,
    input.workflowSource, JSON.stringify(input.parsedPackage), JSON.stringify(input.parsedWorkflow), JSON.stringify(input.diagnostics)]);
  const row = result.rows[0];
  if (!row) throw new Error("authoring.revision_conflict_or_published");
  await db.query(`insert into harness_control.authoring_events(event_id, draft_id, revision, event_type, actor, details)
    values ($1, $2, $3, 'draft.updated', $4, '{}'::jsonb)`, [`evt_${randomUUID()}`, draftId, row.revision, input.actor]);
  return mapAuthoringDraft(row);
}

export async function setAuthoringLifecycle(db: Database, draftId: string, input: {
  expectedStatus: AuthoringStatus; status: AuthoringStatus; actor: string; compiledPlan?: HarnessPlan;
  diagnostics?: AuthoringDiagnostic[]; evaluationReport?: EvaluationReport; publishedPlanDigest?: string;
}): Promise<AuthoringDraftRecord> {
  // approved_by used to be recorded and never compared with anything, so a single
  // identity could author, evaluate, approve and publish its own plan. Approval and
  // publication are the two transitions that confer authority on a plan, so they are the
  // two that an author may not perform.
  if (input.status === "APPROVED" || input.status === "PUBLISHED") {
    const contributors = await authoringContributors(db, draftId);
    if (contributors.includes(input.actor)) throw new SeparationOfDutiesError(input.actor);
  }
  const result = await db.query<AuthoringDraftRow>(`
    update harness_control.authoring_drafts
    set status=$3,
        compiled_plan=coalesce($4::jsonb, compiled_plan),
        diagnostics=coalesce($5::jsonb, diagnostics),
        evaluation_report=coalesce($6::jsonb, evaluation_report),
        approved_by=case when $3='APPROVED' then $7 else approved_by end,
        published_by=case when $3='PUBLISHED' then $7 else published_by end,
        published_plan_digest=coalesce($8, published_plan_digest),
        updated_at=now()
    where draft_id=$1 and status=$2
    returning ${authoringColumns}
  `, [draftId, input.expectedStatus, input.status, input.compiledPlan ? JSON.stringify(input.compiledPlan) : null,
    input.diagnostics ? JSON.stringify(input.diagnostics) : null,
    input.evaluationReport ? JSON.stringify(input.evaluationReport) : null,
    input.actor, input.publishedPlanDigest ?? null]);
  const row = result.rows[0];
  if (!row) throw new Error("authoring.lifecycle_conflict");
  await db.query(`insert into harness_control.authoring_events(event_id, draft_id, revision, event_type, actor, details)
    values ($1, $2, $3, $4, $5, $6::jsonb)`, [`evt_${randomUUID()}`, draftId, row.revision,
    `draft.${input.status.toLowerCase()}`, input.actor, JSON.stringify({ from: input.expectedStatus, to: input.status, planDigest: input.compiledPlan?.planDigest ?? input.publishedPlanDigest })]);
  return mapAuthoringDraft(row);
}

export async function listAuthoringEvents(db: Database, draftId: string) {
  const result = await db.query<{ event_id: string; revision: number; event_type: string; actor: string; details: Record<string, unknown>; occurred_at: Date }>(`
    select event_id, revision, event_type, actor, details, occurred_at
    from harness_control.authoring_events where draft_id=$1 order by occurred_at desc
  `, [draftId]);
  return result.rows.map((row) => ({ eventId: row.event_id, revision: row.revision, eventType: row.event_type, actor: row.actor, details: row.details, occurredAt: row.occurred_at.toISOString() }));
}

export async function registerCapability(db: Database, input: unknown): Promise<{ created: boolean; capability: CapabilityRegistration; digest: string }> {
  const capability = capabilityRegistrationSchema.parse(input);
  const digest = stableDigest(capability);
  const result = await db.query(`
    insert into harness_gateway.capability_registry(capability_id, definition, definition_digest, status, owner)
    values ($1, $2::jsonb, $3, $4, $5)
    on conflict (capability_id) do update set definition=excluded.definition, definition_digest=excluded.definition_digest,
      status=excluded.status, owner=excluded.owner, updated_at=now()
  `, [capability.id, JSON.stringify(capability), digest, capability.status, capability.owner]);
  return { created: (result.rowCount ?? 0) > 0, capability, digest };
}

export async function listRegisteredCapabilities(db: Database): Promise<Array<{ capability: CapabilityRegistration; digest: string; createdAt: string; updatedAt: string }>> {
  const result = await db.query<{ definition: unknown; definition_digest: string; created_at: Date; updated_at: Date }>(`
    select definition, definition_digest, created_at, updated_at from harness_gateway.capability_registry order by capability_id
  `);
  return result.rows.map((row) => ({ capability: capabilityRegistrationSchema.parse(row.definition), digest: row.definition_digest,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }));
}

export type AgentRegistryRecord = { agent: AgentRegistration; digest: string; createdAt: string; updatedAt: string };
export type SkillRegistryRecord = { skill: SkillRegistration; digest: string; createdAt: string; updatedAt: string };

export async function registerAuthoringAgent(db: Database, input: unknown): Promise<{ created: boolean } & AgentRegistryRecord> {
  const agent = agentRegistrationSchema.parse(input);
  const digest = stableDigest(agent);
  const existing = await db.query("select 1 from harness_control.agent_registry where agent_id=$1", [agent.id]);
  const result = await db.query<{ created_at: Date; updated_at: Date }>(`
    insert into harness_control.agent_registry(agent_id, definition, definition_digest, status, source_type, source_url)
    values ($1,$2::jsonb,$3,$4,$5,$6)
    on conflict (agent_id) do update set definition=excluded.definition, definition_digest=excluded.definition_digest,
      status=excluded.status, source_type=excluded.source_type, source_url=excluded.source_url, updated_at=now()
    returning created_at, updated_at
  `, [agent.id, JSON.stringify(agent), digest, agent.status, agent.source.type, agent.source.url ?? null]);
  const row = result.rows[0];
  if (!row) throw new Error("authoring.agent_registration_failed");
  return { created: existing.rowCount === 0, agent, digest, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

export async function listAuthoringAgents(db: Database): Promise<AgentRegistryRecord[]> {
  const result = await db.query<{ definition: unknown; definition_digest: string; created_at: Date; updated_at: Date }>(
    "select definition, definition_digest, created_at, updated_at from harness_control.agent_registry order by updated_at desc",
  );
  return result.rows.map((row) => ({ agent: agentRegistrationSchema.parse(row.definition), digest: row.definition_digest, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }));
}

export async function getAuthoringAgent(db: Database, agentId: string): Promise<AgentRegistryRecord | null> {
  const result = await db.query<{ definition: unknown; definition_digest: string; created_at: Date; updated_at: Date }>(
    "select definition, definition_digest, created_at, updated_at from harness_control.agent_registry where agent_id=$1", [agentId],
  );
  const row = result.rows[0];
  return row ? { agent: agentRegistrationSchema.parse(row.definition), digest: row.definition_digest, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() } : null;
}

export async function registerAuthoringSkill(db: Database, input: unknown): Promise<{ created: boolean } & SkillRegistryRecord> {
  const skill = skillRegistrationSchema.parse(input);
  const digest = stableDigest(skill);
  const existing = await db.query("select 1 from harness_control.skill_registry where skill_id=$1", [skill.id]);
  const result = await db.query<{ created_at: Date; updated_at: Date }>(`
    insert into harness_control.skill_registry(skill_id, definition, definition_digest, status, source_type, source_url)
    values ($1,$2::jsonb,$3,$4,$5,$6)
    on conflict (skill_id) do update set definition=excluded.definition, definition_digest=excluded.definition_digest,
      status=excluded.status, source_type=excluded.source_type, source_url=excluded.source_url, updated_at=now()
    returning created_at, updated_at
  `, [skill.id, JSON.stringify(skill), digest, skill.status, skill.source.type, skill.source.url ?? null]);
  const row = result.rows[0];
  if (!row) throw new Error("authoring.skill_registration_failed");
  return { created: existing.rowCount === 0, skill, digest, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

export async function listAuthoringSkills(db: Database): Promise<SkillRegistryRecord[]> {
  const result = await db.query<{ definition: unknown; definition_digest: string; created_at: Date; updated_at: Date }>(
    "select definition, definition_digest, created_at, updated_at from harness_control.skill_registry order by updated_at desc",
  );
  return result.rows.map((row) => ({ skill: skillRegistrationSchema.parse(row.definition), digest: row.definition_digest, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() }));
}
