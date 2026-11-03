import Stripe from "stripe";
import { z } from "zod";
import type { Deps } from "./ports";
import { syncAccountStatus } from "./connect";
import { detachPaymentMethod, handleFailure } from "./charging";
import { finalizeSetupIntent, PledgeError } from "./pledges";
import { noteFailure } from "./spike";

export class WebhookRejected extends Error {}

/**
 * Verifies the Stripe signature and rejects anything unsigned, tampered with, or older than the
 * tolerance (default 5 minutes), then returns the event. Uses the raw request body.
 */
export function verifyWebhook(stripe: Stripe, rawBody: string, signature: string | null, secret: string | null): Stripe.Event {
  if (!secret) throw new WebhookRejected("webhook secret is not configured");
  if (!signature) throw new WebhookRejected("missing signature");
  try {
    return stripe.webhooks.constructEvent(rawBody, signature, secret, 300);
  } catch {
    throw new WebhookRejected("invalid signature");
  }
}

const uuid = z.string().uuid();
const succeededSchema = z.object({
  outcome: z.string(),
  pledge_id: z.string().optional(),
  stripe_payment_method_id: z.string().nullable().optional(),
  can_detach: z.boolean().optional(),
});

export type HandleResult = "handled" | "ignored" | "duplicate";

/**
 * Applies one verified event. Safe to call twice with the same event: the database functions
 * record each Stripe event id once. If anything throws, the caller returns 500 and Stripe retries.
 */
export async function handleStripeEvent(d: Deps, event: Stripe.Event): Promise<HandleResult> {
  // A test-mode key must never act on live events, or the reverse.
  if (event.livemode !== d.cfg.live) return "ignored";

  switch (event.type) {
    case "payment_intent.succeeded":
      return onChargeSucceeded(d, event);
    case "payment_intent.payment_failed":
    case "payment_intent.requires_action":
      return onChargeProblem(d, event);
    case "charge.refunded":
      return onRefund(d, event);
    case "setup_intent.succeeded":
      return onSetupSucceeded(d, event);
    case "setup_intent.setup_failed":
      await noteFailure(d, "setup_failed");
      return "handled";
    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      await syncAccountStatus(d, account.id);
      return "handled";
    }
    case "charge.dispute.created": {
      // Not automated in Phase 1: tell the operator. No customer or card details in the alert.
      await d.alerts.notify("Dispute opened on a connected account", { account: event.account ?? "unknown" });
      return "handled";
    }
    default:
      return "ignored";
  }
}

function pledgeIdOf(pi: Stripe.PaymentIntent): string | null {
  const parsed = uuid.safeParse(pi.metadata?.pledge_id);
  return parsed.success ? parsed.data : null;
}

async function onChargeSucceeded(d: Deps, event: Stripe.Event): Promise<HandleResult> {
  const pi = event.data.object as Stripe.PaymentIntent;
  const pledgeId = pledgeIdOf(pi);
  if (!pledgeId || !event.account) return "ignored";

  // Stripe's own processing fee comes from the balance transaction, not from arithmetic.
  const full = await d.stripe.paymentIntents.retrieve(
    pi.id, { expand: ["latest_charge.balance_transaction"] }, { stripeAccount: event.account },
  );
  const charge = full.latest_charge as Stripe.Charge | null;
  const bt = charge && typeof charge.balance_transaction === "object" ? (charge.balance_transaction as Stripe.BalanceTransaction) : null;
  if (!bt) throw new Error("balance transaction not available yet"); // 500 -> Stripe retries
  const processorFee = bt.fee_details.filter((f) => f.type === "stripe_fee").reduce((a, f) => a + f.amount, 0);

  const res = succeededSchema.parse(await d.rpc("record_charge_succeeded", {
    p_event_id: event.id,
    p_account_id: event.account,
    p_pledge_id: pledgeId,
    p_payment_intent_id: pi.id,
    p_amount_cents: pi.amount_received,
    p_application_fee_cents: pi.application_fee_amount ?? 0,
    p_processor_fee_cents: processorFee,
    p_occurred_at: new Date(event.created * 1000).toISOString(),
  }));
  if (res.outcome === "duplicate" || res.outcome === "already_charged") return "duplicate";

  if (res.can_detach && res.stripe_payment_method_id) {
    await detachPaymentMethod(d, event.account, res.stripe_payment_method_id);
  }
  const ctx = await d.rpc<{ contributor_name: string; contributor_email: string; business_name: string; item_name: string | null; charge_cents: number } | null>("charge_context", { p_pledge_id: pledgeId });
  if (ctx) {
    await d.mailer.pledgeCharged({
      to: ctx.contributor_email, name: ctx.contributor_name, businessName: ctx.business_name,
      itemName: ctx.item_name, chargedCents: ctx.charge_cents,
    });
  }
  return "handled";
}

async function onChargeProblem(d: Deps, event: Stripe.Event): Promise<HandleResult> {
  const pi = event.data.object as Stripe.PaymentIntent;
  const pledgeId = pledgeIdOf(pi);
  const attempt = Number(pi.metadata?.attempt);
  if (!pledgeId || !event.account || !Number.isInteger(attempt) || attempt < 1) return "ignored";

  const ctx = await d.rpc<Parameters<typeof handleFailure>[1] | null>("charge_context", { p_pledge_id: pledgeId });
  if (!ctx) return "ignored";
  const code = pi.last_payment_error?.code ?? "payment_failed";
  const requiresAction = event.type === "payment_intent.requires_action" || code === "authentication_required";
  // Same synthetic event id as the synchronous path, so the attempt is counted once.
  const r = await handleFailure(d, { ...ctx, stripe_account_id: event.account }, attempt, { code, requiresAction, paymentIntentId: pi.id });
  return r === "skipped" ? "duplicate" : "handled";
}

async function onRefund(d: Deps, event: Stripe.Event): Promise<HandleResult> {
  const charge = event.data.object as Stripe.Charge;
  if (!event.account || !charge.payment_intent) return "ignored";
  const piId = typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent.id;
  const pi = await d.stripe.paymentIntents.retrieve(piId, {}, { stripeAccount: event.account });
  const pledgeId = pledgeIdOf(pi);
  if (!pledgeId) return "ignored";

  // Platform-fee refunds are not automated yet (open policy decision), so the fee stays.
  const res = await d.rpc<{ outcome: string }>("record_refund", {
    p_event_id: event.id,
    p_account_id: event.account,
    p_pledge_id: pledgeId,
    p_total_refunded_cents: charge.amount_refunded,
    p_fee_refunded: false,
    p_occurred_at: new Date(event.created * 1000).toISOString(),
  });
  return res.outcome === "duplicate" ? "duplicate" : "handled";
}

async function onSetupSucceeded(d: Deps, event: Stripe.Event): Promise<HandleResult> {
  const si = event.data.object as Stripe.SetupIntent;
  const businessId = uuid.safeParse(si.metadata?.business_id);
  if (!businessId.success || !event.account) return "ignored";
  try {
    const r = await finalizeSetupIntent(d, si.id, businessId.data);
    return r.outcome === "duplicate" ? "duplicate" : "handled";
  } catch (err) {
    // Not one of ours or not finishable: nothing to retry. Anything else: let Stripe retry.
    if (err instanceof PledgeError && ["mismatch", "not_found", "invalid"].includes(err.code)) return "ignored";
    throw err;
  }
}
