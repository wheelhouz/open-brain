import type { MiddlewareHandler } from "hono";
import crypto from "node:crypto";
import { logger } from "../logger.js";

export const requestLog: MiddlewareHandler = async (c, next) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  c.set("reqId", reqId);
  const start = Date.now();
  await next();
  const latencyMs = Date.now() - start;
  logger.info({
    event: "http_request",
    reqId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    latencyMs,
  });
};
