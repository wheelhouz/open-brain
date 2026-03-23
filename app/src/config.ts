const requiredEnvVars = ["DATABASE_URL", "BRAIN_ACCESS_KEY", "OPENROUTER_API_KEY"] as const;
for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

export const config = {
  port: parseInt(process.env.PORT || "8420", 10),
  databaseUrl: process.env.DATABASE_URL!,
  brainAccessKey: process.env.BRAIN_ACCESS_KEY!,
  openrouterApiKey: process.env.OPENROUTER_API_KEY!,
  embeddingModel: process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small",
  extractionModel: process.env.EXTRACTION_MODEL || "openai/gpt-4o-mini",
  chatModel: process.env.CHAT_MODEL || "anthropic/claude-sonnet-4-6",
  maxContentLength: 50 * 1024, // 50KB
  entityFuzzyThreshold: parseFloat(process.env.ENTITY_FUZZY_THRESHOLD || "0.35"),
  factConfidenceThreshold: parseFloat(process.env.FACT_CONFIDENCE_THRESHOLD || "0.80"),
};
