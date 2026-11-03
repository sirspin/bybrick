// Content Security Policy builder. Pure function so it can be tested.
// Allowed origins: ours, Stripe (Payment Element), Cloudflare Turnstile,
// and Supabase Storage for images.

export function buildCsp(nonce: string, opts: { dev: boolean; supabaseUrl?: string }): string {
  const supabaseHost = opts.supabaseUrl ? new URL(opts.supabaseUrl).origin : "";
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      "https://js.stripe.com",
      "https://challenges.cloudflare.com",
      ...(opts.dev ? ["'unsafe-eval'"] : []),
    ],
    "style-src": ["'self'", `'nonce-${nonce}'`],
    // style="" attributes (accent color, progress bars). Attributes only, not <style> blocks.
    "style-src-attr": ["'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", ...(supabaseHost ? [supabaseHost] : [])],
    "font-src": ["'self'"],
    "connect-src": ["'self'", "https://api.stripe.com", "https://challenges.cloudflare.com"],
    "frame-src": [
      "https://js.stripe.com",
      "https://hooks.stripe.com",
      "https://challenges.cloudflare.com",
    ],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    ...(opts.dev ? {} : { "upgrade-insecure-requests": [] }),
  };
  return Object.entries(directives)
    .map(([k, v]) => (v.length ? `${k} ${v.join(" ")}` : k))
    .join("; ");
}
