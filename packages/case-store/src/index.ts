import { createHash, randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { z } from "zod";
import { createPostgresAccessTokenProvider, isAzureMode } from "@ehf/identity";
import {
  stableDigest,
  type BusinessCommand,
  type CaseActor,
  type CreateKycCaseRequest,
  type KycCaseStatus,
  type RegisterEvidenceRequest,
} from "@ehf/contracts";
import { caseStoreSchemas, qualify, type CaseStoreSchemas } from "./config.js";

const { Pool } = pg;
export type CaseStoreDatabase = InstanceType<typeof Pool>;
export type Page<T> = { items: T[]; nextCursor: string | null };

function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { at?: unknown; id?: unknown };
    if (typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) || typeof value.id !== "string" || !value.id) throw new Error();
    return { at: value.at, id: value.id };
  } catch {
    throw new CaseStoreError("pagination.cursor_invalid", 400);
  }
}

function pageLimit(value: number | undefined, maximum = 200): number {
  const limit = value ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new CaseStoreError("pagination.limit_invalid", 400);
  }
  return limit;
}

export type CaseStore = {
  db: CaseStoreDatabase;
  schemas: CaseStoreSchemas;
  artifactBackend: "postgres";
  evidenceRequireScan: boolean;
  evidenceMaxBytes: number;
  ownsDatabase: boolean;
};

export class CaseStoreError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "CaseStoreError";
  }
}

export function createCaseStore(options: {
  db?: CaseStoreDatabase;
  connectionString?: string;
  schemas?: CaseStoreSchemas;
  artifactBackend?: string;
} = {}): CaseStore {
  const connectionString = options.connectionString ?? process.env.CASE_DATABASE_URL ?? process.env.DATABASE_URL;
  const artifactBackend = options.artifactBackend ?? process.env.CASE_ARTIFACT_BACKEND ?? "postgres";
  const evidenceMaxBytes = Number(process.env.CASE_EVIDENCE_MAX_BYTES ?? "1048576");
  if (artifactBackend !== "postgres") throw new Error(`case_store.artifact_backend_unsupported:${artifactBackend}`);
  if (!options.db && !connectionString) throw new Error("case_store.database_url_missing");
  if (!Number.isInteger(evidenceMaxBytes) || evidenceMaxBytes < 1) throw new Error("case_store.evidence_max_bytes_invalid");
  const poolMax = Number(process.env.DB_POOL_MAX ?? 5);
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 100) throw new Error("database.pool_max_invalid");
  const connectionTimeoutMillis = Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5_000);
  const idleTimeoutMillis = Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30_000);
  if (!Number.isInteger(connectionTimeoutMillis) || connectionTimeoutMillis < 100 || connectionTimeoutMillis > 120_000) {
    throw new Error("database.connect_timeout_invalid");
  }
  if (!Number.isInteger(idleTimeoutMillis) || idleTimeoutMillis < 1_000 || idleTimeoutMillis > 3_600_000) {
    throw new Error("database.idle_timeout_invalid");
  }
  return {
    db: options.db ?? new Pool({
      connectionString,
      max: poolMax,
      connectionTimeoutMillis,
      idleTimeoutMillis,
      ...(isAzureMode() ? { password: createPostgresAccessTokenProvider() } : {}),
    }),
    schemas: options.schemas ?? caseStoreSchemas(),
    artifactBackend,
    evidenceRequireScan: process.env.CASE_EVIDENCE_REQUIRE_SCAN === "true",
    evidenceMaxBytes,
    ownsDatabase: !options.db,
  };
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function normalizeDigest(value: string): string {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}

function contentDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredString(value: unknown, field: string): string {
  return z.string().min(1).parse(value, { error: () => `${field}.required` });
}

function optionalString(value: unknown): string | null {
  return value === undefined || value === null ? null : z.string().min(1).parse(value);
}

function stringArray(value: unknown, field: string, minimum = 0): string[] {
  return z.array(z.string().min(1)).min(minimum).parse(value, { error: () => `${field}.invalid` });
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value, { error: () => `${field}.invalid` });
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapDate(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type CaseRow = {
  tenant_id: string;
  case_id: string;
  case_type: string;
  schema_version: string;
  jurisdiction: string;
  status: KycCaseStatus;
  case_sequence: string | number;
  external_ref: string | null;
  policy_snapshot_digest: string;
  harness_plan_digest: string;
  classification: string;
  created_by: CaseActor;
  created_at: Date;
  updated_at: Date;
};

function mapCase(row: CaseRow) {
  return {
    tenantId: row.tenant_id,
    caseId: row.case_id,
    caseType: row.case_type,
    schemaVersion: row.schema_version,
    jurisdiction: row.jurisdiction,
    status: row.status,
    caseSequence: Number(row.case_sequence),
    externalRef: row.external_ref,
    policySnapshotDigest: row.policy_snapshot_digest,
    harnessPlanDigest: row.harness_plan_digest,
    classification: row.classification,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

type EventInput = {
  tenantId: string;
  caseId: string;
  sequence: number;
  eventType: string;
  eventSchema: string;
  occurredAt: string;
  recordedAt: string;
  actor: CaseActor;
  commandId: string;
  authority: Record<string, unknown>;
  payload: Record<string, unknown>;
  evidenceRefs: string[];
  previousEventDigest: string | null;
  classification: string;
};

async function appendCaseEvent(
  client: PoolClient,
  store: CaseStore,
  input: EventInput,
): Promise<{ eventId: string; eventDigest: string }> {
  const eventId = opaqueId("evt");
  const envelope = {
    eventId,
    tenantId: input.tenantId,
    caseId: input.caseId,
    caseSequence: input.sequence,
    eventType: input.eventType,
    eventSchema: input.eventSchema,
    occurredAt: input.occurredAt,
    recordedAt: input.recordedAt,
    actor: input.actor,
    commandRef: input.commandId,
    authority: input.authority,
    payload: input.payload,
    evidenceRefs: input.evidenceRefs,
    previousEventDigest: input.previousEventDigest,
  };
  const eventDigest = stableDigest(envelope);
  const events = qualify(store.schemas.ledger, "case_events");
  const heads = qualify(store.schemas.ledger, "event_chain_heads");
  const outbox = qualify(store.schemas.ledger, "outbox");
  await client.query(`
    insert into ${events}(
      tenant_id, case_id, case_sequence, event_id, event_type, event_schema,
      occurred_at, recorded_at, actor, command_id, authority, payload,
      evidence_refs, previous_event_digest, event_digest
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15)
  `, [
    input.tenantId, input.caseId, input.sequence, eventId, input.eventType, input.eventSchema,
    input.occurredAt, input.recordedAt, JSON.stringify(input.actor), input.commandId,
    JSON.stringify(input.authority), JSON.stringify(input.payload), JSON.stringify(input.evidenceRefs),
    input.previousEventDigest, eventDigest,
  ]);
  await client.query(`
    insert into ${heads}(tenant_id, case_id, case_sequence, event_digest, updated_at)
    values ($1,$2,$3,$4,$5)
    on conflict (tenant_id, case_id) do update
    set case_sequence = excluded.case_sequence, event_digest = excluded.event_digest, updated_at = excluded.updated_at
  `, [input.tenantId, input.caseId, input.sequence, eventDigest, input.recordedAt]);
  await client.query(`
    insert into ${outbox}(
      outbox_id, tenant_id, case_id, case_sequence, event_id, event_type,
      classification, payload, source_event_digest, created_at
    ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
  `, [
    opaqueId("outbox"), input.tenantId, input.caseId, input.sequence, eventId, input.eventType,
    input.classification, JSON.stringify({
      eventId,
      tenantId: input.tenantId,
      caseId: input.caseId,
      caseSequence: input.sequence,
      eventType: input.eventType,
      recordedAt: input.recordedAt,
      evidenceRefs: input.evidenceRefs,
    }), eventDigest, input.recordedAt,
  ]);
  return { eventId, eventDigest };
}

async function writeReceipt(
  client: PoolClient,
  store: CaseStore,
  input: {
    tenantId: string;
    caseId: string;
    commandId: string;
    commandType: string;
    idempotencyKey: string;
    requestDigest: string;
    sequence: number;
    identifiers: Record<string, string>;
    response: Record<string, unknown>;
    createdAt: string;
  },
): Promise<void> {
  const receipts = qualify(store.schemas.ledger, "command_receipts");
  await client.query(`
    insert into ${receipts}(
      tenant_id, case_id, command_id, command_type, idempotency_key, request_digest,
      outcome, accepted_sequence_from, accepted_sequence_to, created_identifiers,
      response, response_digest, created_at
    ) values ($1,$2,$3,$4,$5,$6,'ACCEPTED',$7,$7,$8::jsonb,$9::jsonb,$10,$11)
  `, [
    input.tenantId, input.caseId, input.commandId, input.commandType, input.idempotencyKey,
    input.requestDigest, input.sequence, JSON.stringify(input.identifiers), JSON.stringify(input.response),
    stableDigest(input.response), input.createdAt,
  ]);
}

export async function createKycCase(
  store: CaseStore,
  request: CreateKycCaseRequest,
  idempotencyKey: string,
): Promise<{ created: boolean; case: ReturnType<typeof mapCase>; eventId: string }> {
  if (!idempotencyKey) throw new CaseStoreError("case.idempotency_key_required", 400);
  const caseId = `case_${stableDigest({ tenantId: request.tenantId, idempotencyKey }).slice(0, 32)}`;
  const commandId = `cmd_${stableDigest({ caseId, idempotencyKey }).slice(0, 32)}`;
  const requestDigest = stableDigest(request);
  const cases = qualify(store.schemas.core, "cases");
  const receipts = qualify(store.schemas.ledger, "command_receipts");
  const client = await store.db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${request.tenantId}:${idempotencyKey}`]);
    const existingReceipt = await client.query<{ request_digest: string; response: { eventId: string } }>(`
      select request_digest, response from ${receipts}
      where tenant_id = $1 and case_id = $2 and idempotency_key = $3
    `, [request.tenantId, caseId, idempotencyKey]);
    if (existingReceipt.rows[0]) {
      if (existingReceipt.rows[0].request_digest !== requestDigest) {
        throw new CaseStoreError("case.idempotency_conflict", 409);
      }
      const row = await client.query<CaseRow>(`select * from ${cases} where tenant_id = $1 and case_id = $2`, [request.tenantId, caseId]);
      await client.query("commit");
      return { created: false, case: mapCase(row.rows[0]!), eventId: existingReceipt.rows[0].response.eventId };
    }

    const timestamp = nowIso();
    const inserted = await client.query<CaseRow>(`
      insert into ${cases}(
        tenant_id, case_id, case_type, schema_version, jurisdiction, status, case_sequence,
        external_ref, policy_snapshot_digest, harness_plan_digest, classification,
        created_by, created_at, updated_at
      ) values ($1,$2,$3,$4,$5,'INTAKE',1,$6,$7,$8,$9,$10::jsonb,$11,$11)
      returning *
    `, [
      request.tenantId, caseId, request.caseType, request.schemaVersion, request.jurisdiction,
      request.externalRef ?? null, normalizeDigest(request.policySnapshotDigest),
      normalizeDigest(request.harnessPlanDigest), request.classification, JSON.stringify(request.actor), timestamp,
    ]);
    const authority = {
      planDigest: normalizeDigest(request.harnessPlanDigest),
      policySnapshotDigest: normalizeDigest(request.policySnapshotDigest),
      permissionEnvelopeDigest: stableDigest({ action: "CreateCase", actor: request.actor }),
    };
    const event = await appendCaseEvent(client, store, {
      tenantId: request.tenantId,
      caseId,
      sequence: 1,
      eventType: "case.created",
      eventSchema: "kyc.case.created.v1",
      occurredAt: timestamp,
      recordedAt: timestamp,
      actor: request.actor,
      commandId,
      authority,
      payload: { caseType: request.caseType, jurisdiction: request.jurisdiction, status: "INTAKE" },
      evidenceRefs: [],
      previousEventDigest: null,
      classification: request.classification,
    });
    const response = { outcome: "ACCEPTED", caseId, caseSequence: 1, eventId: event.eventId };
    await writeReceipt(client, store, {
      tenantId: request.tenantId,
      caseId,
      commandId,
      commandType: "CreateCase",
      idempotencyKey,
      requestDigest,
      sequence: 1,
      identifiers: { caseId, eventId: event.eventId },
      response,
      createdAt: timestamp,
    });
    await client.query("commit");
    return { created: true, case: mapCase(inserted.rows[0]!), eventId: event.eventId };
  } catch (error) {
    await client.query("rollback");
    if (error instanceof CaseStoreError) throw error;
    if (error instanceof Error && "code" in error && error.code === "23505") {
      throw new CaseStoreError("case.conflict", 409, { constraint: String((error as { constraint?: string }).constraint ?? "unique") });
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function registerEvidence(
  store: CaseStore,
  request: RegisterEvidenceRequest,
  idempotencyKey: string,
): Promise<{ created: boolean; evidence: Record<string, unknown> }> {
  if (!idempotencyKey) throw new CaseStoreError("evidence.idempotency_key_required", 400);
  const cases = qualify(store.schemas.core, "cases");
  const artifacts = qualify(store.schemas.evidence, "artifacts");
  const evidenceObjects = qualify(store.schemas.evidence, "evidence_objects");
  const receipts = qualify(store.schemas.evidence, "registration_receipts");
  const evidenceOutbox = qualify(store.schemas.evidence, "outbox");
  const requestDigest = stableDigest(request);
  if (request.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.contentBase64)) {
    throw new CaseStoreError("evidence.content_invalid", 400);
  }
  const content = Buffer.from(request.contentBase64, "base64");
  if (content.length === 0) throw new CaseStoreError("evidence.content_invalid", 400);
  if (content.length > store.evidenceMaxBytes) {
    throw new CaseStoreError("evidence.content_too_large", 413, { maxBytes: store.evidenceMaxBytes });
  }
  const digest = contentDigest(content);
  if (request.declaredDigest && normalizeDigest(request.declaredDigest) !== digest) {
    throw new CaseStoreError("evidence.digest_mismatch", 400, { computedDigest: digest });
  }
  const evidenceId = opaqueId("ev");
  const tenantPartition = stableDigest(request.tenantId).slice(0, 16);
  const artifactRef = `artifact://postgres/${tenantPartition}/sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
  const timestamp = nowIso();
  const client = await store.db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${request.tenantId}:${idempotencyKey}`]);
    const prior = await client.query<{ request_digest: string; response: { evidence: Record<string, unknown> } }>(`
      select request_digest, response from ${receipts} where tenant_id = $1 and idempotency_key = $2
    `, [request.tenantId, idempotencyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_digest !== requestDigest) throw new CaseStoreError("evidence.idempotency_conflict", 409);
      await client.query("commit");
      return { created: false, evidence: prior.rows[0].response.evidence };
    }
    const caseResult = await client.query(`select 1 from ${cases} where tenant_id = $1 and case_id = $2`, [request.tenantId, request.caseId]);
    if (!caseResult.rows[0]) throw new CaseStoreError("case.not_found", 404);
    await client.query(`
      insert into ${artifacts}(
        tenant_id, artifact_digest, artifact_ref, backend, media_type, byte_length,
        content, encryption_metadata, immutability_state, created_at
      ) values ($1,$2,$3,'postgres',$4,$5,$6,$7::jsonb,'POC_CONTENT_ADDRESSED',$8)
      on conflict (tenant_id, artifact_digest) do nothing
    `, [request.tenantId, digest, artifactRef, request.mediaType, content.length, content, JSON.stringify({ atRest: "database-managed" }), timestamp]);
    await client.query(`
      insert into ${evidenceObjects}(
        tenant_id, case_id, evidence_id, schema_version, evidence_type, source,
        subject_refs, trust, raw_digest, artifact_ref, classification, retention_class,
        residency, scan_status, verification_status, created_by, created_at
      ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,'POC_NOT_SCANNED','DIGEST_VERIFIED',$14::jsonb,$15)
    `, [
      request.tenantId, request.caseId, evidenceId, request.schemaVersion, request.type,
      JSON.stringify(request.source), JSON.stringify(request.subjectRefs), JSON.stringify(request.trust),
      digest, artifactRef, request.classification, request.retentionClass, request.residency,
      JSON.stringify(request.createdBy), timestamp,
    ]);
    const response = {
      created: true,
      evidence: {
        evidenceId,
        tenantId: request.tenantId,
        caseId: request.caseId,
        schemaVersion: request.schemaVersion,
        type: request.type,
        source: request.source,
        subjectRefs: request.subjectRefs,
        trust: request.trust,
        integrity: { rawDigest: digest, normalizedDigest: null, artifactRef },
        classification: request.classification,
        retentionClass: request.retentionClass,
        residency: request.residency,
        scanStatus: "POC_NOT_SCANNED",
        verificationStatus: "DIGEST_VERIFIED",
        createdBy: request.createdBy,
        createdAt: timestamp,
      },
    };
    await client.query(`
      insert into ${receipts}(
        tenant_id, idempotency_key, request_digest, evidence_id, response, response_digest, created_at
      ) values ($1,$2,$3,$4,$5::jsonb,$6,$7)
    `, [request.tenantId, idempotencyKey, requestDigest, evidenceId, JSON.stringify(response), stableDigest(response), timestamp]);
    await client.query(`
      insert into ${evidenceOutbox}(
        outbox_id, tenant_id, case_id, evidence_id, event_type, classification, payload, created_at
      ) values ($1,$2,$3,$4,'evidence.registered',$5,$6::jsonb,$7)
    `, [
      opaqueId("outbox"), request.tenantId, request.caseId, evidenceId, request.classification,
      JSON.stringify({ evidenceId, caseId: request.caseId, rawDigest: digest, artifactRef, verificationStatus: "DIGEST_VERIFIED" }), timestamp,
    ]);
    await client.query("commit");
    return response;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

type MutationResult = {
  eventType: string;
  eventSchema: string;
  payload: Record<string, unknown>;
  evidenceRefs: string[];
  identifiers: Record<string, string>;
  nextStatus?: KycCaseStatus;
  lineage?: Array<{ sourceType: string; sourceId: string; predicate: string; targetType: string; targetId: string }>;
};

const allowedTransitions: Record<KycCaseStatus, KycCaseStatus[]> = {
  INTAKE: ["VALIDATING", "NEEDS_INFORMATION", "SUSPENDED"],
  VALIDATING: ["SCREENING", "NEEDS_INFORMATION", "SUSPENDED"],
  SCREENING: ["INVESTIGATING", "READY_FOR_DECISION", "NEEDS_INFORMATION", "SUSPENDED"],
  INVESTIGATING: ["SCREENING", "READY_FOR_DECISION", "NEEDS_INFORMATION", "HUMAN_REVIEW", "SUSPENDED"],
  READY_FOR_DECISION: ["QA_REVIEW", "HUMAN_REVIEW", "INVESTIGATING", "SUSPENDED"],
  QA_REVIEW: ["HUMAN_REVIEW", "READY_FOR_DECISION", "INVESTIGATING", "SUSPENDED"],
  HUMAN_REVIEW: ["APPROVED", "DECLINED", "INVESTIGATING", "NEEDS_INFORMATION", "SUSPENDED"],
  NEEDS_INFORMATION: ["VALIDATING", "SCREENING", "INVESTIGATING", "SUSPENDED"],
  SUSPENDED: ["VALIDATING", "SCREENING", "INVESTIGATING", "HUMAN_REVIEW", "CLOSED"],
  APPROVED: ["CLOSED"],
  DECLINED: ["CLOSED"],
  CLOSED: [],
};

async function applyMutation(
  client: PoolClient,
  store: CaseStore,
  command: BusinessCommand,
  current: CaseRow,
): Promise<MutationResult> {
  const core = store.schemas.core;
  const evidenceSchema = store.schemas.evidence;
  const p = command.payload;
  const timestamp = nowIso();
  const classification = optionalString(p.classification) ?? current.classification;

  switch (command.commandType) {
    case "AddSubject": {
      const subjectId = optionalString(p.subjectId) ?? opaqueId("subject");
      const subjectType = z.enum(["individual", "legal_entity"]).parse(p.subjectType);
      const attributes = objectValue(p.attributes ?? {}, "attributes");
      const identifiers = z.array(z.object({
        identifierType: z.string().min(1),
        value: z.string().min(1),
        maskedValue: z.string().optional(),
        source: z.string().min(1),
        classification: z.string().min(1).optional(),
      }).strict()).default([]).parse(p.identifiers);
      await client.query(`
        insert into ${qualify(core, "case_subjects")}(
          tenant_id, case_id, subject_id, subject_type, schema_version, display_name,
          attributes, classification, created_by, created_at, updated_at
        ) values ($1,$2,$3,$4,'kyc.subject.v1',$5,$6::jsonb,$7,$8::jsonb,$9,$9)
      `, [command.tenantId, command.caseId, subjectId, subjectType, optionalString(p.displayName), JSON.stringify(attributes), classification, JSON.stringify(command.actor), timestamp]);
      for (const identifier of identifiers) {
        await client.query(`
          insert into ${qualify(core, "case_subject_identifiers")}(
            tenant_id, case_id, subject_id, identifier_id, identifier_type, value_digest,
            masked_value, source, classification, created_by, created_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
        `, [
          command.tenantId, command.caseId, subjectId, opaqueId("identifier"), identifier.identifierType,
          stableDigest(identifier.value), identifier.maskedValue ?? null, identifier.source,
          identifier.classification ?? classification, JSON.stringify(command.actor), timestamp,
        ]);
      }
      return {
        eventType: "subject.created",
        eventSchema: "kyc.subject.created.v1",
        payload: { subjectId, subjectType, revision: 1, identifierCount: identifiers.length },
        evidenceRefs: [],
        identifiers: { subjectId },
      };
    }
    case "LinkEvidence": {
      const evidenceId = requiredString(p.evidenceId, "evidenceId");
      const evidence = await client.query<{ verification_status: string; scan_status: string }>(`
        select verification_status, scan_status from ${qualify(evidenceSchema, "evidence_objects")}
        where tenant_id = $1 and case_id = $2 and evidence_id = $3
      `, [command.tenantId, command.caseId, evidenceId]);
      if (!evidence.rows[0]) throw new CaseStoreError("evidence.not_found", 404);
      if (evidence.rows[0].verification_status !== "DIGEST_VERIFIED") throw new CaseStoreError("evidence.not_verified", 409);
      if (store.evidenceRequireScan && evidence.rows[0].scan_status !== "VERIFIED_CLEAN") {
        throw new CaseStoreError("evidence.scan_required", 409);
      }
      await client.query(`
        insert into ${qualify(core, "case_evidence_refs")}(
          tenant_id, case_id, evidence_id, purpose, status, linked_by, linked_at
        ) values ($1,$2,$3,$4,'ACCEPTED',$5::jsonb,$6)
        on conflict (tenant_id, case_id, evidence_id) do nothing
      `, [command.tenantId, command.caseId, evidenceId, requiredString(p.purpose, "purpose"), JSON.stringify(command.actor), timestamp]);
      return {
        eventType: "evidence.linked",
        eventSchema: "kyc.evidence.linked.v1",
        payload: { evidenceId, purpose: p.purpose, status: "ACCEPTED" },
        evidenceRefs: [evidenceId],
        identifiers: { evidenceId },
      };
    }
    case "ProposeClaim": {
      const claimId = optionalString(p.claimId) ?? opaqueId("claim");
      const evidenceRefs = stringArray(p.evidenceRefs ?? [], "evidenceRefs", 1);
      await ensureLinkedEvidence(client, store, command, evidenceRefs);
      await client.query(`
        insert into ${qualify(core, "case_claims")}(
          tenant_id, case_id, claim_id, schema_version, subject_ref, predicate, value,
          asserted_by, evidence_refs, confidence, status, classification, created_at, updated_at
        ) values ($1,$2,$3,'harness.claim.v1',$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,'PROPOSED',$10,$11,$11)
      `, [
        command.tenantId, command.caseId, claimId, optionalString(p.subjectRef), requiredString(p.predicate, "predicate"),
        JSON.stringify(p.value), JSON.stringify(command.actor), JSON.stringify(evidenceRefs),
        JSON.stringify(p.confidence ?? null), classification, timestamp,
      ]);
      return {
        eventType: "claim.proposed",
        eventSchema: "kyc.claim.proposed.v1",
        payload: { claimId, predicate: p.predicate, subjectRef: p.subjectRef ?? null },
        evidenceRefs,
        identifiers: { claimId },
        lineage: evidenceRefs.map((evidenceId) => ({
          sourceType: "Evidence", sourceId: evidenceId, predicate: "ASSERTS", targetType: "Claim", targetId: claimId,
        })),
      };
    }
    case "AcceptClaimAsFact": {
      const claimRefs = stringArray(p.claimRefs, "claimRefs", 1);
      const claims = await client.query<{ claim_id: string; subject_ref: string | null; predicate: string; value: unknown }>(`
        select claim_id, subject_ref, predicate, value from ${qualify(core, "case_claims")}
        where tenant_id = $1 and case_id = $2 and claim_id = any($3::text[])
      `, [command.tenantId, command.caseId, claimRefs]);
      if (claims.rowCount !== claimRefs.length) throw new CaseStoreError("claim.not_found", 404);
      const source = claims.rows[0]!;
      const factId = optionalString(p.factId) ?? opaqueId("fact");
      await client.query(`
        insert into ${qualify(core, "case_facts")}(
          tenant_id, case_id, fact_id, schema_version, subject_ref, predicate, value,
          basis_claim_refs, acceptance_policy_ref, purpose, valid_from, valid_to,
          recorded_at, status, classification, created_by
        ) values ($1,$2,$3,'harness.fact.v1',$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,'ACTIVE',$13,$14::jsonb)
      `, [
        command.tenantId, command.caseId, factId, optionalString(p.subjectRef) ?? source.subject_ref,
        optionalString(p.predicate) ?? source.predicate, JSON.stringify(p.value ?? source.value), JSON.stringify(claimRefs),
        requiredString(p.acceptancePolicyRef, "acceptancePolicyRef"), requiredString(p.purpose, "purpose"),
        optionalString(p.validFrom), optionalString(p.validTo), timestamp, classification, JSON.stringify(command.actor),
      ]);
      await client.query(`
        update ${qualify(core, "case_claims")} set status = 'ACCEPTED', updated_at = $4
        where tenant_id = $1 and case_id = $2 and claim_id = any($3::text[])
      `, [command.tenantId, command.caseId, claimRefs, timestamp]);
      return {
        eventType: "claim.accepted_as_fact",
        eventSchema: "kyc.claim.accepted_as_fact.v1",
        payload: { factId, claimRefs, predicate: optionalString(p.predicate) ?? source.predicate },
        evidenceRefs: [],
        identifiers: { factId },
        lineage: claimRefs.map((claimId) => ({
          sourceType: "Claim", sourceId: claimId, predicate: "ACCEPTED_AS", targetType: "Fact", targetId: factId,
        })),
      };
    }
    case "RecordScreeningFinding": {
      const evidenceRefs = stringArray(p.evidenceRefs ?? [], "evidenceRefs");
      const factRefs = stringArray(p.factRefs ?? [], "factRefs");
      if (evidenceRefs.length + factRefs.length === 0) throw new CaseStoreError("finding.basis_required", 400);
      await ensureLinkedEvidence(client, store, command, evidenceRefs);
      const findingId = optionalString(p.findingId) ?? opaqueId("finding");
      await client.query(`
        insert into ${qualify(core, "case_findings")}(
          tenant_id, case_id, finding_id, schema_version, finding_type, subject_ref,
          classification, confidence, uncertainty, reason, evidence_refs, fact_refs,
          policy_relevance, status, created_by, created_at, updated_at
        ) values ($1,$2,$3,'kyc.finding.v1',$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11::jsonb,$12,'ACTIVE',$13::jsonb,$14,$14)
      `, [
        command.tenantId, command.caseId, findingId, requiredString(p.findingType, "findingType"),
        optionalString(p.subjectRef), classification, JSON.stringify(p.confidence ?? null),
        JSON.stringify(p.uncertainty ?? null), requiredString(p.reason, "reason"), JSON.stringify(evidenceRefs),
        JSON.stringify(factRefs), optionalString(p.policyRelevance), JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "finding.created",
        eventSchema: "kyc.finding.created.v1",
        payload: { findingId, classification: p.findingType, subjectRef: p.subjectRef ?? null },
        evidenceRefs,
        identifiers: { findingId },
        lineage: [
          ...evidenceRefs.map((evidenceId) => ({
            sourceType: "Evidence", sourceId: evidenceId, predicate: "SUPPORTS", targetType: "Finding", targetId: findingId,
          })),
          ...factRefs.map((factId) => ({
            sourceType: "Fact", sourceId: factId, predicate: "SUPPORTS", targetType: "Finding", targetId: findingId,
          })),
        ],
      };
    }
    case "RecordAssumption": {
      const assumptionId = optionalString(p.assumptionId) ?? opaqueId("assumption");
      await client.query(`
        insert into ${qualify(core, "case_assumptions")}(
          tenant_id, case_id, assumption_id, proposition, materiality, basis_refs,
          status, classification, created_by, created_at, updated_at
        ) values ($1,$2,$3,$4,$5,$6::jsonb,'UNVERIFIED',$7,$8::jsonb,$9,$9)
      `, [
        command.tenantId, command.caseId, assumptionId, requiredString(p.proposition, "proposition"),
        requiredString(p.materiality, "materiality"), JSON.stringify(stringArray(p.basisRefs ?? [], "basisRefs")),
        classification, JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "assumption.recorded",
        eventSchema: "kyc.assumption.recorded.v1",
        payload: { assumptionId, materiality: p.materiality },
        evidenceRefs: [],
        identifiers: { assumptionId },
      };
    }
    case "RaiseContradiction": {
      const contradictionId = optionalString(p.contradictionId) ?? opaqueId("contradiction");
      const objectRefs = stringArray(p.objectRefs, "objectRefs", 2);
      await client.query(`
        insert into ${qualify(core, "case_contradictions")}(
          tenant_id, case_id, contradiction_id, object_refs, description, materiality,
          detection_method, status, classification, created_by, created_at, updated_at
        ) values ($1,$2,$3,$4::jsonb,$5,$6,$7,'OPEN',$8,$9::jsonb,$10,$10)
      `, [
        command.tenantId, command.caseId, contradictionId, JSON.stringify(objectRefs),
        requiredString(p.description, "description"), requiredString(p.materiality, "materiality"),
        requiredString(p.detectionMethod, "detectionMethod"), classification, JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "contradiction.raised",
        eventSchema: "kyc.contradiction.raised.v1",
        payload: { contradictionId, objectRefs, materiality: p.materiality },
        evidenceRefs: [],
        identifiers: { contradictionId },
      };
    }
    case "ResolveContradiction": {
      const contradictionId = requiredString(p.contradictionId, "contradictionId");
      const status = z.enum(["RESOLVED", "ACCEPTED_RISK", "SUPERSEDED"]).parse(p.status);
      const result = await client.query(`
        update ${qualify(core, "case_contradictions")}
        set status = $4, resolution = $5::jsonb, updated_at = $6
        where tenant_id = $1 and case_id = $2 and contradiction_id = $3 and status in ('OPEN','UNDER_INVESTIGATION')
      `, [command.tenantId, command.caseId, contradictionId, status, JSON.stringify(objectValue(p.resolution, "resolution")), timestamp]);
      if (result.rowCount !== 1) throw new CaseStoreError("contradiction.not_open", 409);
      return {
        eventType: "contradiction.resolved",
        eventSchema: "kyc.contradiction.resolved.v1",
        payload: { contradictionId, status },
        evidenceRefs: stringArray(p.evidenceRefs ?? [], "evidenceRefs"),
        identifiers: { contradictionId },
      };
    }
    case "ProposeWorkItem": {
      const workItemId = optionalString(p.workItemId) ?? opaqueId("work");
      await client.query(`
        insert into ${qualify(core, "case_work_items")}(
          tenant_id, case_id, work_item_id, work_type, status, priority, assigned_to,
          required_capability, due_at, classification, created_by, created_at, updated_at
        ) values ($1,$2,$3,$4,'OPEN',$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$11)
      `, [
        command.tenantId, command.caseId, workItemId, requiredString(p.workType, "workType"),
        optionalString(p.priority) ?? "NORMAL", JSON.stringify(p.assignedTo ?? null), optionalString(p.requiredCapability),
        optionalString(p.dueAt), classification, JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "work_item.created",
        eventSchema: "harness.work_item.created.v1",
        payload: { workItemId, workType: p.workType, status: "OPEN" },
        evidenceRefs: [],
        identifiers: { workItemId },
      };
    }
    case "CompleteWorkItem": {
      const workItemId = requiredString(p.workItemId, "workItemId");
      const resultRefs = stringArray(p.resultRefs ?? [], "resultRefs");
      const result = await client.query(`
        update ${qualify(core, "case_work_items")}
        set status = 'COMPLETED', result_refs = $4::jsonb, updated_at = $5
        where tenant_id = $1 and case_id = $2 and work_item_id = $3 and status = 'OPEN'
      `, [command.tenantId, command.caseId, workItemId, JSON.stringify(resultRefs), timestamp]);
      if (result.rowCount !== 1) throw new CaseStoreError("work_item.not_open", 409);
      return {
        eventType: "work_item.completed",
        eventSchema: "harness.work_item.completed.v1",
        payload: { workItemId, resultRefs },
        evidenceRefs: [],
        identifiers: { workItemId },
      };
    }
    case "LinkExecution": {
      const runId = requiredString(p.runId, "runId");
      await client.query(`
        insert into ${qualify(core, "case_execution_refs")}(
          tenant_id, case_id, run_id, plan_digest, trace_id, purpose, linked_by, linked_at
        ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
        on conflict (tenant_id, case_id, run_id) do nothing
      `, [
        command.tenantId, command.caseId, runId, normalizeDigest(requiredString(p.planDigest, "planDigest")),
        optionalString(p.traceId), requiredString(p.purpose, "purpose"), JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "execution.linked",
        eventSchema: "harness.execution.linked.v1",
        payload: { runId, traceId: p.traceId ?? null, purpose: p.purpose },
        evidenceRefs: [],
        identifiers: { runId },
      };
    }
    case "SubmitDecisionRecommendation": {
      const recommendationId = optionalString(p.recommendationId) ?? opaqueId("recommendation");
      const findingRefs = stringArray(p.findingRefs ?? [], "findingRefs");
      const evidenceRefs = stringArray(p.evidenceRefs ?? [], "evidenceRefs");
      if (findingRefs.length + evidenceRefs.length === 0) throw new CaseStoreError("recommendation.basis_required", 400);
      await client.query(`
        insert into ${qualify(core, "case_decision_recommendations")}(
          tenant_id, case_id, recommendation_id, outcome, case_sequence, rationale,
          finding_refs, evidence_refs, policy_snapshot_digest, status, classification, created_by, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,'PROPOSED',$10,$11::jsonb,$12)
      `, [
        command.tenantId, command.caseId, recommendationId, z.enum(["APPROVE", "DECLINE", "REVIEW"]).parse(p.outcome),
        Number(current.case_sequence), requiredString(p.rationale, "rationale"), JSON.stringify(findingRefs),
        JSON.stringify(evidenceRefs), normalizeDigest(command.authority.policySnapshotDigest), classification,
        JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "decision.recommendation_submitted",
        eventSchema: "kyc.decision.recommendation_submitted.v1",
        payload: { recommendationId, outcome: p.outcome, basedOnSequence: Number(current.case_sequence) },
        evidenceRefs,
        identifiers: { recommendationId },
        lineage: findingRefs.map((findingId) => ({
          sourceType: "Finding", sourceId: findingId, predicate: "SUPPORTS", targetType: "DecisionRecommendation", targetId: recommendationId,
        })),
      };
    }
    case "RecordGateResult": {
      const gateResultId = optionalString(p.gateResultId) ?? opaqueId("gate");
      const recommendationRef = requiredString(p.recommendationRef, "recommendationRef");
      const recommendation = await client.query(`
        select 1 from ${qualify(core, "case_decision_recommendations")}
        where tenant_id = $1 and case_id = $2 and recommendation_id = $3
      `, [command.tenantId, command.caseId, recommendationRef]);
      if (!recommendation.rows[0]) throw new CaseStoreError("recommendation.not_found", 404);
      const decision = z.enum(["AUTHORIZED", "DENIED"]).parse(p.decision);
      await client.query(`
        insert into ${qualify(core, "case_gate_results")}(
          tenant_id, case_id, gate_result_id, recommendation_ref, decision, case_sequence,
          rule_results, policy_snapshot_digest, created_by, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10)
      `, [
        command.tenantId, command.caseId, gateResultId, recommendationRef, decision, Number(current.case_sequence),
        JSON.stringify(z.array(z.record(z.string(), z.unknown())).min(1).parse(p.ruleResults)),
        normalizeDigest(command.authority.policySnapshotDigest), JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "decision.gate_recorded",
        eventSchema: "kyc.decision.gate_recorded.v1",
        payload: { gateResultId, recommendationRef, decision, basedOnSequence: Number(current.case_sequence) },
        evidenceRefs: [],
        identifiers: { gateResultId },
        lineage: [{
          sourceType: "DecisionRecommendation", sourceId: recommendationRef, predicate: "EVALUATED_BY",
          targetType: "DecisionGateResult", targetId: gateResultId,
        }],
      };
    }
    case "RecordQAResult": {
      const qaResultId = optionalString(p.qaResultId) ?? opaqueId("qa");
      const recommendationRef = requiredString(p.recommendationRef, "recommendationRef");
      const recommendation = await client.query<{ created_by: CaseActor }>(`
        select created_by from ${qualify(core, "case_decision_recommendations")}
        where tenant_id = $1 and case_id = $2 and recommendation_id = $3
      `, [command.tenantId, command.caseId, recommendationRef]);
      if (!recommendation.rows[0]) throw new CaseStoreError("recommendation.not_found", 404);
      if (recommendation.rows[0].created_by.principalId === command.actor.principalId) {
        throw new CaseStoreError("qa.separation_of_duties_required", 403);
      }
      const outcome = z.enum(["PASS", "FAIL", "UNKNOWN", "ERROR"]).parse(p.outcome);
      await client.query(`
        insert into ${qualify(core, "case_reviews")}(
          tenant_id, case_id, review_id, review_type, outcome, object_ref, rationale,
          viewed_evidence_refs, reviewer, created_at
        ) values ($1,$2,$3,'SEMANTIC_QA',$4,$5,$6,$7::jsonb,$8::jsonb,$9)
      `, [
        command.tenantId, command.caseId, qaResultId, outcome, recommendationRef,
        requiredString(p.rationale, "rationale"), JSON.stringify(stringArray(p.evidenceRefs ?? [], "evidenceRefs")),
        JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "qa.result_recorded",
        eventSchema: "kyc.qa.result_recorded.v1",
        payload: { qaResultId, recommendationRef, outcome },
        evidenceRefs: stringArray(p.evidenceRefs ?? [], "evidenceRefs"),
        identifiers: { qaResultId },
      };
    }
    case "RecordReview": {
      const reviewId = optionalString(p.reviewId) ?? opaqueId("review");
      await client.query(`
        insert into ${qualify(core, "case_reviews")}(
          tenant_id, case_id, review_id, review_type, outcome, object_ref, rationale,
          viewed_evidence_refs, reviewer, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
      `, [
        command.tenantId, command.caseId, reviewId, requiredString(p.reviewType, "reviewType"),
        requiredString(p.outcome, "outcome"), requiredString(p.objectRef, "objectRef"),
        requiredString(p.rationale, "rationale"), JSON.stringify(stringArray(p.viewedEvidenceRefs ?? [], "viewedEvidenceRefs")),
        JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "review.recorded",
        eventSchema: "kyc.review.recorded.v1",
        payload: { reviewId, reviewType: p.reviewType, outcome: p.outcome, objectRef: p.objectRef },
        evidenceRefs: stringArray(p.viewedEvidenceRefs ?? [], "viewedEvidenceRefs"),
        identifiers: { reviewId },
      };
    }
    case "RequestHumanReview": {
      if (!allowedTransitions[current.status].includes("HUMAN_REVIEW")) {
        throw new CaseStoreError("case.transition_not_allowed", 409, { from: current.status, to: "HUMAN_REVIEW" });
      }
      const reviewRequestId = opaqueId("review_request");
      return {
        eventType: "human_review.requested",
        eventSchema: "kyc.human_review.requested.v1",
        payload: {
          reviewRequestId,
          objectRef: requiredString(p.objectRef, "objectRef"),
          reason: requiredString(p.reason, "reason"),
          priority: optionalString(p.priority) ?? "NORMAL",
        },
        evidenceRefs: stringArray(p.evidenceRefs ?? [], "evidenceRefs"),
        identifiers: { reviewRequestId },
        nextStatus: "HUMAN_REVIEW",
      };
    }
    case "TransitionCaseStatus": {
      const toStatus = z.enum([
        "INTAKE", "VALIDATING", "SCREENING", "INVESTIGATING", "READY_FOR_DECISION", "QA_REVIEW",
        "HUMAN_REVIEW", "NEEDS_INFORMATION", "SUSPENDED", "APPROVED", "DECLINED", "CLOSED",
      ]).parse(p.toStatus);
      if (!allowedTransitions[current.status].includes(toStatus)) {
        throw new CaseStoreError("case.transition_not_allowed", 409, { from: current.status, to: toStatus });
      }
      if (toStatus === "APPROVED" || toStatus === "DECLINED") {
        throw new CaseStoreError("case.disposition_command_required", 409);
      }
      return {
        eventType: "case.status_transitioned",
        eventSchema: "kyc.case.status_transitioned.v1",
        payload: { from: current.status, to: toStatus, reason: requiredString(p.reason, "reason") },
        evidenceRefs: [],
        identifiers: {},
        nextStatus: toStatus,
      };
    }
    case "FinalizeDisposition": {
      if (command.actor.type !== "HUMAN" || !command.actor.roles.some((role) => role === "KYC.Analyst" || role === "KYC.SeniorReviewer")) {
        throw new CaseStoreError("disposition.human_authority_required", 403);
      }
      if (current.status !== "HUMAN_REVIEW") throw new CaseStoreError("disposition.case_not_under_review", 409);
      const recommendationRef = requiredString(p.recommendationRef, "recommendationRef");
      const gateResultRef = requiredString(p.gateResultRef, "gateResultRef");
      const outcome = z.enum(["APPROVED", "DECLINED"]).parse(p.outcome);
      const gate = await client.query<{ decision: string; recommendation_ref: string }>(`
        select decision, recommendation_ref from ${qualify(core, "case_gate_results")}
        where tenant_id = $1 and case_id = $2 and gate_result_id = $3
      `, [command.tenantId, command.caseId, gateResultRef]);
      if (!gate.rows[0] || gate.rows[0].decision !== "AUTHORIZED" || gate.rows[0].recommendation_ref !== recommendationRef) {
        throw new CaseStoreError("disposition.gate_not_authorized", 409);
      }
      const openMaterial = await client.query(`
        select 1 from ${qualify(core, "case_contradictions")}
        where tenant_id = $1 and case_id = $2 and status in ('OPEN','UNDER_INVESTIGATION') and materiality in ('HIGH','MATERIAL') limit 1
      `, [command.tenantId, command.caseId]);
      if (openMaterial.rows[0]) throw new CaseStoreError("disposition.material_contradiction_open", 409);
      const dispositionId = optionalString(p.dispositionId) ?? opaqueId("disposition");
      await client.query(`
        insert into ${qualify(core, "case_final_dispositions")}(
          tenant_id, case_id, disposition_id, outcome, recommendation_ref, gate_result_ref,
          review_ref, policy_snapshot_digest, rationale, follow_up_obligations, status,
          effective_at, authorized_actor, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'EFFECTIVE',$11,$12::jsonb,$11)
      `, [
        command.tenantId, command.caseId, dispositionId, outcome, recommendationRef, gateResultRef,
        optionalString(p.reviewRef), normalizeDigest(command.authority.policySnapshotDigest),
        requiredString(p.rationale, "rationale"), JSON.stringify(p.followUpObligations ?? []), timestamp,
        JSON.stringify(command.actor),
      ]);
      return {
        eventType: "case.dispositioned",
        eventSchema: "kyc.case.dispositioned.v1",
        payload: { dispositionId, outcome, recommendationRef, gateResultRef, effectiveAt: timestamp },
        evidenceRefs: stringArray(p.evidenceRefs ?? [], "evidenceRefs"),
        identifiers: { dispositionId },
        nextStatus: outcome,
        lineage: [{
          sourceType: "DecisionGateResult", sourceId: gateResultRef, predicate: "AUTHORIZES",
          targetType: "FinalDisposition", targetId: dispositionId,
        }],
      };
    }
  }
}

async function ensureLinkedEvidence(
  client: PoolClient,
  store: CaseStore,
  command: BusinessCommand,
  evidenceRefs: string[],
): Promise<void> {
  if (evidenceRefs.length === 0) return;
  const result = await client.query<{ evidence_id: string }>(`
    select evidence_id from ${qualify(store.schemas.core, "case_evidence_refs")}
    where tenant_id = $1 and case_id = $2 and evidence_id = any($3::text[]) and status = 'ACCEPTED'
  `, [command.tenantId, command.caseId, evidenceRefs]);
  if (result.rowCount !== evidenceRefs.length) throw new CaseStoreError("evidence.not_linked", 409);
}

export async function submitBusinessCommand(
  store: CaseStore,
  command: BusinessCommand,
): Promise<Record<string, unknown>> {
  const cases = qualify(store.schemas.core, "cases");
  const heads = qualify(store.schemas.ledger, "event_chain_heads");
  const receipts = qualify(store.schemas.ledger, "command_receipts");
  const requestDigest = stableDigest(command);
  const client = await store.db.connect();
  try {
    await client.query("begin");
    const currentResult = await client.query<CaseRow>(`
      select * from ${cases} where tenant_id = $1 and case_id = $2 for update
    `, [command.tenantId, command.caseId]);
    const current = currentResult.rows[0];
    if (!current) throw new CaseStoreError("case.not_found", 404);

    const prior = await client.query<{ request_digest: string; response: Record<string, unknown> }>(`
      select request_digest, response from ${receipts}
      where tenant_id = $1 and case_id = $2 and idempotency_key = $3
    `, [command.tenantId, command.caseId, command.idempotencyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_digest !== requestDigest) throw new CaseStoreError("command.idempotency_conflict", 409);
      await client.query("commit");
      return { ...prior.rows[0].response, replayed: true };
    }
    if (command.preconditions.caseSequence !== Number(current.case_sequence)) {
      throw new CaseStoreError("command.case_sequence_conflict", 409, {
        expected: command.preconditions.caseSequence,
        current: Number(current.case_sequence),
      });
    }
    if (normalizeDigest(command.authority.planDigest) !== normalizeDigest(current.harness_plan_digest)) {
      throw new CaseStoreError("command.plan_authority_mismatch", 403);
    }
    if (normalizeDigest(command.authority.policySnapshotDigest) !== normalizeDigest(current.policy_snapshot_digest)) {
      throw new CaseStoreError("command.policy_authority_mismatch", 403);
    }

    let mutation: MutationResult;
    try {
      mutation = await applyMutation(client, store, command, current);
    } catch (error) {
      if (error instanceof CaseStoreError) throw error;
      if (error instanceof z.ZodError) throw new CaseStoreError("command.payload_invalid", 400, { issues: error.issues });
      throw error;
    }
    const sequence = Number(current.case_sequence) + 1;
    const recordedAt = nowIso();
    const head = await client.query<{ event_digest: string }>(`
      select event_digest from ${heads} where tenant_id = $1 and case_id = $2
    `, [command.tenantId, command.caseId]);
    const event = await appendCaseEvent(client, store, {
      tenantId: command.tenantId,
      caseId: command.caseId,
      sequence,
      eventType: mutation.eventType,
      eventSchema: mutation.eventSchema,
      occurredAt: command.occurredAt ?? recordedAt,
      recordedAt,
      actor: command.actor,
      commandId: command.commandId,
      authority: command.authority,
      payload: mutation.payload,
      evidenceRefs: mutation.evidenceRefs,
      previousEventDigest: head.rows[0]?.event_digest ?? null,
      classification: current.classification,
    });
    for (const edge of mutation.lineage ?? []) {
      await client.query(`
        insert into ${qualify(store.schemas.evidence, "lineage_edges")}(
          tenant_id, case_id, edge_id, source_type, source_id, predicate, predicate_version,
          target_type, target_id, creation_event_id, created_by, created_at
        ) values ($1,$2,$3,$4,$5,$6,'v1',$7,$8,$9,$10::jsonb,$11)
      `, [
        command.tenantId, command.caseId, opaqueId("edge"), edge.sourceType, edge.sourceId,
        edge.predicate, edge.targetType, edge.targetId, event.eventId, JSON.stringify(command.actor), recordedAt,
      ]);
    }
    await client.query(`
      update ${cases} set case_sequence = $3, status = coalesce($4, status), updated_at = $5
      where tenant_id = $1 and case_id = $2
    `, [command.tenantId, command.caseId, sequence, mutation.nextStatus ?? null, recordedAt]);
    const response = {
      outcome: "ACCEPTED",
      caseId: command.caseId,
      caseSequence: sequence,
      eventId: event.eventId,
      eventDigest: event.eventDigest,
      createdIdentifiers: mutation.identifiers,
    };
    await writeReceipt(client, store, {
      tenantId: command.tenantId,
      caseId: command.caseId,
      commandId: command.commandId,
      commandType: command.commandType,
      idempotencyKey: command.idempotencyKey,
      requestDigest,
      sequence,
      identifiers: mutation.identifiers,
      response,
      createdAt: recordedAt,
    });
    await client.query("commit");
    return response;
  } catch (error) {
    await client.query("rollback");
    if (error instanceof CaseStoreError) throw error;
    if (error instanceof Error && "code" in error && error.code === "23505") {
      throw new CaseStoreError("command.conflict", 409, { constraint: String((error as { constraint?: string }).constraint ?? "unique") });
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function listCases(
  store: CaseStore,
  input: { tenantId: string; status?: KycCaseStatus; limit?: number; cursor?: string },
) {
  return (await listCasesPage(store, input)).items;
}

export async function listCasesPage(
  store: CaseStore,
  input: { tenantId: string; status?: KycCaseStatus; limit?: number; cursor?: string },
): Promise<Page<ReturnType<typeof mapCase>>> {
  const limit = pageLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const result = await store.db.query<CaseRow>(`
    select * from ${qualify(store.schemas.core, "cases")}
    where tenant_id = $1 and ($2::text is null or status = $2)
      and ($3::timestamptz is null or (updated_at, case_id) < ($3::timestamptz, $4))
    order by updated_at desc, case_id desc limit $5
  `, [input.tenantId, input.status ?? null, cursor?.at ?? null, cursor?.id ?? "", limit + 1]);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map(mapCase),
    nextCursor: hasMore && last ? encodeCursor({ at: mapDate(last.updated_at)!, id: last.case_id }) : null,
  };
}

async function selectRows(store: CaseStore, schema: string, table: string, tenantId: string, caseId: string) {
  const result = await store.db.query<Record<string, unknown>>(`
    select * from ${qualify(schema, table)} where tenant_id = $1 and case_id = $2
  `, [tenantId, caseId]);
  return result.rows;
}

export async function getCaseView(store: CaseStore, tenantId: string, caseId: string) {
  const caseResult = await store.db.query<CaseRow>(`
    select * from ${qualify(store.schemas.core, "cases")} where tenant_id = $1 and case_id = $2
  `, [tenantId, caseId]);
  const caseRow = caseResult.rows[0];
  if (!caseRow) return null;
  const [subjects, evidence, claims, facts, findings, assumptions, contradictions, workItems, recommendations, gateResults, reviews, dispositions, executionRefs, lineageEdges] = await Promise.all([
    selectRows(store, store.schemas.core, "case_subjects", tenantId, caseId),
    selectRows(store, store.schemas.evidence, "evidence_objects", tenantId, caseId),
    selectRows(store, store.schemas.core, "case_claims", tenantId, caseId),
    selectRows(store, store.schemas.core, "case_facts", tenantId, caseId),
    selectRows(store, store.schemas.core, "case_findings", tenantId, caseId),
    selectRows(store, store.schemas.core, "case_assumptions", tenantId, caseId),
    selectRows(store, store.schemas.core, "case_contradictions", tenantId, caseId),
    selectRows(store, store.schemas.core, "case_work_items", tenantId, caseId),
    selectRows(store, store.schemas.core, "case_decision_recommendations", tenantId, caseId),
    selectRows(store, store.schemas.core, "case_gate_results", tenantId, caseId),
    selectRows(store, store.schemas.core, "case_reviews", tenantId, caseId),
    selectRows(store, store.schemas.core, "case_final_dispositions", tenantId, caseId),
    selectRows(store, store.schemas.core, "case_execution_refs", tenantId, caseId),
    selectRows(store, store.schemas.evidence, "lineage_edges", tenantId, caseId),
  ]);
  return {
    viewSchema: "kyc.case.operational-view.v1",
    generatedAt: nowIso(),
    etag: `W/\"${caseRow.case_id}:${caseRow.case_sequence}\"`,
    case: mapCase(caseRow),
    subjects,
    evidence: evidence.map(({ content: _content, ...item }) => item),
    claims,
    facts,
    findings,
    assumptions,
    contradictions,
    workItems,
    decisionRecommendations: recommendations,
    gateResults,
    reviews,
    finalDispositions: dispositions,
    executionRefs,
    lineageEdges,
  };
}

export async function listCaseEvents(store: CaseStore, tenantId: string, caseId: string, afterSequence = 0) {
  return (await listCaseEventsPage(store, tenantId, caseId, { afterSequence })).items;
}

export async function listCaseEventsPage(
  store: CaseStore,
  tenantId: string,
  caseId: string,
  options: { afterSequence?: number; limit?: number } = {},
): Promise<Page<{
  tenantId: string; caseId: string; caseSequence: number; eventId: string; eventType: string;
  eventSchema: string; occurredAt: string | null; recordedAt: string | null; actor: unknown;
  commandRef: string; authority: unknown; payload: unknown; evidenceRefs: string[];
  previousEventDigest: string | null; eventDigest: string;
}>> {
  const limit = pageLimit(options.limit, 1_000);
  const afterSequence = options.afterSequence ?? 0;
  if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new CaseStoreError("pagination.cursor_invalid", 400);
  const result = await store.db.query<{
    tenant_id: string; case_id: string; case_sequence: string | number; event_id: string; event_type: string;
    event_schema: string; occurred_at: Date; recorded_at: Date; actor: unknown; command_id: string;
    authority: unknown; payload: unknown; evidence_refs: string[]; previous_event_digest: string | null; event_digest: string;
  }>(`
    select * from ${qualify(store.schemas.ledger, "case_events")}
    where tenant_id = $1 and case_id = $2 and case_sequence > $3
    order by case_sequence limit $4
  `, [tenantId, caseId, afterSequence, limit + 1]);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const items = rows.map((row) => ({
    tenantId: row.tenant_id,
    caseId: row.case_id,
    caseSequence: Number(row.case_sequence),
    eventId: row.event_id,
    eventType: row.event_type,
    eventSchema: row.event_schema,
    occurredAt: mapDate(row.occurred_at),
    recordedAt: mapDate(row.recorded_at),
    actor: row.actor,
    commandRef: row.command_id,
    authority: row.authority,
    payload: row.payload,
    evidenceRefs: row.evidence_refs,
    previousEventDigest: row.previous_event_digest,
    eventDigest: row.event_digest,
  }));
  return { items, nextCursor: hasMore ? String(items.at(-1)?.caseSequence ?? afterSequence) : null };
}

export async function getEvidence(store: CaseStore, tenantId: string, evidenceId: string) {
  const result = await store.db.query<Record<string, unknown>>(`
    select e.*, a.media_type, a.byte_length, a.backend, a.immutability_state
    from ${qualify(store.schemas.evidence, "evidence_objects")} e
    join ${qualify(store.schemas.evidence, "artifacts")} a
      on a.tenant_id = e.tenant_id and a.artifact_ref = e.artifact_ref
    where e.tenant_id = $1 and e.evidence_id = $2
  `, [tenantId, evidenceId]);
  return result.rows[0] ?? null;
}

export async function verifyCaseLedger(store: CaseStore, tenantId: string, caseId: string) {
  const events = await listCaseEvents(store, tenantId, caseId);
  let previous: string | null = null;
  for (const event of events) {
    const envelope = {
      eventId: event.eventId,
      tenantId: event.tenantId,
      caseId: event.caseId,
      caseSequence: event.caseSequence,
      eventType: event.eventType,
      eventSchema: event.eventSchema,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
      actor: event.actor,
      commandRef: event.commandRef,
      authority: event.authority,
      payload: event.payload,
      evidenceRefs: event.evidenceRefs,
      previousEventDigest: event.previousEventDigest,
    };
    const expected = stableDigest(envelope);
    if (event.previousEventDigest !== previous || event.eventDigest !== expected) {
      return { valid: false, caseId, checkedEvents: events.length, failedSequence: event.caseSequence };
    }
    previous = event.eventDigest;
  }
  return { valid: true, caseId, checkedEvents: events.length, headDigest: previous };
}

export { caseStoreSchemas, type CaseStoreSchemas } from "./config.js";
