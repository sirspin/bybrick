import type { Deps } from "./ports";
import { statementDescriptor } from "./descriptor";

// Connected accounts: Accounts v2, Express dashboard, Stripe collects fees and carries
// negative-balance losses (Stripe's recommended setup for direct charges).
// Responsibilities cannot be changed after the account exists, so this is set once, here.

interface BusinessCtx {
  business: { id: string; name: string; legal_name: string; contact_email: string; stripe_account_id: string | null };
}

export async function startOnboarding(d: Pick<Deps, "stripe" | "rpc" | "cfg">, businessId: string): Promise<{ url: string; accountId: string }> {
  const ctx = await d.rpc<BusinessCtx>("payment_context", { p_business_id: businessId, p_item_id: null });
  const b = ctx.business;

  let accountId = b.stripe_account_id;
  if (!accountId) {
    const desc = statementDescriptor(b.name);
    if (!desc) {
      throw new Error("The business name can't be used as a card statement name (needs 5 to 22 Latin characters with a letter)");
    }
    const account = await d.stripe.v2.core.accounts.create(
      {
        dashboard: "express",
        display_name: b.name,
        contact_email: b.contact_email,
        identity: {
          country: "US",
          entity_type: "company",
          business_details: { registered_name: b.legal_name },
        },
        defaults: {
          currency: "usd",
          locales: ["en-US"],
          responsibilities: { fees_collector: "stripe", losses_collector: "stripe" },
        },
        configuration: {
          merchant: {
            capabilities: { card_payments: { requested: true } },
            statement_descriptor: { descriptor: desc.descriptor, prefix: desc.prefix },
          },
        },
        include: ["configuration.merchant", "identity", "defaults"],
      },
      // A double click must not create two Stripe accounts for one business.
      { idempotencyKey: `acct_create:${b.id}` },
    );
    accountId = account.id;
    await d.rpc("set_stripe_account", { p_business_id: b.id, p_account_id: accountId });
  }

  const link = await d.stripe.v2.core.accountLinks.create({
    account: accountId,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        refresh_url: `${d.cfg.siteUrl}/owner/stripe/refresh`,
        return_url: `${d.cfg.siteUrl}/owner/stripe/return`,
      },
    },
  });
  return { url: link.url, accountId };
}

/**
 * Re-reads the account from Stripe and updates our flag. Arriving at the return URL does not
 * prove anything, so always call this and trust only what Stripe says: card_payments active.
 */
export async function syncAccountStatus(d: Pick<Deps, "stripe" | "rpc" | "cfg">, accountId: string): Promise<{ ready: boolean; businessId: string | null }> {
  const account = await d.stripe.v2.core.accounts.retrieve(accountId, { include: ["configuration.merchant"] });
  const ready = account.configuration?.merchant?.capabilities?.card_payments?.status === "active";
  const businessId = await d.rpc<string | null>("set_onboarding_status", { p_account_id: accountId, p_ready: ready });
  if (businessId && ready) await registerPaymentMethodDomain(d, accountId);
  return { ready, businessId };
}

/** Apple Pay with direct charges needs our domain registered on each connected account. */
export async function registerPaymentMethodDomain(d: Pick<Deps, "stripe" | "cfg">, accountId: string): Promise<void> {
  const domain = new URL(d.cfg.siteUrl).hostname;
  try {
    await d.stripe.paymentMethodDomains.create({ domain_name: domain }, { stripeAccount: accountId });
  } catch (err) {
    const existing = await d.stripe.paymentMethodDomains.list({ domain_name: domain, limit: 1 }, { stripeAccount: accountId });
    if (existing.data.length === 0) throw err;
  }
}
