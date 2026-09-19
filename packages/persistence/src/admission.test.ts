import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPlanSchema, type HarnessPlan } from "@ehf/contracts";
import { admitPlan, type Database } from "./index.js";

function fixturePlan(): HarnessPlan {
  return harnessPlanSchema.parse(JSON.parse(readFileSync(
    new URL("../../contracts/test-fixtures/cross-compiler.plan.json", import.meta.url),
    "utf8",
  )));
}

function recordingDatabase(): { db: Database; queries: unknown[] } {
  const queries: unknown[] = [];
  const db = {
    query: async (text: unknown) => {
      queries.push(text);
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Database;
  return { db, queries };
}

describe("plan admission", () => {
  it("admits a plan whose content matches its digest", async () => {
    const { db, queries } = recordingDatabase();
    const result = await admitPlan(db, fixturePlan());
    expect(result.created).toBe(true);
    expect(queries).toHaveLength(1);
  });

  it("rejects a tampered plan before touching the database", async () => {
    const { db, queries } = recordingDatabase();
    const tampered = { ...fixturePlan(), budgets: { ...fixturePlan().budgets, maxCostUsd: 999 } };
    await expect(admitPlan(db, tampered)).rejects.toThrow("plan.digest_invalid");
    // The regression this guards: admission used to insert first and validate after,
    // which left an unverifiable plan admitted and executable behind a 400 response.
    expect(queries).toHaveLength(0);
  });
});
