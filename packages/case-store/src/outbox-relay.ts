import { randomUUID } from "node:crypto";
import { qualify } from "./config.js";
import type { CaseStore } from "./index.js";

/**
 * A case or evidence event, ready to leave the transaction that produced it.
 *
 * Deliberately narrow: identifiers, a type and a classification. The payload stays in
 * the row so a sink that must not see case content never receives it.
 */
export type OutboxRecord = {
  outboxId: string;
  source: "case" | "evidence";
  tenantId: string;
  caseId: string;
  eventType: string;
  classification: string;
  createdAt: string;
};

/**
 * Where published events go.
 *
 * The outbox is the hand-off point for a message bus. Until one is configured the events
 * still have to leave the table, or the rows accumulate forever -- which is what they
 * were doing: written inside every case transaction and never read by anything.
 */
export interface OutboxSink {
  readonly name: string;
  publish(records: OutboxRecord[]): Promise<void>;
}

/**
 * Default sink: emit each event to the process log and consider it delivered.
 *
 * Minimal but real -- in Azure the container's stdout is collected into Log Analytics,
 * so the audit stream has somewhere to go. It is not a replacement for a bus, and the
 * interface exists so one can be dropped in without touching the case transaction.
 */
export class LoggingOutboxSink implements OutboxSink {
  readonly name = "log";

  constructor(private readonly write: (line: string) => void = (line) => process.stdout.write(line)) {}

  async publish(records: OutboxRecord[]): Promise<void> {
    for (const record of records) {
      this.write(`${JSON.stringify({ outbox: record })}\n`);
    }
  }
}

export type RelayOptions = {
  batchSize?: number;
  /** A crashed relay's claim becomes eligible again after this interval. */
  claimTimeoutMs?: number;
  /** Published rows older than this are removed; 0 keeps them indefinitely. */
  retentionDays?: number;
};

type Drained = { published: number; purged: number };

/**
 * Move one batch of unpublished events to the sink and mark them delivered.
 *
 * Claims rows with `for update skip locked` so several relays can run without
 * publishing the same event twice, and marks them only after the sink accepted them --
 * at-least-once, which is what the consumer side is expected to handle.
 */
export async function drainOutbox(
  store: CaseStore,
  sink: OutboxSink,
  options: RelayOptions = {},
): Promise<Drained> {
  const batchSize = Math.max(1, Math.min(500, options.batchSize ?? 100));
  const claimTimeoutSeconds = Math.max(5, Math.ceil((options.claimTimeoutMs ?? 300_000) / 1000));
  const caseOutbox = qualify(store.schemas.ledger, "outbox");
  const evidenceOutbox = qualify(store.schemas.evidence, "outbox");
  let published = 0;
  for (const [source, table] of [["case", caseOutbox], ["evidence", evidenceOutbox]] as const) {
    const claimId = randomUUID();
    const client = await store.db.connect();
    let records: OutboxRecord[] = [];
    try {
      await client.query("begin");
      const claimed = await client.query<{
        outbox_id: string; tenant_id: string; case_id: string;
        event_type: string; classification: string; created_at: Date;
      }>(`
        with candidates as (
          select outbox_id
          from ${table}
          where published_at is null
            and (publish_claimed_at is null or publish_claimed_at < now() - make_interval(secs => $3))
          order by created_at
          for update skip locked
          limit $1
        )
        update ${table} outbox
        set publish_claim_id = $2, publish_claimed_at = now(), publish_attempts = publish_attempts + 1
        from candidates
        where outbox.outbox_id = candidates.outbox_id
        returning outbox.outbox_id, outbox.tenant_id, outbox.case_id, outbox.event_type,
                  outbox.classification, outbox.created_at
      `, [batchSize, claimId, claimTimeoutSeconds]);
      if (!claimed.rows.length) {
        await client.query("commit");
        continue;
      }
      records = claimed.rows.map((row) => ({
        outboxId: row.outbox_id,
        source,
        tenantId: row.tenant_id,
        caseId: row.case_id,
        eventType: row.event_type,
        classification: row.classification,
        createdAt: row.created_at.toISOString(),
      }));
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    try {
      // Publishing happens after the claim transaction commits. A slow or unavailable
      // bus therefore cannot hold row locks or an open database transaction.
      await sink.publish(records);
      await store.db.query(`
        update ${table}
        set published_at = now(), publish_claim_id = null, publish_claimed_at = null
        where publish_claim_id = $1 and outbox_id = any($2::text[])
      `, [claimId, records.map((record) => record.outboxId)]);
      published += records.length;
    } catch (error) {
      await store.db.query(`
        update ${table}
        set publish_claim_id = null, publish_claimed_at = null
        where publish_claim_id = $1
      `, [claimId]).catch(() => { /* the claim timeout recovers if release also fails */ });
      throw error;
    }
  }
  const purged = options.retentionDays && options.retentionDays > 0
    ? await purgePublished(store, options.retentionDays)
    : 0;
  return { published, purged };
}

async function purgePublished(store: CaseStore, retentionDays: number): Promise<number> {
  let purged = 0;
  for (const table of [qualify(store.schemas.ledger, "outbox"), qualify(store.schemas.evidence, "outbox")]) {
    // The ledger itself is the durable record; a published outbox row is a delivery
    // receipt, not evidence, so it is safe to age out.
    const result = await store.db.query(`
      delete from ${table}
      where published_at is not null and published_at < now() - make_interval(days => $1)
    `, [retentionDays]);
    purged += result.rowCount ?? 0;
  }
  return purged;
}

export type OutboxRelay = { stop: () => void };

/** Run the relay on an interval until stopped. */
export function startOutboxRelay(
  store: CaseStore,
  sink: OutboxSink,
  options: RelayOptions & { intervalMs?: number; onError?: (error: unknown) => void } = {},
): OutboxRelay {
  const intervalMs = Math.max(250, options.intervalMs ?? 5_000);
  let draining = false;
  const timer = setInterval(() => {
    if (draining) return;
    draining = true;
    void drainOutbox(store, sink, options)
      .catch((error: unknown) => options.onError?.(error))
      .finally(() => { draining = false; });
  }, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}
