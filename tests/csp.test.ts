import { describe, expect, it } from "vitest";
import { buildCsp } from "@/lib/csp";

describe("buildCsp", () => {
  const csp = buildCsp("abc123", { dev: false, supabaseUrl: "https://proj.supabase.co" });

  it("allows only our origin, Stripe, Turnstile and Supabase images", () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("https://js.stripe.com");
    expect(csp).toContain("https://challenges.cloudflare.com");
    expect(csp).toContain("img-src 'self' data: blob: https://proj.supabase.co");
  });

  it("blocks framing, plugins and base-tag injection", () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("uses the nonce and no unsafe-eval in production", () => {
    expect(csp).toContain("'nonce-abc123'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });

  it("allows unsafe-eval only in dev", () => {
    expect(buildCsp("n", { dev: true })).toContain("'unsafe-eval'");
  });
});
