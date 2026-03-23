import { Hono } from "hono";
import { query } from "../db.js";
import { config } from "../config.js";

export const spendRouter = new Hono();

spendRouter.get("/summary", async (c) => {
  const [today, month, allTime] = await Promise.all([
    query<{ calls: string; tokens: string; usd: string }>(
      `SELECT count(*) as calls, COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(estimated_cost_usd), 0) as usd FROM ai_usage_log WHERE created_at >= CURRENT_DATE`
    ),
    query<{ calls: string; tokens: string; usd: string }>(
      `SELECT count(*) as calls, COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(estimated_cost_usd), 0) as usd FROM ai_usage_log WHERE created_at >= date_trunc('month', now())`
    ),
    query<{ calls: string; tokens: string; usd: string }>(
      `SELECT count(*) as calls, COALESCE(SUM(total_tokens), 0) as tokens, COALESCE(SUM(estimated_cost_usd), 0) as usd FROM ai_usage_log`
    ),
  ]);

  const format = (r: { calls: string; tokens: string; usd: string }) => ({
    calls: parseInt(r.calls),
    tokens: parseInt(r.tokens),
    estimated_usd: parseFloat(parseFloat(r.usd).toFixed(6)),
  });

  return c.json({
    today: format(today.rows[0]),
    this_month: format(month.rows[0]),
    all_time: format(allTime.rows[0]),
  });
});

spendRouter.get("/breakdown", async (c) => {
  const period = Math.min(parseInt(c.req.query("period") || "30"), 365);

  const [byOp, byModel, bySource, daily] = await Promise.all([
    query(
      `SELECT operation, count(*) as calls, SUM(total_tokens) as tokens, SUM(estimated_cost_usd) as usd
       FROM ai_usage_log WHERE created_at >= now() - interval '1 day' * $1
       GROUP BY operation ORDER BY usd DESC`,
      [period]
    ),
    query(
      `SELECT model, count(*) as calls, SUM(total_tokens) as tokens, SUM(estimated_cost_usd) as usd
       FROM ai_usage_log WHERE created_at >= now() - interval '1 day' * $1
       GROUP BY model ORDER BY usd DESC`,
      [period]
    ),
    query(
      `SELECT source, count(*) as calls, SUM(total_tokens) as tokens, SUM(estimated_cost_usd) as usd
       FROM ai_usage_log WHERE created_at >= now() - interval '1 day' * $1
       GROUP BY source ORDER BY usd DESC`,
      [period]
    ),
    query(
      `SELECT date_trunc('day', created_at)::date as date, count(*) as calls, SUM(total_tokens) as tokens, SUM(estimated_cost_usd) as usd
       FROM ai_usage_log WHERE created_at >= now() - interval '1 day' * $1
       GROUP BY 1 ORDER BY 1`,
      [period]
    ),
  ]);

  return c.json({
    period_days: period,
    by_operation: byOp.rows,
    by_model: byModel.rows,
    by_source: bySource.rows,
    daily: daily.rows,
  });
});

spendRouter.get("/budget", async (c) => {
  const result = await query<{ usd: string }>(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0) as usd FROM ai_usage_log WHERE created_at >= date_trunc('month', now())`
  );
  const monthToDate = parseFloat(result.rows[0].usd);
  const budget = config.monthlyBudgetUsd;
  const pctUsed = budget > 0 ? (monthToDate / budget) * 100 : 0;

  return c.json({
    monthly_budget_usd: budget,
    month_to_date_usd: parseFloat(monthToDate.toFixed(6)),
    percent_used: parseFloat(pctUsed.toFixed(1)),
    alert_threshold_pct: config.spendAlertThresholdPct,
    alert_triggered: budget > 0 && pctUsed >= config.spendAlertThresholdPct,
    hard_cutoff_usd: config.spendHardCutoffUsd,
  });
});
