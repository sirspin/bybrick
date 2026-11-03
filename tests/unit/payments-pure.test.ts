import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadStripeConfig } from "@/lib/payments/config";
import { applicationFeeCents } from "@/lib/payments/fees";
import { statementDescriptor } from "@/lib/payments/descriptor";
import { CONSENT_VERSION, consentText } from "@/lib/payments/consent";
import { hashToken, limiterKey, looksLikeToken, newToken } from "@/lib/payments/tokens";
import { verifyTurnstile } from "@/lib/payments/turnstile";
import { TEST_ENV } from "../helpers/payments";

describe("loadStripeConfig", () => {
  it("accepts a complete test-mode configuration", () => {
    const c = loadStripeConfig(TEST_ENV);
    expect(c).toMatchObject({ live: false, fee: { bps: 300, fixedCents: 0 }, siteUrl: "https://bybrick.test" });
  });

  it("fails closed when the platform fee is not set on purpose", () => {
    const { PLATFORM_FEE_BPS: _a, ...rest } = TEST_ENV;
    expect(() => loadStripeConfig(rest)).toThrow(/PLATFORM_FEE_BPS/);
    const { PLATFORM_FEE_FIXED_CENTS: _b, ...rest2 } = TEST_ENV;
    expect(() => loadStripeConfig(rest2)).toThrow(/PLATFORM_FEE_FIXED_CENTS/);
  });

  it("refuses a missing or malformed secret key, and never echoes it", () => {
    expect(() => loadStripeConfig({ ...TEST_ENV, STRIPE_SECRET_KEY: undefined })).toThrow(/STRIPE_SECRET_KEY/);
    try { loadStripeConfig({ ...TEST_ENV, STRIPE_SECRET_KEY: "sk_test_" + "a".repeat(5) + "!!" }); } catch (e) {
      expect(String(e)).not.toContain("aaaaa");
    }
  });

  it("refuses live keys outside the approved production environment", () => {
    const live = { ...TEST_ENV, STRIPE_SECRET_KEY: "sk_live_abc123", NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_abc" };
    expect(() => loadStripeConfig(live)).toThrow(/approved production/);
    expect(() => loadStripeConfig({ ...live, VERCEL_ENV: "production" })).toThrow(/approved production/);
    expect(() => loadStripeConfig({ ...live, STRIPE_LIVE_MODE_APPROVED: "yes" })).toThrow(/approved production/);
    expect(loadStripeConfig({ ...live, VERCEL_ENV: "production", STRIPE_LIVE_MODE_APPROVED: "yes" }).live).toBe(true);
  });

  it("refuses mixed test and live keys", () => {
    expect(() => loadStripeConfig({ ...TEST_ENV, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_live_abc" })).toThrow(/different modes/);
  });
});

describe("applicationFeeCents", () => {
  const fee = (bps: number, fixed = 0) => ({ bps, fixedCents: fixed });
  it("is a percentage plus a flat amount, rounded half up", () => {
    expect(applicationFeeCents(10000, fee(300))).toBe(300);
    expect(applicationFeeCents(10000, fee(300, 30))).toBe(330);
    expect(applicationFeeCents(1050, fee(300))).toBe(32); // 31.5 rounds up
    expect(applicationFeeCents(1000, fee(0))).toBe(0);
  });
  it("is always less than the charge and never more than half of it", () => {
    for (const c of [1, 2, 3, 50, 500, 12345]) {
      const f = applicationFeeCents(c, fee(2000, 500));
      expect(f).toBeLessThan(c);
      expect(f).toBeLessThanOrEqual(Math.floor(c / 2));
      expect(f).toBeGreaterThanOrEqual(0);
    }
  });
  it("rejects nonsense charges", () => {
    for (const bad of [0, -5, 1.5, NaN]) expect(() => applicationFeeCents(bad, fee(300))).toThrow(RangeError);
  });
});

describe("statementDescriptor", () => {
  it("turns BIRDY'S into BIRDYS (apostrophes are not allowed)", () => {
    expect(statementDescriptor("BIRDY'S")).toEqual({ descriptor: "BIRDYS", prefix: "BIRDYS" });
    expect(statementDescriptor("Birdy’s Picnic + Pantry")).toEqual({ descriptor: "BIRDYS PICNIC + PANTRY", prefix: "BIRDYS PIC" });
  });
  it("never produces a forbidden character, and respects length rules", () => {
    for (const name of [`A<b>"c"\\d*e'f gh`, "Café Zoë", "   spaced    out   name   "]) {
      const d = statementDescriptor(name)!;
      expect(d.descriptor).not.toMatch(/[<>\\'"*]/);
      expect(d.descriptor.length).toBeGreaterThanOrEqual(5);
      expect(d.descriptor.length).toBeLessThanOrEqual(22);
      expect(d.prefix.length).toBeGreaterThanOrEqual(2);
      expect(d.prefix.length).toBeLessThanOrEqual(10);
    }
    expect(statementDescriptor("Café Zoë")!.descriptor).toBe("CAFE ZOE");
  });
  it("returns null when nothing valid can be made", () => {
    for (const bad of ["", "ab", "12345", "''''''", "日本語の店"]) expect(statementDescriptor(bad), bad).toBeNull();
  });
});

describe("consent text", () => {
  const base = { legalName: "Birdy's LLC", itemName: "Reach-in cooler", amountCents: 5000, deadline: new Date("2027-03-15T18:00:00Z"), sendExtraToPool: false, descriptor: "BIRDYS" };

  it("covers the four things Stripe requires for charging later", () => {
    const t = consentText(base);
    expect(t).toMatch(/authorize Birdy's LLC to charge the payment method/); // agreement to initiate
    expect(t).toMatch(/won't be charged unless .* fully pledged by March 15, 2027/); // timing
    expect(t).toMatch(/charged only the amount needed/); // how the amount is determined
    expect(t).toMatch(/I can cancel/); // cancellation
    expect(t).toContain("$50");
    expect(t).toContain("BIRDYS");
  });

  it("discloses what happens to leftover money", () => {
    expect(consentText({ ...base, sendExtraToPool: true })).toMatch(/may be applied to other items/);
    expect(consentText(base)).toMatch(/the rest won't be charged/);
  });

  it("the pool version states an expiry", () => {
    const t = consentText({ ...base, itemName: null, deadline: null });
    expect(t).toMatch(/next 90 days/);
    expect(t).toMatch(/expires and I won't be charged/);
  });

  it("changing the wording requires a new version string", () => {
    const sample = [
      consentText(base), consentText({ ...base, sendExtraToPool: true }),
      consentText({ ...base, itemName: null, deadline: null }),
    ].join("\n---\n");
    const hash = crypto.createHash("sha256").update(sample).digest("hex");
    const pinned: Record<string, string> = {
      "v1-draft": "260cdee7d611fa056660b889217989b9b8c1891f787b5cd759b15b38b8a608b6",
    };
    expect(pinned[CONSENT_VERSION], `if you changed the wording, bump CONSENT_VERSION; current hash ${hash}`).toBe(hash);
  });
});

describe("tokens", () => {
  it("are 32 random bytes and only the hash is derivable from storage", () => {
    const a = newToken(), b = newToken();
    expect(a.token).toHaveLength(43);
    expect(a.token).not.toBe(b.token);
    expect(looksLikeToken(a.token)).toBe(true);
    expect(a.hashParam).toMatch(/^\\x[0-9a-f]{64}$/);
    expect(hashToken(a.token)).toBe(a.hashParam);
    expect(a.hashParam).not.toContain(a.token);
  });
  it("shape check rejects junk before any database lookup", () => {
    for (const bad of ["", "short", "x".repeat(44), "a/b".padEnd(43, "c"), 42, null, undefined]) expect(looksLikeToken(bad)).toBe(false);
  });
  it("limiter keys hide the raw value and ignore case", () => {
    const k = limiterKey("e", "Pat@X.test", "s".repeat(32));
    expect(k).toBe(limiterKey("e", "pat@x.test ", "s".repeat(32)));
    expect(k).not.toContain("pat");
    expect(k).not.toBe(limiterKey("e", "pat@x.test", "t".repeat(32)));
  });
});

describe("verifyTurnstile", () => {
  const ok = (success: boolean) => (async () => new Response(JSON.stringify({ success }), { status: 200 })) as typeof fetch;
  it("passes only when Cloudflare says success: true", async () => {
    expect(await verifyTurnstile("tok", "1.2.3.4", "secret", ok(true))).toBe(true);
    expect(await verifyTurnstile("tok", "1.2.3.4", "secret", ok(false))).toBe(false);
  });
  it("fails closed: no secret, no token, HTTP error, network error, junk answer", async () => {
    expect(await verifyTurnstile("tok", null, undefined, ok(true))).toBe(false);
    expect(await verifyTurnstile("", null, "secret", ok(true))).toBe(false);
    expect(await verifyTurnstile("tok", null, "secret", (async () => new Response("no", { status: 500 })) as typeof fetch)).toBe(false);
    expect(await verifyTurnstile("tok", null, "secret", (async () => { throw new Error("down"); }) as typeof fetch)).toBe(false);
    expect(await verifyTurnstile("tok", null, "secret", (async () => new Response("<html>", { status: 200 })) as typeof fetch)).toBe(false);
    expect(await verifyTurnstile("tok", null, "secret", (async () => new Response(JSON.stringify({ success: "true" }), { status: 200 })) as typeof fetch)).toBe(false);
  });
});
