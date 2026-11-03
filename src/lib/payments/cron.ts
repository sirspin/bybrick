import type { Deps } from "./ports";
import { chargePledges, detachPaymentMethod } from "./charging";

/** Retries that have come due, plus charges whose first attempt never finished (lease ran out). */
export async function sweepCharges(d: Deps): Promise<{ attempted: number }> {
  const due = await d.rpc<Array<{ pledge_id: string }>>("claim_due_retries", {});
  if (due.length) await chargePledges(d, due);
  return { attempted: due.length };
}

/** Expire items past their deadline (and stale pool pledges), then clean up. Nobody is charged. */
export async function sweepExpiry(d: Deps): Promise<{ expired: number }> {
  const expired = await d.rpc<Array<{ pledge_id: string; stripe_payment_method_id: string | null; can_detach: boolean }>>("expire_due", {});
  for (const e of expired) {
    const ctx = await d.rpc<{ stripe_account_id: string | null; contributor_name: string; contributor_email: string; business_name: string; item_name: string | null } | null>(
      "charge_context", { p_pledge_id: e.pledge_id });
    if (!ctx) continue;
    if (e.can_detach && e.stripe_payment_method_id && ctx.stripe_account_id) {
      await detachPaymentMethod(d, ctx.stripe_account_id, e.stripe_payment_method_id);
    }
    await d.mailer.pledgeNotCharged({
      to: ctx.contributor_email, name: ctx.contributor_name, businessName: ctx.business_name,
      itemName: ctx.item_name, reason: "item_expired",
    });
  }
  return { expired: expired.length };
}
