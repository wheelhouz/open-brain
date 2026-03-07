import { Hono } from "hono";
import { query } from "../db.js";
import { config } from "../config.js";
import { openrouterRequest } from "../openrouter.js";

export const topicsRouter = new Hono();

topicsRouter.patch("/:name", async (c) => {
  const oldName = c.req.param("name").trim();
  const body = await c.req.json<{ name?: string }>();
  const newName = (body.name || "").trim();

  if (!oldName || !newName) return c.json({ error: "Both old and new name are required" }, 400);
  if (oldName === newName) return c.json({ error: "Names are the same" }, 400);

  const result = await query(
    `UPDATE thoughts
     SET metadata = jsonb_set(
       metadata, '{topics}',
       (SELECT jsonb_agg(DISTINCT val ORDER BY val)
        FROM jsonb_array_elements_text(
          (metadata->'topics') - $1 || jsonb_build_array($2::text)
        ) AS val)
     ), updated_at = now()
     WHERE metadata->'topics' ? $1 AND deleted_at IS NULL`,
    [oldName, newName],
  );

  return c.json({ renamed: true, from: oldName, to: newName, affected: result.rowCount || 0 });
});

topicsRouter.post("/analyze", async (c) => {
  const result = await query<{ topic: string; count: string }>(
    `SELECT topic, count(*) as count
     FROM thoughts t, jsonb_array_elements_text(t.metadata->'topics') as topic
     WHERE t.deleted_at IS NULL
     GROUP BY topic
     ORDER BY count DESC`,
  );

  const topics = result.rows.map((r) => ({ name: r.topic, count: parseInt(r.count, 10) }));
  if (topics.length < 2) return c.json({ clusters: [] });

  const topicList = topics.map((t) => `- "${t.name}" (${t.count} thoughts)`).join("\n");

  const prompt = `You are a tag cleanup assistant. Given the following list of tags (topics) and their usage counts, identify groups of tags that should be merged because they are duplicates or near-duplicates.

Look for:
- Case variants (e.g. "AI" and "ai")
- Abbreviations vs full names (e.g. "ML" and "machine learning")
- Plurals vs singulars (e.g. "API" and "APIs")
- Semantic near-duplicates (e.g. "dev ops" and "DevOps")

Rules:
- For each group, pick the best canonical name (prefer descriptive, commonly-used, higher-count names)
- Only include groups where you are confident the tags mean the same thing
- Do NOT merge tags that are related but distinct (e.g. "frontend" and "backend" are related but different)
- If no duplicates exist, return an empty clusters array

Tags:
${topicList}

Respond with JSON: { "clusters": [{ "canonical": "best name", "merge": ["tag1", "tag2"], "reason": "why these should merge" }] }
The "merge" array should contain the tags to be merged INTO the canonical name (do not include the canonical name itself in merge).`;

  const data = (await openrouterRequest("/chat/completions", {
    model: config.extractionModel,
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" },
    temperature: 0,
  })) as { choices: Array<{ message: { content: string } }> };

  const raw = JSON.parse(data.choices[0].message.content);
  const clusters = Array.isArray(raw.clusters)
    ? raw.clusters
        .filter(
          (cl: unknown): cl is { canonical: string; merge: string[]; reason: string } =>
            typeof cl === "object" &&
            cl !== null &&
            typeof (cl as Record<string, unknown>).canonical === "string" &&
            Array.isArray((cl as Record<string, unknown>).merge) &&
            (cl as { merge: unknown[] }).merge.length > 0,
        )
        .map((cl: { canonical: string; merge: string[]; reason?: string }) => ({
          canonical: cl.canonical,
          merge: cl.merge.filter((t: unknown) => typeof t === "string"),
          reason: cl.reason || "",
        }))
    : [];

  return c.json({ clusters });
});

topicsRouter.post("/merge", async (c) => {
  const body = await c.req.json<{ merges: Array<{ canonical: string; merge: string[] }> }>();
  if (!Array.isArray(body.merges)) return c.json({ error: "merges array required" }, 400);

  let applied = 0;
  let thoughtsUpdated = 0;

  for (const cluster of body.merges) {
    if (!cluster.canonical || !Array.isArray(cluster.merge)) continue;
    for (const oldName of cluster.merge) {
      if (!oldName || oldName === cluster.canonical) continue;
      const result = await query(
        `UPDATE thoughts
         SET metadata = jsonb_set(
           metadata, '{topics}',
           (SELECT jsonb_agg(DISTINCT val ORDER BY val)
            FROM jsonb_array_elements_text(
              (metadata->'topics') - $1 || jsonb_build_array($2::text)
            ) AS val)
         ), updated_at = now()
         WHERE metadata->'topics' ? $1 AND deleted_at IS NULL`,
        [oldName, cluster.canonical],
      );
      thoughtsUpdated += result.rowCount || 0;
      applied++;
    }
  }

  return c.json({ applied, thoughts_updated: thoughtsUpdated });
});

topicsRouter.get("/", async (c) => {
  const result = await query<{ topic: string; count: string; last_seen: string }>(
    `SELECT topic, count(*) as count, max(t.created_at) as last_seen
     FROM thoughts t, jsonb_array_elements_text(t.metadata->'topics') as topic
     WHERE t.deleted_at IS NULL
     GROUP BY topic
     ORDER BY count DESC`,
  );

  return c.json({
    topics: result.rows.map((r) => ({
      topic: r.topic,
      count: parseInt(r.count, 10),
      last_seen: r.last_seen,
    })),
  });
});
