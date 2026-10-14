import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Constant-time token comparison. */
export function tokenMatches(given: string | null | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Token from `Authorization: Bearer …` or `?token=…`. */
export function requestToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, "").trim();
  try {
    const url = new URL(req.url ?? "/", "http://x");
    return url.searchParams.get("token");
  } catch {
    return null;
  }
}
