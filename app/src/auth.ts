import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

/**
 * Constant-time comparison of a candidate token against the configured access key.
 * Returns false for empty/missing tokens without leaking timing information.
 */
export function validateAccessKey(token: string): boolean {
  const expected = config.brainAccessKey;
  if (!token || !expected) return false;

  const a = Buffer.from(token);
  const b = Buffer.from(expected);

  if (a.length !== b.length) {
    // Compare against itself to burn constant time, then return false
    timingSafeEqual(b, b);
    return false;
  }

  return timingSafeEqual(a, b);
}
