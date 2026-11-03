# bybrick

Item-level crowdfunding for small brick-and-mortar businesses, with an equipment ledger underneath. Phase 1 runs one real campaign: BIRDY'S (Irving Park, Chicago).

## Status

Scaffold only. Built so far: Next.js app shell with security headers and a nonce-based CSP, the Postgres schema with deny-by-default access, the append-only ledger, money helpers, and their tests. Not built yet: the payment layer, owner and contributor screens, emails, the link fetcher, platform and legal pages.

Stripe decisions are in `docs/stripe-verification.md`.

## Layout

- `src/` Next.js app (App Router). `src/proxy.ts` sets the CSP per request.
- `supabase/migrations/` schema, ledger guards, access rules. Apply in order.
- `supabase/seed.sql` sample Birdy's data. Test mode only.
- `tests/unit/` pure logic. `tests/db/` runs against a real local Postgres.

## Running tests

DB tests create and drop throwaway databases, so they refuse any host except localhost. They need a local Postgres 15+ and a superuser:

```bash
createuser --superuser --pwprompt bybrick_test   # password: bybrick_test
npm test
```

To use a different local server, set `TEST_DATABASE_URL`. If Postgres is not reachable the DB tests fail; they never skip, because they gate live money.

## Rules that matter

- Secrets live in environment variables only. See `.env.example`. Nothing secret is committed.
- Stripe stays in test mode until the owner says otherwise in writing.
- The Supabase service-role key and Stripe secret keys are server-only.
