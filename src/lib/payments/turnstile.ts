// Cloudflare Turnstile server-side check. Fails closed: no secret, a network error or a
// malformed answer all count as "not verified".

export type Fetch = typeof fetch;

export async function verifyTurnstile(
  token: string, ip: string | null, secret: string | undefined, fetchImpl: Fetch = fetch,
): Promise<boolean> {
  if (!secret || !token) return false;
  try {
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set("remoteip", ip);
    const res = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", body, signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { success?: unknown };
    return json.success === true;
  } catch {
    return false;
  }
}
