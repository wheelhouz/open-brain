import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { app } from "./app.js";
import { pool } from "./db.js";
import { logger } from "./logger.js";
import { startEmbeddingWorker, scheduleBackfillSweep } from "./queue.js";

async function initDb() {
  const sql = readFileSync("init.sql", "utf-8");
  await pool.query(sql);
  logger.info("Database initialized");

  const migrationsDir = join(process.cwd(), "migrations");
  try {
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    for (const file of files) {
      const migrationSql = readFileSync(join(migrationsDir, file), "utf-8");
      await pool.query(migrationSql);
      logger.info({ event: "migration_applied", file });
    }
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      logger.info("No migrations directory found, skipping");
    } else {
      throw e;
    }
  }
}

await initDb();

logger.info({
  event: "startup_config",
  port: config.port,
  embeddingModel: config.embeddingModel,
  extractionModel: config.extractionModel,
  chatModel: config.chatModel,
  maxContentLength: config.maxContentLength,
  databaseUrl: "***redacted***",
  brainAccessKey: "***redacted***",
  openrouterApiKey: "***redacted***",
});

startEmbeddingWorker();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info({ event: "server_started", port: info.port });
  scheduleBackfillSweep();
});
