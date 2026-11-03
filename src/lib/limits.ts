import { headers } from "next/headers";
import type { Rpc } from "./payments/rpc";
import { limiterKey } from "./payments/tokens";

/** Best-effort client IP for rate limits (server components and actions). */
export async function requestIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

export function limiterSecret(): string {
  const s = process.env.RATE_LIMIT_SECRET;
  if (s && s.length >= 32) return s;
  if (process.env.NODE_ENV === "development") return "dev-only-limiter-secret-0123456789abcdef";
  throw new Error("RATE_LIMIT_SECRET must be set (32+ characters)");
}

/** True if this hit is within the limit. Keys are hashed, so no raw IP or email is stored. */
export async function withinLimit(rpc: Rpc, scope: string, value: string, max: number, window: string): Promise<boolean> {
  return rpc<boolean>("hit_rate_limit", { p_key: limiterKey(scope, value, limiterSecret()), p_max: max, p_window: window });
}
