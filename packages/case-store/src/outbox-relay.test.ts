import { describe, expect, it } from "vitest";
import type { CaseStore } from "./index.js";
import { drainOutbox, LoggingOutboxSink, type OutboxRecord, type OutboxSink } from "./outbox-relay.js";

type Statement = { text: string; values: unknown[] };

/** Records every statement so the claim/publish/mark ordering can be asserted. */
function store(rows: Record<string, unknown[]>): { store: CaseStore; statements: Statement[] } {
  const statements: Statement[] = [];
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      statements.push({ text, values });
      if (!text.includes("returning outbox.outbox_id")) return { rowCount: 0, rows: [] };
      const table = text.includes('"case_ledger"') ? "case" : "evidence";
      return { rowCount: (rows[table] ?? []).length, rows: rows[table] ?? [] };
    },
    release: () => {},
  };
  return {
    statements,
    store: {
      db: {
        connect: async () => client,
        query: async (text: string, values: unknown[] = []) => {
          statements.push({ text, values });
          return { rowCount: 0, rows: [] };
        },
      },
      schemas: { core: "case_core", ledger: "case_ledger", evidence: "evidence" },
    } as unknown as CaseStore,
  };
}

const row = (id: string) => ({
  outbox_id: id, tenant_id: "tenant_demo", case_id: "case_1",
  event_type: "SubjectAdded", classification: "CONFIDENTIAL", created_at: new Date("2026-01-01T00:00:00Z"),
});

describe("outbox relay", () => {
  it("claims, publishes, then marks delivered", async () => {
    const published: OutboxRecord[][] = [];
    const sink: OutboxSink = { name: "test", publish: async (records) => { published.push(records); } };
    const { store: subject, statements } = store({ case: [row("ob_1")] });
    const result = await drainOutbox(subject, sink);
    expect(result.published).toBe(1);
    expect(published[0]?.[0]).toMatchObject({ outboxId: "ob_1", source: "case", eventType: "SubjectAdded" });
    // Rows are claimed with skip locked so parallel relays cannot publish the same
    // event, and marked only after the sink accepted them.
    expect(statements.some((s) => s.text.includes("for update skip locked"))).toBe(true);
    const claimIndex = statements.findIndex((s) => s.text.includes("returning outbox.outbox_id"));
    const markIndex = statements.findIndex((s) => s.text.includes("set published_at = now()"));
    expect(markIndex).toBeGreaterThan(claimIndex);
  });

  it("carries identifiers and classification, not case content", async () => {
    // The relay hands a sink enough to route an event and nothing that would put case
    // payloads into a message bus or a log.
    const seen: OutboxRecord[] = [];
    const sink: OutboxSink = { name: "test", publish: async (records) => { seen.push(...records); } };
    await drainOutbox(store({ evidence: [row("ob_2")] }).store, sink);
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
      "caseId", "classification", "createdAt", "eventType", "outboxId", "source", "tenantId",
    ]);
  });

  it("leaves rows unmarked when the sink refuses them", async () => {
    const sink: OutboxSink = { name: "failing", publish: async () => { throw new Error("bus unavailable"); } };
    const { store: subject, statements } = store({ case: [row("ob_3")] });
    await expect(drainOutbox(subject, sink)).rejects.toThrow("bus unavailable");
    expect(statements.some((s) => s.text.includes("set published_at = now()"))).toBe(false);
    expect(statements.some((s) => s.text.includes("set publish_claim_id = null"))).toBe(true);
  });

  it("purges published rows only when a retention window is set", async () => {
    const sink = new LoggingOutboxSink(() => {});
    const withoutRetention = store({});
    await drainOutbox(withoutRetention.store, sink, { retentionDays: 0 });
    expect(withoutRetention.statements.some((s) => s.text.includes("delete from"))).toBe(false);

    const withRetention = store({});
    const result = await drainOutbox(withRetention.store, sink, { retentionDays: 7 });
    const deletes = withRetention.statements.filter((s) => s.text.includes("delete from"));
    // Both outboxes are aged out, and only rows already published are eligible.
    expect(deletes).toHaveLength(2);
    expect(deletes.every((s) => s.text.includes("published_at is not null"))).toBe(true);
    expect(deletes.every((s) => s.values[0] === 7)).toBe(true);
    expect(result.purged).toBe(0);
  });

  it("writes one bounded line per event through the default sink", async () => {
    const lines: string[] = [];
    const sink = new LoggingOutboxSink((line) => lines.push(line));
    await drainOutbox(store({ case: [row("ob_4")] }).store, sink);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      outbox: {
        outboxId: "ob_4", source: "case", tenantId: "tenant_demo", caseId: "case_1",
        eventType: "SubjectAdded", classification: "CONFIDENTIAL", createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
  });
});
