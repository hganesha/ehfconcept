import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./index.js";

const database = createDatabase();
try {
  const migrationDirectory = fileURLToPath(new URL("../migrations", import.meta.url));
  const migrations = (await readdir(migrationDirectory)).filter((name) => name.endsWith(".sql")).sort();
  for (const migration of migrations) {
    await database.query(await readFile(`${migrationDirectory}/${migration}`, "utf8"));
  }
  process.stdout.write("database migrations applied\n");
} finally {
  await database.end();
}
