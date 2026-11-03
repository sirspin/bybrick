import { z } from "zod";

// Server-only configuration. Fails closed: missing or inconsistent values stop payments
// instead of falling back to defaults.

export interface FeeConfig {
  /** Basis points of the charge (100 = 1%). */
  bps: number;
  /** Flat cents added per charge. */
  fixedCents: number;
}

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string | null;
  publishableKey: string | null;
  live: boolean;
  fee: FeeConfig;
  /** Public origin used for return URLs and domain registration, e.g. https://bybrick.example */
  siteUrl: string;
}

const schema = z.object({
  STRIPE_SECRET_KEY: z.string().regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, "STRIPE_SECRET_KEY looks wrong"),
  STRIPE_WEBHOOK_SECRET: z.string().regex(/^whsec_/).optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().regex(/^pk_(test|live)_/).optional(),
  // No defaults: the platform fee is a business decision, so it must be set on purpose.
  PLATFORM_FEE_BPS: z.coerce.number().int().min(0).max(2000),
  PLATFORM_FEE_FIXED_CENTS: z.coerce.number().int().min(0).max(500),
  NEXT_PUBLIC_SITE_URL: z.string().url(),
});

/**
 * Live Stripe keys are refused unless BOTH are true: the process is the production
 * deployment, and STRIPE_LIVE_MODE_APPROVED=yes was set on purpose. Test and live keys
 * must never mix: a publishable key must match the secret key's mode.
 */
export function loadStripeConfig(env: Record<string, string | undefined>): StripeConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Payment configuration is missing or invalid: ${fields}`);
  }
  const e = parsed.data;
  const live = /_live_/.test(e.STRIPE_SECRET_KEY);

  if (live && !(env.VERCEL_ENV === "production" && env.STRIPE_LIVE_MODE_APPROVED === "yes")) {
    throw new Error("Live Stripe keys are only allowed in the approved production environment");
  }
  if (e.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY && /_live_/.test(e.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) !== live) {
    throw new Error("Stripe publishable and secret keys are from different modes");
  }

  return {
    secretKey: e.STRIPE_SECRET_KEY,
    webhookSecret: e.STRIPE_WEBHOOK_SECRET ?? null,
    publishableKey: e.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? null,
    live,
    fee: { bps: e.PLATFORM_FEE_BPS, fixedCents: e.PLATFORM_FEE_FIXED_CENTS },
    siteUrl: e.NEXT_PUBLIC_SITE_URL.replace(/\/$/, ""),
  };
}
