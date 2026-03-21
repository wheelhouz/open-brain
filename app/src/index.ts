import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { app } from "./app.js";
import { pool } from "./db.js";
import { startEmbeddingWorker, scheduleBackfillSweep } from "./queue.js";

async function initDb() {
  const sql = readFileSync("init.sql", "utf-8");
  await pool.query(sql);
  console.log("Database initialized");

  const migrationsDir = join(process.cwd(), "migrations");
  try {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const migrationSql = readFileSync(join(migrationsDir, file), "utf-8");
      await pool.query(migrationSql);
      console.log(`Migration applied: ${file}`);
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("No migrations directory found, skipping");
    } else {
      throw e;
    }
  }
}

await initDb();
startEmbeddingWorker();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Open Brain listening on :${info.port}`);
  scheduleBackfillSweep();
});
