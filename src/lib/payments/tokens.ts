import crypto from "node:crypto";

// Manage and action links carry a random token. Only its SHA-256 hash is stored, so a
// database leak does not give anyone working links. No email or pledge id in the URL.

export interface Token {
  /** URL-safe, 43 characters (32 random bytes). Goes in the emailed link only. */
  token: string;
  /** Hex of the SHA-256, written "\x..." so Postgres bytea accepts it over PostgREST. */
  hashParam: string;
}

export function newToken(): Token {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hashParam: hashToken(token) };
}

export function hashToken(token: string): string {
  return "\\x" + crypto.createHash("sha256").update(token).digest("hex");
}

/** Cheap shape check before touching the database. */
export function looksLikeToken(t: unknown): t is string {
  return typeof t === "string" && /^[A-Za-z0-9_-]{43}$/.test(t);
}

/** Hash an IP or email for rate-limit keys, so raw values never sit in the database. */
export function limiterKey(scope: string, value: string, secret: string): string {
  return `${scope}:` + crypto.createHmac("sha256", secret).update(value.trim().toLowerCase()).digest("hex").slice(0, 32);
}
