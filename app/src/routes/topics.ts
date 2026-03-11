import { Hono } from "hono";
import { query } from "../db.js";
import { config } from "../config.js";
import { openrouterRequest, categorizeTopics, categorizeMissing } from "../openrouter.js";

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

  // Update topic_categories: if newName already has a row, just delete the old one;
  // otherwise rename the old row to the new topic name
  const existing = await query(`SELECT 1 FROM topic_categories WHERE topic = $1`, [newName]);
  if (existing.rows.length > 0) {
    await query(`DELETE FROM topic_categories WHERE topic = $1`, [oldName]);
  } else {
    await query(
      `UPDATE topic_categories SET topic = $2, updated_at = now() WHERE topic = $1`,
      [oldName, newName],
    );
  }

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

      // Remove merged topic from topic_categories
      await query(`DELETE FROM topic_categories WHERE topic = $1`, [oldName]);
    }
  }

  return c.json({ applied, thoughts_updated: thoughtsUpdated });
});

topicsRouter.get("/", async (c) => {
  const result = await query<{ topic: string; count: string; last_seen: string; category: string }>(
    `SELECT t.topic, t.count, t.last_seen, COALESCE(tc.category, 'Uncategorized') as category
     FROM (
       SELECT topic, count(*) as count, max(th.created_at) as last_seen
       FROM thoughts th, jsonb_array_elements_text(th.metadata->'topics') as topic
       WHERE th.deleted_at IS NULL
       GROUP BY topic
     ) t
     LEFT JOIN topic_categories tc ON tc.topic = t.topic
     ORDER BY tc.category, t.count DESC`,
  );

  const topics = result.rows.map((r) => ({
    topic: r.topic,
    count: parseInt(r.count, 10),
    last_seen: r.last_seen,
    category: r.category,
  }));

  const categories = [...new Set(topics.map((t) => t.category))].sort();

  return c.json({ topics, categories });
});

topicsRouter.post("/categorize", async (c) => {
  // Fetch all distinct topics
  const topicResult = await query<{ topic: string }>(
    `SELECT DISTINCT topic
     FROM thoughts t, jsonb_array_elements_text(t.metadata->'topics') as topic
     WHERE t.deleted_at IS NULL`,
  );

  const topics = topicResult.rows.map((r) => r.topic);
  if (topics.length === 0) return c.json({ categories: [], assigned: 0 });

  // Pass 1: bulk AI categorization
  const pass1 = await categorizeTopics(topics);

  // Pass 2: sweep stragglers
  const assignedInPass1 = new Set(pass1.flatMap((cat) => cat.topics));
  const missingTopics = topics.filter((t) => !assignedInPass1.has(t));

  let swept = 0;
  let allCategories = pass1;
  if (missingTopics.length > 0) {
    const pass1Names = pass1.map((cat) => cat.name);
    const pass2 = await categorizeMissing(missingTopics, pass1Names);

    // Merge pass 2 into pass 1 results
    const merged = new Map(pass1.map((cat) => [cat.name, [...cat.topics]]));
    for (const cat of pass2) {
      const existing = merged.get(cat.name);
      if (existing) {
        existing.push(...cat.topics);
      } else {
        merged.set(cat.name, [...cat.topics]);
      }
    }
    allCategories = [...merged.entries()].map(([name, topics]) => ({ name, topics }));
    swept = missingTopics.length;
  }

  // Delete all + insert complete set
  await query("DELETE FROM topic_categories");

  let assigned = 0;
  for (const cat of allCategories) {
    for (const topic of cat.topics) {
      await query(
        `INSERT INTO topic_categories (topic, category, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (topic) DO UPDATE SET category = $2, updated_at = now()`,
        [topic, cat.name],
      );
      assigned++;
    }
  }

  const categories = allCategories.map((cat) => cat.name).sort();
  return c.json({ categories, assigned, swept });
});
