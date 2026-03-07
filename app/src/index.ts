import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { app } from "./app.js";
import { pool } from "./db.js";

async function initDb() {
  const sql = readFileSync("init.sql", "utf-8");
  await pool.query(sql);
  console.log("Database initialized");
}

await initDb();

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Open Brain listening on :${info.port}`);
});
