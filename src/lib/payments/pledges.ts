import { z } from "zod";
import type { Deps } from "./ports";
import { MAX_CENTS } from "../money";
import { limiterKey, newToken } from "./tokens";
import { verifyTurnstile } from "./turnstile";
import { statementDescriptor } from "./descriptor";
import { CONSENT_VERSION, consentText } from "./consent";
import { chargePledges, detachPaymentMethod } from "./charging";

export const MIN_PLEDGE_CENTS = 500; // card-testing friction; lower only to finish an item

export class PledgeError extends Error {
  constructor(public code:
    | "invalid" | "rate_limited" | "bot_check_failed" | "not_found" | "business_not_ready"
    | "item_closed" | "amount_too_high" | "amount_too_low" | "not_ready_to_finalize" | "mismatch",
    message?: string) {
    super(message ?? code);
  }
}

export const pledgeInputSchema = z.object({
  businessId: z.string().uuid(),
  itemId: z.string().uuid(),
  name: z.string().trim().min(1).max(120).refine((s) => !/[\u0000-\u001f<>]/.test(s), "plain text only"),
  email: z.string().trim().toLowerCase().pipe(z.string().email().max(254)),
  amountCents: z.number().int().min(1).max(MAX_CENTS),
  consent: z.literal(true),
  turnstileToken: z.string().min(1).max(2048),
});
export type PledgeInput = z.infer<typeof pledgeInputSchema>;

interface Ctx {
  business: { id: string; name: string; legal_name: string; stripe_account_id: string | null; ready: boolean };
  item: { id: string; name: string; status: string; deadline: string | null; goal_cents: number; remaining_cents: number } | null;
}

export interface PledgeIntentResult {
  clientSecret: string;
  /** Not secret: Stripe.js needs it to talk to the business's account. Comes from our database. */
  stripeAccount: string;
  publishableKey: string | null;
  consentVersion: string;
  consentText: string;
  /** Pass to the Payment Element's applePay option so Apple issues a merchant token. */
  applePay: { paymentDescription: string; deferredBilling: { amount: number; label: string; deferredPaymentDate: string } };
}

/**
 * Step 1 of a pledge: validate everything against the database, then create a Customer and a
 * SetupIntent on the business's connected account. Nothing is charged and no pledge exists yet.
 */
export async function createPledgeIntent(d: Deps, raw: unknown, ip: string | null): Promise<PledgeIntentResult> {
  const parsed = pledgeInputSchema.safeParse(raw);
  if (!parsed.success) throw new PledgeError("invalid");
  const input = parsed.data;

  // Cheap checks first, so abuse costs us as little as possible.
  const okIp = await d.rpc<boolean>("hit_rate_limit", { p_key: limiterKey("pledge-ip", ip ?? "unknown", d.limiterSecret), p_max: 10, p_window: "10 minutes" });
  const okEmail = await d.rpc<boolean>("hit_rate_limit", { p_key: limiterKey("pledge-email", input.email, d.limiterSecret), p_max: 5, p_window: "1 hour" });
  if (!okIp || !okEmail) throw new PledgeError("rate_limited");
  if (!(await verifyTurnstile(input.turnstileToken, ip, d.turnstileSecret, d.fetch))) throw new PledgeError("bot_check_failed");

  let ctx: Ctx;
  try {
    ctx = await d.rpc<Ctx>("payment_context", { p_business_id: input.businessId, p_item_id: input.itemId });
  } catch {
    throw new PledgeError("not_found"); // unknown business, or an item that isn't theirs
  }
  const { business } = ctx;
  if (!business.ready || !business.stripe_account_id) throw new PledgeError("business_not_ready");
  const descriptor = statementDescriptor(business.name);
  if (!descriptor) throw new PledgeError("business_not_ready");

  // Decide from what the database says now, not from what the page showed.
  const item = ctx.item;
  if (!item) throw new PledgeError("not_found");
  const itemOpen = item.status === "open" && !!item.deadline && new Date(item.deadline) > new Date() && item.remaining_cents > 0;
  if (!itemOpen) throw new PledgeError("item_closed");
  if (input.amountCents > item.remaining_cents) throw new PledgeError("amount_too_high");
  if (input.amountCents < Math.min(MIN_PLEDGE_CENTS, item.remaining_cents)) throw new PledgeError("amount_too_low");

  const deadline = new Date(item.deadline!);
  const text = consentText({
    legalName: business.legal_name, itemName: item.name, amountCents: input.amountCents,
    deadline, descriptor: descriptor.descriptor,
  });

  const opts = { stripeAccount: business.stripe_account_id };
  const customer = await d.stripe.customers.create({ name: input.name, email: input.email, metadata: { business_id: business.id } }, opts);
  const si = await d.stripe.setupIntents.create(
    {
      customer: customer.id,
      usage: "off_session",
      automatic_payment_methods: { enabled: true },
      description: `Pledge to ${business.name}`,
      // Written by us, server-side. The browser can confirm the intent but cannot edit this.
      metadata: {
        business_id: business.id,
        item_id: item.id,
        amount_cents: String(input.amountCents),
        consent_version: CONSENT_VERSION,
        consented_at: new Date().toISOString(),
      },
    },
    opts,
  );
  if (!si.client_secret) throw new Error("Stripe did not return a client secret");

  return {
    clientSecret: si.client_secret,
    stripeAccount: business.stripe_account_id,
    publishableKey: d.cfg.publishableKey,
    consentVersion: CONSENT_VERSION,
    consentText: text,
    applePay: {
      paymentDescription: `Pledge to ${business.name}`,
      deferredBilling: { amount: input.amountCents, label: item.name, deferredPaymentDate: deadline.toISOString() },
    },
  };
}

const outcomeSchema = z.object({
  pledge_id: z.string().uuid().nullable(),
  outcome: z.enum(["pending", "funded", "item_closed", "duplicate"]),
  charges: z.array(z.object({ pledge_id: z.string().uuid() })),
});

export interface FinalizeResult {
  outcome: z.infer<typeof outcomeSchema>["outcome"];
}

/**
 * Step 2: the contributor's card is saved (SetupIntent succeeded). Called from the return page
 * and from the setup_intent.succeeded webhook; whichever runs first wins and the other sees
 * "duplicate". Everything is re-read from Stripe and our database; nothing comes from the browser
 * except which SetupIntent and which business.
 */
export async function finalizeSetupIntent(d: Deps, setupIntentId: string, businessId: string): Promise<FinalizeResult> {
  if (!/^seti_[A-Za-z0-9]+$/.test(setupIntentId)) throw new PledgeError("invalid");
  let ctx: Ctx;
  try {
    ctx = await d.rpc<Ctx>("payment_context", { p_business_id: businessId, p_item_id: null });
  } catch {
    throw new PledgeError("not_found");
  }
  const account = ctx.business.stripe_account_id;
  if (!account) throw new PledgeError("business_not_ready");
  const opts = { stripeAccount: account };

  // Looked up under THIS business's account: a SetupIntent from anywhere else simply isn't found.
  const si = await d.stripe.setupIntents.retrieve(setupIntentId, {}, opts);
  if (si.status !== "succeeded") throw new PledgeError("not_ready_to_finalize");
  const m = si.metadata ?? {};
  if (m.business_id !== businessId) throw new PledgeError("mismatch");

  const paymentMethod = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
  const customerId = typeof si.customer === "string" ? si.customer : si.customer?.id;
  if (!paymentMethod || !customerId) throw new PledgeError("mismatch");
  const customer = await d.stripe.customers.retrieve(customerId, {}, opts);
  if (customer.deleted || !customer.email || !customer.name) throw new PledgeError("mismatch");

  const amount = Number(m.amount_cents);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new PledgeError("mismatch");
  // The item must be this business's (also gives us its name for the emails).
  if (!m.item_id) throw new PledgeError("mismatch");
  let itemName: string;
  try {
    const itemCtx = await d.rpc<Ctx>("payment_context", { p_business_id: businessId, p_item_id: m.item_id });
    if (!itemCtx.item) throw new Error("no item");
    itemName = itemCtx.item.name;
  } catch {
    throw new PledgeError("mismatch");
  }
  const token = newToken();

  const res = outcomeSchema.parse(await d.rpc("create_pledge", {
    p_business_id: businessId,
    p_item_id: m.item_id,
    p_name: customer.name,
    p_email: customer.email,
    p_amount_cents: amount,
    p_manage_token_hash: token.hashParam,
    p_consent_version: m.consent_version ?? "unknown",
    p_consented_at: m.consented_at ?? new Date().toISOString(),
    p_customer_id: customerId,
    p_payment_method_id: paymentMethod,
    p_setup_intent_id: si.id,
  }));

  if (res.outcome === "duplicate") return { outcome: "duplicate" };

  if (res.outcome === "item_closed") {
    // Nothing was recorded, so the card isn't needed.
    await detachPaymentMethod(d, account, paymentMethod);
    await d.mailer.pledgeNotCharged({ to: customer.email, name: customer.name, businessName: ctx.business.name, itemName, reason: "item_closed" });
    return { outcome: "item_closed" };
  }

  await d.mailer.pledgeConfirmation({
    to: customer.email, name: customer.name, businessName: ctx.business.name,
    itemName, amountCents: amount,
    manageUrl: `${d.cfg.siteUrl}/manage/${token.token}`, outcome: res.outcome,
  });
  if (res.charges.length > 0) await chargePledges(d, res.charges);
  return { outcome: res.outcome };
}
