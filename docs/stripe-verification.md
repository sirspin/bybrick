# Stripe verification (pre-payment-layer)

> Update: the shared pool was removed from Phase 1, so the pool-related points below (item 4 in the summary, the pool consent variants, and decision 4) no longer apply.

Read on 2026-11-03 from docs.stripe.com. Items marked UNVERIFIED are not confirmed by a page I read; they come from general knowledge and must be checked in test mode before we rely on them.

## Summary of what changes from the brief

1. Legacy `type=express` accounts are not recommended for direct charges. Use the controller/v2 configuration instead (Express dashboard, Stripe collects fees, Stripe carries negative-balance losses).
2. "BIRDY'S" cannot be a statement descriptor. Apostrophes are disallowed. Use "BIRDYS" (or similar).
3. Platform Radar rules do not apply to direct charges. The brief's "turn on Radar" needs a different plan.
4. Pool pledges have no deadline in the brief, but Stripe's consent rules require us to state timing. Needs a decision.
5. Apple Pay saved methods are not guaranteed to work weeks later. Stripe documents no time limit and no guarantee.

## 1. Charge type

Direct charges on the connected account. Confirmed:

- The statement uses the connected account's descriptor for direct charges (connect/statement-descriptors).
- The connected account needs the `card_payments` capability.
- Descriptor rules: 5 to 22 Latin characters, at least one letter, none of `< > \ ' " *`. Prefix is 2 to 10 characters. Card networks get the first 22 characters.
- Platform visibility is limited: PaymentIntents, Charges, SetupIntents and Customers live on the connected account and are read with the `Stripe-Account` header.
- Stripe.js is initialised with `stripeAccount: <acct id>` so the Payment Element talks to the connected account.

Account type (the deviation): the charges page says "Direct charges aren't recommended for legacy v1 Express and Custom accounts" and the fee-payer page says "We don't recommend using direct charges with this legacy setting" for `application_express`. Stripe's recommended direct-charge setup (connect/integration-recommendations) is Express dashboard, Stripe carries negative-balance liability, and either party collects fees.

Two ways to get that:
- v2 Accounts: `dashboard: "express"`, `defaults.responsibilities.fees_collector: "stripe"`, `losses_collector: "stripe"`, merchant configuration with `card_payments`. The doc's example uses `Stripe-Version: 2026-10-28.preview`, so I need to confirm v2 is generally available before depending on it.
- v1 Accounts with controller properties (`stripe_dashboard.type=express`, `fees.payer=account`, `losses.payments=stripe`). UNVERIFIED: I did not open the controller-properties page.

Responsibilities cannot be changed after the account is created.

## 2. Apple Pay domain registration

- With direct charges, each connected account needs the domain registered through the API: `POST /v1/payment_method_domains` with the platform secret key and the `Stripe-Account` header. Other charge types do not need this (apple-pay page).
- Register each domain once per account. Registering also covers Google Pay, Link and others.
- Stripe handles Apple merchant validation. No Apple Merchant ID needed.
- Subdomains count as separate domains. Path-based business pages (`bybrick.com/b/birdys`) mean one domain per account. Subdomain-per-business would mean registering each.
- Register at the end of onboarding, once the account is active. Register in live mode before launch; live registration also covers sandboxes.
- Plan: platform domain registered on each connected account when its Stripe onboarding completes.

## 3. application_fee_amount on off-session PaymentIntents

Confirmed for direct charges (connect/direct-charges):
- Set on the PaymentIntent created with the `Stripe-Account` header. Must be positive and less than the charge amount.
- If `fees_collector = stripe`, Stripe takes its processing fee from the connected account and pays us the application fee. Set `application_fee_amount` to our fee only.
- If `fees_collector = application`, we pay Stripe's fee and must set the application fee to cover both.
- Application fees are NOT refunded automatically. Refunds must pass `refund_application_fee=true` or the business absorbs our fee.
- Application fees are created asynchronously; `application_fee.created` fires. Expanding `application_fee` on create makes it synchronous but slower.
- Dispute fees go to the connected account when `fees_collector = stripe`.
- Ledger consequence: `platform_fee` and `processor_fee` entries come from webhook data (application fee, balance transaction), not from our own arithmetic.
- UNVERIFIED: events from connected accounts arrive on a separate Connect webhook endpoint. I'll confirm when building webhooks.
- Open decision: the fee itself (percentage, flat, or both). Pricing page copy depends on it.

## 4. Saving a payment method for later (consent)

Source: payments/save-and-reuse. Stripe puts compliance on us. To charge when the customer is offline, our terms must include:

- the customer's agreement to our initiating a payment or payments on their behalf for specified transactions,
- the anticipated timing and frequency of payments,
- how the payment amount is determined,
- the cancellation policy (stated for subscriptions; we include it anyway).

We must collect explicit consent (a checkbox) and keep a record of the written agreement.

Schema addition needed: `pledges.consent_text_version` and `pledges.consented_at`, so we can show what wording each person agreed to.

Draft checkbox wording (variables in brackets; DRAFT pending attorney review):

> I authorize [Business legal name] to charge my payment method up to $[amount] for [item], one time, only if [item] is fully pledged by [deadline]. Until then I won't be charged. If it fills up, the charge could happen any time before [deadline] without further action from me. If the item needs less than my pledge, I'll be charged only what's needed. I can cancel any time before the charge from the link emailed to me. The charge will appear on my statement as [descriptor].

Variants needed:
- Pool pledge: replace "fully pledged by [deadline]" with the pool rule and an expiry date (see decision 4 below).
- "Send it where it's needed" box ticked: add that the charge may go to another item at the same business.

## 5. Apple Pay merchant tokens

Source: apple-pay/merchant-tokens.
- By default Apple Pay gives a device-specific token (DPAN). If the customer replaces the device or removes the card, a later merchant-initiated charge can fail.
- An MPAN is tied to customer, card and business, not a device. We request it by passing `applePay.deferredPaymentRequest` (paymentDescription, managementURL, deferredBilling: amount, label, deferredPaymentDate) when creating the Payment Element.
- "If Apple Pay and the card issuer support merchant tokens, Apple Pay returns an MPAN. Otherwise, it returns a DPAN." So no guarantee.
- Stripe stores the credential on the PaymentMethod; we then charge off-session as usual.
- `payment_method.automatically_updated` fires when the underlying card changes.
- No maximum delay between setup and charge is documented. The honest answer to "works weeks later?" is "usually, not guaranteed."
- Stripe test cards cannot be added to Apple Wallet; testing needs a real card in a real wallet with test keys.
- UNVERIFIED: that `deferredPaymentRequest` works on a Payment Element in SetupIntent mode on a connected account. Test on a device before relying on it.
- Mitigation already in the brief: failed charges go through `requires_action` / retry / email. Keep that path first-class.

## 6. Negative balances and liability

Direct charge refunds and disputes are debited from the connected account's balance (connect/charges).

Who covers a negative balance depends on `losses_collector` (v2) or `controller.losses.payments` (v1):
- `stripe`: Stripe is liable for the connected account's negative balance. The platform stays liable for its own platform balance.
- `application`: the platform is liable and Stripe holds a reserve on the platform balance.
- Legacy Express: "your platform is responsible for disputes and fraud" (connect/charges).

Recommendation: `losses_collector = stripe`, `fees_collector = stripe`. This is Stripe's recommended direct-charge setup. It also means Stripe handles identity verification for connected accounts (connected-account-configuration).

Exposure that remains, and how to limit it:
- Refund of our application fee: if we refund fees we lose them; if we don't, the business is out of pocket. Policy decision.
- Stripe can hold reserves or pause payouts for risk; Stripe may also hold funds for compliance. We never hold funds, which matches Stripe's guidance against arbitrary holds.
- Require a bank account on the connected account; set `debit_negative_balances = true` (supported for US banks) so Stripe can auto-debit the business.
- A 180-day negative balance gets collected from the platform reserve; reject such accounts.
- Charge only at funding time (already in the brief) so the window between charge and delivery is short.

## Radar

- Platform Radar rules do not apply to direct charges. Connected accounts can't define their own rules without the full Dashboard (integration-recommendations).
- Rules for a connected account must be set up via "View Dashboard as this account".
- With `fees_collector = stripe`, Radar fees are billed to the connected account.
- Card-testing defence therefore rests mainly on our own rate limits and Turnstile, plus whatever default protection Stripe applies. UNVERIFIED: what Radar default protection covers on connected accounts.

## Decisions needed

1. Account configuration: v2 Accounts vs v1 controller properties (recommend v2 if GA, otherwise v1 controller).
2. Statement descriptor for Birdy's (no apostrophe).
3. Platform fee amount.
4. Pool pledge expiry (suggest 90 days; needed for consent wording and card validity).
5. Whether we refund the application fee when a business refunds (recommend yes).
