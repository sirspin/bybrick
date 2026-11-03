import type Stripe from "stripe";
import type { Rpc } from "./rpc";
import type { StripeConfig } from "./config";

// Everything the payment code needs from the outside world, injected so tests can fake it.

export interface Mailer {
  pledgeConfirmation(a: { to: string; name: string; businessName: string; itemName: string | null; amountCents: number; manageUrl: string; outcome: string }): Promise<void>;
  /** Item funded and the card was charged. */
  pledgeCharged(a: { to: string; name: string; businessName: string; itemName: string | null; chargedCents: number }): Promise<void>;
  /** Customer authentication is needed to finish a charge. */
  actionNeeded(a: { to: string; name: string; businessName: string; itemName: string | null; chargeCents: number; actionUrl: string }): Promise<void>;
  /** Item expired or the pledge could not be taken; nobody was charged. */
  pledgeNotCharged(a: { to: string; name: string; businessName: string; itemName: string | null; reason: "item_closed" | "item_expired" | "charge_failed" }): Promise<void>;
  /** Failed charges left a funded item short; offers close-it-out. */
  ownerItemShort(a: { businessId: string; itemId: string; shortfallCents: number }): Promise<void>;
}

export interface Alerts {
  /** Operational alert to the platform operator. Must never include emails, tokens or card data. */
  notify(subject: string, details?: Record<string, string | number | boolean>): Promise<void>;
}

export interface Deps {
  stripe: Stripe;
  rpc: Rpc;
  cfg: StripeConfig;
  mailer: Mailer;
  alerts: Alerts;
  /** Cloudflare Turnstile + rate-limit secret material. */
  turnstileSecret?: string;
  limiterSecret: string;
  fetch?: typeof fetch;
}
