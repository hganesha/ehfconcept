import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./index.js";

const database = createDatabase();
const client = await database.connect();
try {
  await client.query("select pg_advisory_lock(hashtext('ehf:persistence:migrations'))");
  await client.query("create schema if not exists harness_control");
  await client.query(`
    create table if not exists harness_control.schema_migrations (
      name text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
  const migrationDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
  const migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) {
    const source = await readFile(`${migrationDirectory}/${migration}`, "utf8");
    const checksum = createHash("sha256").update(source).digest("hex");
    const applied = await client.query<{ checksum: string }>(
      "select checksum from harness_control.schema_migrations where name = $1", [migration],
    );
    if (applied.rows[0]) {
      if (applied.rows[0].checksum !== checksum) throw new Error(`database.migration_changed:${migration}`);
      continue;
    }
    await client.query("begin");
    try {
      await client.query(source);
      await client.query("insert into harness_control.schema_migrations(name, checksum) values ($1, $2)", [migration, checksum]);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
  process.stdout.write("database migrations applied\n");
} finally {
  await client.query("select pg_advisory_unlock(hashtext('ehf:persistence:migrations'))").catch(() => undefined);
  client.release();
  await database.end();
}
