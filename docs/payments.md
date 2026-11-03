# Payment layer

Status: built and tested against a fake Stripe and a real local Postgres. **Never run against real Stripe yet** (no test keys were available). Every Stripe call below is typed against the installed SDK (stripe-node 23.1.0) but unconfirmed in practice.

## How a pledge moves

1. `POST /api/pledges/intent` validates input (zod), rate-limits (10 per IP per 10 min, 5 per email per hour), checks Turnstile, then reads the business and item from the database. The connected-account id comes from the database. It creates a Customer and a SetupIntent (`usage: off_session`) on the business's account and returns the client secret, the consent text and its version. No pledge exists and nothing is charged.
2. The browser confirms the SetupIntent with the Payment Element (UI not built yet).
3. `POST /api/pledges/finalize` (return page) and the `setup_intent.succeeded` webhook both call `finalizeSetupIntent`. The first to run creates the pledge through `create_pledge` and emails the manage link; the other sees "duplicate".
4. If the pledge funds an item, charges are made right away: one off-session PaymentIntent per pledge on the connected account, `application_fee_amount` from `PLATFORM_FEE_*`, idempotency key `pledge:<id>:<attempt>`.
5. `payment_intent.succeeded` (verified webhook) writes the ledger (income, platform fee, Stripe fee), marks the pledge charged, detaches the card if nothing else needs it, and emails.
6. Failures: card declines retry after 1 day, then 3 days after the second failure, then the pledge is marked failed (card detached, contributor and owner told). Payments needing authentication are parked with an emailed link. A crash mid-charge is picked up by a 15-minute lease on the pledge.

## Webhook endpoint

One endpoint, `POST /api/webhooks/stripe`, for events on **connected accounts** (Stripe's "Connected accounts" scope). It checks the signature on the raw body (5-minute tolerance), ignores events whose mode doesn't match the key, and relies on the database to record each event id once. Handlers that fail return 500 so Stripe retries.

Events handled: `payment_intent.succeeded`, `payment_intent.payment_failed`, `payment_intent.requires_action`, `charge.refunded`, `setup_intent.succeeded`, `setup_intent.setup_failed`, `account.updated`, `charge.dispute.created` (alert only).

Local testing once keys exist:

```bash
stripe listen --forward-connect-to localhost:3000/api/webhooks/stripe
```

## Assumptions to confirm (not verified against live Stripe)

- Onboarding link: the docs show a `configurations: ['merchant']` field on `account_onboarding`; the installed SDK types have no such field, so it is omitted.
- Account readiness is read from `configuration.merchant.capabilities.card_payments.status === "active"` after retrieving the v2 account with `include: ["configuration.merchant"]`. `account.updated` (v1 event) is used as the trigger; v2 thin events are not used.
- Stripe's processing fee is read from `fee_details` entries of type `stripe_fee` on the charge's balance transaction.
- `deferredPaymentRequest` for Apple Pay merchant tokens is returned to the UI as `applePay`; it has not been exercised.
- The platform fee is capped at half of any charge.
- A pledge's minimum is $5 unless fewer dollars remain on the item; pool pledges cap at $1,000.

## Not built

- Email delivery. `runtime.ts` uses a placeholder that sends nothing and logs only the template name. Manage links and "finish your payment" links will not reach anyone until a Resend adapter exists.
- Owner sign-in, so `startOnboarding` has no route yet.
- Payment Element UI, manage page, finish-payment page.
- Platform-fee refunds when a business refunds a pledge (policy undecided), disputes beyond an alert, Radar rules on connected accounts.
