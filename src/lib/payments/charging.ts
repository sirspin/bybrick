import Stripe from "stripe";
import { z } from "zod";
import type { Deps } from "./ports";
import { applicationFeeCents } from "./fees";
import { newToken } from "./tokens";
import { noteFailure } from "./spike";

// Off-session charges. One PaymentIntent per pledge, created on the business's connected
// account (direct charge) so the card statement shows the business. Amounts and the account
// id come from the database, never from a request.

const ctxSchema = z.object({
  pledge_id: z.string().uuid(),
  business_id: z.string().uuid(),
  item_id: z.string().uuid().nullable(),
  status: z.string(),
  charge_cents: z.number().int().nullable(),
  attempt: z.number().int(),
  stripe_customer_id: z.string().nullable(),
  stripe_payment_method_id: z.string().nullable(),
  stripe_account_id: z.string().nullable(),
  contributor_name: z.string(),
  contributor_email: z.string(),
  business_name: z.string(),
  item_name: z.string().nullable(),
});
type ChargeCtx = z.infer<typeof ctxSchema>;

export type ChargeResult = "succeeded" | "pending" | "requires_action" | "retry_scheduled" | "failed" | "skipped";

export async function chargePledge(d: Deps, pledgeId: string): Promise<ChargeResult> {
  const raw = await d.rpc<unknown>("charge_context", { p_pledge_id: pledgeId });
  if (!raw) return "skipped";
  const ctx = ctxSchema.parse(raw);
  if (ctx.status !== "charging" || !ctx.charge_cents || ctx.charge_cents <= 0 ||
      !ctx.stripe_account_id || !ctx.stripe_customer_id || !ctx.stripe_payment_method_id) {
    return "skipped";
  }

  const fee = applicationFeeCents(ctx.charge_cents, d.cfg.fee);
  let pi: Stripe.PaymentIntent;
  try {
    pi = await d.stripe.paymentIntents.create(
      {
        amount: ctx.charge_cents,
        currency: "usd",
        customer: ctx.stripe_customer_id,
        payment_method: ctx.stripe_payment_method_id,
        off_session: true,
        confirm: true,
        ...(fee > 0 ? { application_fee_amount: fee } : {}),
        description: ctx.item_name ? `${ctx.business_name}: ${ctx.item_name}` : ctx.business_name,
        metadata: {
          pledge_id: ctx.pledge_id,
          business_id: ctx.business_id,
          item_id: ctx.item_id ?? "",
          attempt: String(ctx.attempt),
        },
      },
      {
        stripeAccount: ctx.stripe_account_id,
        // One key per pledge per attempt: a crash and retry returns the same result instead of
        // charging twice, and a scheduled retry (a later attempt) gets a fresh key.
        idempotencyKey: `pledge:${ctx.pledge_id}:${ctx.attempt}`,
      },
    );
  } catch (err) {
    if (err instanceof Stripe.errors.StripeCardError) {
      const code = err.code ?? err.decline_code ?? "card_error";
      return handleFailure(d, ctx, ctx.attempt, {
        code,
        requiresAction: code === "authentication_required",
        paymentIntentId: err.payment_intent?.id ?? null,
      });
    }
    // Network or API trouble: say nothing to the ledger. The 15-minute lease on the pledge
    // brings it back to the sweeper, which reuses the same idempotency key.
    throw err;
  }

  switch (pi.status) {
    case "succeeded":
      return "succeeded"; // the ledger is written when the verified webhook arrives
    case "processing":
      return "pending";
    case "requires_action":
    case "requires_confirmation":
      return handleFailure(d, ctx, ctx.attempt, { code: "authentication_required", requiresAction: true, paymentIntentId: pi.id });
    default:
      return handleFailure(d, ctx, ctx.attempt, { code: `unexpected_${pi.status}`, requiresAction: false, paymentIntentId: pi.id });
  }
}

/** Charge everything a funding step planned. One failure never stops the others. */
export async function chargePledges(d: Deps, plan: Array<{ pledge_id: string }>): Promise<Record<string, ChargeResult | "error">> {
  const out: Record<string, ChargeResult | "error"> = {};
  await Promise.all(plan.map(async (c) => {
    try { out[c.pledge_id] = await chargePledge(d, c.pledge_id); }
    catch { out[c.pledge_id] = "error"; }
  }));
  return out;
}

const failureSchema = z.object({
  outcome: z.string(),
  item_id: z.string().nullable().optional(),
  item_shortfall_cents: z.number().nullable().optional(),
  stripe_payment_method_id: z.string().nullable().optional(),
  can_detach: z.boolean().optional(),
});

/**
 * Records a failed attempt and does what follows from it. Used by the synchronous path and by
 * the payment_failed webhook. Both pass the same synthetic event id (pledge + attempt), so the
 * database counts each attempt once no matter which arrives first.
 */
export async function handleFailure(
  d: Deps,
  ctx: Pick<ChargeCtx, "pledge_id" | "business_id" | "stripe_account_id" | "contributor_name" | "contributor_email" | "business_name" | "item_name" | "charge_cents" | "stripe_payment_method_id" | "item_id">,
  attempt: number,
  f: { code: string; requiresAction: boolean; paymentIntentId: string | null },
): Promise<ChargeResult> {
  const action = f.requiresAction ? newToken() : null;
  const res = failureSchema.parse(await d.rpc("record_charge_failed", {
    p_event_id: `charge_attempt:${ctx.pledge_id}:${attempt}`,
    p_account_id: ctx.stripe_account_id,
    p_pledge_id: ctx.pledge_id,
    p_error_code: f.code,
    p_requires_action: f.requiresAction,
    p_payment_intent_id: f.paymentIntentId,
    p_action_token_hash: action?.hashParam ?? null,
  }));

  if (res.outcome === "duplicate" || res.outcome === "ignored") return "skipped";
  if (!f.requiresAction) await noteFailure(d, "charge_failed");

  if (res.outcome === "requires_action" && action) {
    await d.mailer.actionNeeded({
      to: ctx.contributor_email, name: ctx.contributor_name, businessName: ctx.business_name,
      itemName: ctx.item_name, chargeCents: ctx.charge_cents ?? 0,
      actionUrl: `${d.cfg.siteUrl}/pay/${action.token}`,
    });
    return "requires_action";
  }

  if (res.outcome === "failed") {
    await d.mailer.pledgeNotCharged({
      to: ctx.contributor_email, name: ctx.contributor_name, businessName: ctx.business_name,
      itemName: ctx.item_name, reason: "charge_failed",
    });
    if (res.item_id && (res.item_shortfall_cents ?? 0) > 0) {
      await d.mailer.ownerItemShort({ businessId: ctx.business_id, itemId: res.item_id, shortfallCents: res.item_shortfall_cents! });
    }
    if (res.can_detach && res.stripe_payment_method_id && ctx.stripe_account_id) {
      await detachPaymentMethod(d, ctx.stripe_account_id, res.stripe_payment_method_id);
    }
    return "failed";
  }
  return "retry_scheduled";
}

/** Remove a saved card from the connected account once nothing needs it. Already gone is fine. */
export async function detachPaymentMethod(d: Pick<Deps, "stripe">, accountId: string, paymentMethodId: string): Promise<void> {
  try {
    await d.stripe.paymentMethods.detach(paymentMethodId, {}, { stripeAccount: accountId });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeInvalidRequestError && /not attached|No such PaymentMethod/i.test(err.message)) return;
    throw err;
  }
}
