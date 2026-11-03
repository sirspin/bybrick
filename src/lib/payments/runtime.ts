import Stripe from "stripe";
import { loadStripeConfig } from "./config";
import type { Alerts, Deps, Mailer } from "./ports";
import { adminRpc } from "../supabase/admin";

// Builds the real dependencies from environment variables. SERVER ONLY.

// Placeholder until the email provider adapter exists. It sends nothing and logs only the
// template name, never an address or a link, because manage links are credentials.
const unsentMailer: Mailer = new Proxy({} as Mailer, {
  get: (_t, template: string) => async () => {
    console.warn(`[mail] not sent (no email provider configured): ${template}`);
  },
});

const logAlerts: Alerts = {
  async notify(subject, details) {
    console.error(`[alert] ${subject}`, details ?? {});
  },
};

let cached: Deps | null = null;

export function runtimeDeps(): Deps {
  if (typeof window !== "undefined") throw new Error("payment runtime must not run in the browser");
  if (cached) return cached;
  const cfg = loadStripeConfig(process.env);
  const limiterSecret = process.env.RATE_LIMIT_SECRET;
  if (!limiterSecret || limiterSecret.length < 32) throw new Error("RATE_LIMIT_SECRET must be set (32+ characters)");
  cached = {
    stripe: new Stripe(cfg.secretKey, { maxNetworkRetries: 2, appInfo: { name: "bybrick" } }),
    rpc: adminRpc(),
    cfg,
    mailer: unsentMailer,
    alerts: logAlerts,
    turnstileSecret: process.env.TURNSTILE_SECRET_KEY,
    limiterSecret,
  };
  return cached;
}
