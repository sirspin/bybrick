import crypto from "node:crypto";
import type { NextRequest } from "next/server";

/** Best-effort client IP behind Vercel's proxy. Used only for rate limits and the bot check. */
export function clientIp(req: NextRequest): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  const first = fwd?.split(",")[0]?.trim();
  return first || req.headers.get("x-real-ip");
}

/** Parse a small JSON body. Anything oversized or malformed becomes an invalid-input error. */
export async function readJson(req: NextRequest, maxBytes = 10_000): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) throw Object.assign(new Error("too large"), { code: "invalid" });
  try { return JSON.parse(text); } catch { return null; }
}

/** Scheduled jobs must present CRON_SECRET as a bearer token (Vercel Cron sends it). */
export function isCronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return false;
  const given = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
