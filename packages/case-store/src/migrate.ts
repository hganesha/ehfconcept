import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { caseStoreSchemas, renderMigration } from "./config.js";

const connectionString = process.env.CASE_DATABASE_URL ?? process.env.DATABASE_URL;
if (!connectionString) throw new Error("case_store.database_url_missing");

const database = new pg.Pool({ connectionString, max: 2 });
try {
  const directory = fileURLToPath(new URL("../migrations", import.meta.url));
  const migrations = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const schemas = caseStoreSchemas();
  for (const migration of migrations) {
    const source = await readFile(`${directory}/${migration}`, "utf8");
    await database.query(renderMigration(source, schemas));
  }
  process.stdout.write(`case-store migrations applied (${schemas.core}, ${schemas.ledger}, ${schemas.evidence})\n`);
} finally {
  await database.end();
}
