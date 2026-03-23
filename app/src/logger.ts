import pino from "pino";
import { createRequire } from "node:module";

function hasPinoPretty(): boolean {
  try {
    const require = createRequire(import.meta.url);
    require.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  ...(hasPinoPretty() ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
});
