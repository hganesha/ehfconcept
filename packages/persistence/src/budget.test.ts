import { describe, expect, it } from "vitest";
import { reserveCapabilityBudget, type Database } from "./index.js";

function capturing(rowCount: number): { db: Database; statements: Array<{ text: string; values: unknown[] }> } {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  return {
    statements,
    db: {
      query: async (text: string, values: unknown[]) => {
        statements.push({ text, values });
        return { rowCount, rows: [] };
      },
    } as unknown as Database,
  };
}

const budgets = { maxCapabilityCalls: 3, maxModelCalls: 1, maxCostUsd: 0.35 };

describe("capability budget reservation", () => {
  it("tests and increments the counters in one statement", async () => {
    // The gateway used to read the counters, decide, call the provider, and record usage
    // afterwards: two concurrent nodes both passed against the same stale counts.
    const { db, statements } = capturing(1);
    expect(await reserveCapabilityBudget(db, { runId: "RUN-1", modelCall: true, ...budgets })).toBe(true);
    const statement = statements[0]?.text ?? "";
    expect(statement).toContain("capability_calls = capability_calls + 1");
    expect(statement).toContain("capability_calls < $3");
    expect(statement).toContain("model_calls < $4");
    expect(statement).toContain("cost_usd < $5");
    expect(statements).toHaveLength(1);
  });

  it("reports denial when the statement matched no row", async () => {
    const { db } = capturing(0);
    expect(await reserveCapabilityBudget(db, { runId: "RUN-1", modelCall: false, ...budgets })).toBe(false);
  });

  it("only spends the model budget for model calls", async () => {
    const { db, statements } = capturing(1);
    await reserveCapabilityBudget(db, { runId: "RUN-1", modelCall: false, ...budgets });
    expect(statements[0]?.values[1]).toBe(false);
  });
});
