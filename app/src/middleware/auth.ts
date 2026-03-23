import type { MiddlewareHandler } from "hono";
import { validateAccessKey } from "../auth.js";

export const auth: MiddlewareHandler = async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token || !validateAccessKey(token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
};
