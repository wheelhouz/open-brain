import type { MiddlewareHandler } from "hono";
import crypto from "node:crypto";
import { logger } from "../logger.js";
import { httpRequestsTotal, httpDuration } from "../metrics.js";

export const requestLog: MiddlewareHandler = async (c, next) => {
  const reqId = crypto.randomUUID().slice(0, 8);
  c.set("reqId", reqId);
  const start = Date.now();
  await next();
  const latencyMs = Date.now() - start;
  const routeLabel = c.req.routePath || c.req.path;
  logger.info({
    event: "http_request",
    reqId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    latencyMs,
  });
  httpRequestsTotal.inc({ method: c.req.method, route: routeLabel, status: String(c.res.status) });
  httpDuration.observe({ method: c.req.method, route: routeLabel }, latencyMs);
};
