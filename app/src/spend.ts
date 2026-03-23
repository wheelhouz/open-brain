import { query } from "./db.js";
import { logger } from "./logger.js";
import { config } from "./config.js";

// Per-1K-token pricing (update as needed)
const MODEL_PRICING: Record<string, { prompt: number; completion: number }> = {
  "openai/text-embedding-3-small": { prompt: 0.00002, completion: 0 },
  "openai/gpt-4o-mini": { prompt: 0.00015, completion: 0.0006 },
  "anthropic/claude-sonnet-4-6": { prompt: 0.003, completion: 0.015 },
};

export function estimateCost(model: string, promptTokens: number, completionTokens: number): number {
  const pricing = MODEL_PRICING[model] || { prompt: 0.001, completion: 0.002 };
  return (promptTokens / 1000) * pricing.prompt + (completionTokens / 1000) * pricing.completion;
}

export interface UsageEvent {
  operation: string;
  model: string;
  source: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
}

export async function recordUsage(event: UsageEvent): Promise<void> {
  try {
    const cost = estimateCost(event.model, event.promptTokens, event.completionTokens);
    await query(
      `INSERT INTO ai_usage_log (operation, model, source, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd, latency_ms, success, error_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [event.operation, event.model, event.source, event.promptTokens, event.completionTokens, event.totalTokens, cost, event.latencyMs, event.success, event.errorCode || null],
    );
  } catch (err) {
    // Fire-and-forget: never throw from spend tracking
    logger.warn({ event: "spend_record_failed", err: String(err) });
  }
}

export class BudgetExceededError extends Error {
  constructor(monthToDate: number, cutoff: number) {
    super(`AI budget exceeded: $${monthToDate.toFixed(4)} / $${cutoff.toFixed(2)} cutoff`);
    this.name = "BudgetExceededError";
  }
}

let cachedBudgetOk: { result: boolean; expiresAt: number } | null = null;

export async function checkBudget(): Promise<void> {
  if (config.spendHardCutoffUsd <= 0) return; // disabled

  const now = Date.now();
  if (cachedBudgetOk && now < cachedBudgetOk.expiresAt) {
    if (!cachedBudgetOk.result) {
      throw new BudgetExceededError(0, config.spendHardCutoffUsd);
    }
    return;
  }

  const result = await query<{ total: string }>(
    `SELECT COALESCE(SUM(estimated_cost_usd), 0) as total FROM ai_usage_log WHERE created_at >= date_trunc('month', now())`,
  );
  const monthToDate = parseFloat(result.rows[0].total);
  const ok = monthToDate < config.spendHardCutoffUsd;

  cachedBudgetOk = { result: ok, expiresAt: now + 60_000 }; // 60s cache

  if (!ok) {
    logger.warn({ event: "budget_exceeded", monthToDate, cutoff: config.spendHardCutoffUsd });
    throw new BudgetExceededError(monthToDate, config.spendHardCutoffUsd);
  }
}
