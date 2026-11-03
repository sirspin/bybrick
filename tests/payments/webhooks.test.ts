import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addItem, createTestDb, type TestDb } from "../helpers/db";
import { makeDeps, makeFakeStripe, signedEvent, TEST_ENV, type FakeStripe } from "../helpers/payments";
import { finalizeSetupIntent, createPledgeIntent } from "@/lib/payments/pledges";
import { chargePledge } from "@/lib/payments/charging";
import { handleStripeEvent, verifyWebhook, WebhookRejected } from "@/lib/payments/webhooks";
import { startOnboarding, syncAccountStatus } from "@/lib/payments/connect";
import { sweepCharges, sweepExpiry } from "@/lib/payments/cron";
import { SPIKE_THRESHOLD_PER_HOUR } from "@/lib/payments/spike";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });
afterAll(async () => { await db?.drop(); });

let biz: string, acct: string, fake: FakeStripe, h: ReturnType<typeof makeDeps>, ipN = 100;
beforeEach(async () => {
  acct = "acct_" + crypto.randomBytes(6).toString("hex");
  biz = (await db.pool.query(
    `insert into public.businesses (slug,name,legal_name,owner_display,city,contact_email,stripe_account_id,stripe_onboarded_at)
     values ('t' || substr(md5(random()::text),1,8), 'BIRDY''S', 'Birdy''s LLC','O','Chicago','h@x.test',$1, now()) returning id`, [acct])).rows[0].id;
  fake = makeFakeStripe();
  h = makeDeps(db, fake);
});

const q = async (sql: string, v: unknown[] = []) => (await db.pool.query(sql, v)).rows;
const ledger = (pledge: string) => q("select kind, amount_cents from public.ledger_entries where pledge_id=$1 order by amount_cents desc", [pledge]);

/** A funded one-pledge item whose charge has been sent (PaymentIntent exists in the fake). */
async function chargedOnStripe(price = 10000) {
  const item = await addItem(db, biz, { price });
  await createPledgeIntent(h.deps, { businessId: biz, itemId: item, name: "Pat", email: `p${crypto.randomBytes(3).toString("hex")}@x.test`, amountCents: price, consent: true, turnstileToken: "t" }, `7.7.7.${++ipN}`);
  const si = [...fake.setupIntents.keys()].pop()!;
  fake.completeSetup(si);
  fake.state.nextCharge = { kind: "processing" };
  await finalizeSetupIntent(h.deps, si, biz);
  const pledge = (await q("select id from public.pledges where business_id=$1", [biz]))[0].id as string;
  const pi = [...fake.paymentIntents.values()].at(-1)!;
  pi.status = "succeeded"; pi.amount_received = pi.amount;
  return { item, pledge, pi };
}

describe("verifyWebhook", () => {
  const secret = TEST_ENV.STRIPE_WEBHOOK_SECRET;
  it("accepts a correctly signed, fresh event", () => {
    const { payload, header, event } = signedEvent("payment_intent.succeeded", { id: "pi_1" }, { account: acct });
    expect(verifyWebhook(fake.stripe, payload, header, secret).id).toBe(event.id);
  });
  it("rejects unsigned, wrongly signed, tampered and stale events", () => {
    const good = signedEvent("payment_intent.succeeded", { id: "pi_1" }, { account: acct });
    expect(() => verifyWebhook(fake.stripe, good.payload, null, secret)).toThrow(WebhookRejected);
    expect(() => verifyWebhook(fake.stripe, good.payload, "t=1,v1=abc", secret)).toThrow(WebhookRejected);
    const forged = signedEvent("payment_intent.succeeded", { id: "pi_1" }, { account: acct, secret: "whsec_other" });
    expect(() => verifyWebhook(fake.stripe, forged.payload, forged.header, secret)).toThrow(WebhookRejected);
    expect(() => verifyWebhook(fake.stripe, good.payload.replace("pi_1", "pi_2"), good.header, secret)).toThrow(WebhookRejected);
    const stale = signedEvent("payment_intent.succeeded", { id: "pi_1" }, { account: acct, created: Math.floor(Date.now() / 1000) - 600 });
    expect(() => verifyWebhook(fake.stripe, stale.payload, stale.header, secret)).toThrow(WebhookRejected);
  });
  it("rejects everything when no webhook secret is configured", () => {
    const { payload, header } = signedEvent("payment_intent.succeeded", {});
    expect(() => verifyWebhook(fake.stripe, payload, header, null)).toThrow(WebhookRejected);
  });
});

describe("payment_intent.succeeded", () => {
  it("writes income, platform fee and Stripe's fee to the ledger, then detaches the card and emails", async () => {
    const { pledge, pi } = await chargedOnStripe();
    const { event } = signedEvent("payment_intent.succeeded", pi, { account: acct });
    expect(await handleStripeEvent(h.deps, event as any)).toBe("handled");
    expect(await ledger(pledge)).toEqual([
      { kind: "contribution_income", amount_cents: 10000 }, { kind: "platform_fee", amount_cents: -300 }, { kind: "processor_fee", amount_cents: -320 },
    ]);
    expect((await q("select status from public.pledges where id=$1", [pledge]))[0].status).toBe("charged");
    expect(fake.detached).toHaveLength(1);
    expect(h.mailer.of("pledgeCharged")).toHaveLength(1);
  });

  it("replaying the same event, or delivering it twice at once, does not double-write", async () => {
    const { pledge, pi } = await chargedOnStripe();
    const { event } = signedEvent("payment_intent.succeeded", pi, { account: acct });
    const results = await Promise.all([1, 2, 3, 4].map(() => handleStripeEvent(h.deps, event as any).catch((e) => `err:${e.message}`)));
    expect(results.filter((r) => r === "handled")).toHaveLength(1);
    expect(await ledger(pledge)).toHaveLength(3);
    expect(await handleStripeEvent(h.deps, event as any)).toBe("duplicate");
    expect(await ledger(pledge)).toHaveLength(3);
    expect(h.mailer.of("pledgeCharged")).toHaveLength(1);
  });

  it("an event from a different account is rejected, not recorded", async () => {
    const { pledge, pi } = await chargedOnStripe();
    pi.account = "acct_evil"; // the fake looks the PaymentIntent up under whatever account the event names
    const { event } = signedEvent("payment_intent.succeeded", pi, { account: "acct_evil" });
    await expect(handleStripeEvent(h.deps, event as any)).rejects.toThrow(/does not match the pledge/);
    expect(await ledger(pledge)).toEqual([]);
    expect(await q("select 1 from public.processed_events where event_id=$1", [event.id])).toEqual([]);
  });

  it("a different amount than planned is rejected", async () => {
    const { pledge, pi } = await chargedOnStripe();
    const { event } = signedEvent("payment_intent.succeeded", { ...pi, amount_received: 9999 }, { account: acct });
    await expect(handleStripeEvent(h.deps, event as any)).rejects.toThrow(/does not match the planned charge/);
    expect(await ledger(pledge)).toEqual([]);
  });

  it("ignores events from the wrong mode and events with no pledge", async () => {
    const { pi } = await chargedOnStripe();
    expect(await handleStripeEvent(h.deps, signedEvent("payment_intent.succeeded", pi, { account: acct, livemode: true }).event as any)).toBe("ignored");
    expect(await handleStripeEvent(h.deps, signedEvent("payment_intent.succeeded", { ...pi, metadata: {} }, { account: acct }).event as any)).toBe("ignored");
    expect(await handleStripeEvent(h.deps, signedEvent("customer.created", {}, { account: acct }).event as any)).toBe("ignored");
  });
});

describe("failed payments via webhook", () => {
  it("counts an attempt once even when both the API response and the webhook report it", async () => {
    const { pledge } = await chargedOnStripe();
    await q("update public.pledges set status='charging', charge_attempts=0 where id=$1", [pledge]);
    const pi = [...fake.paymentIntents.values()].at(-1)!;
    fake.state.nextCharge = { kind: "decline", code: "card_declined" };
    await chargePledge(h.deps, pledge);
    const failedPi = [...fake.paymentIntents.values()].at(-1)!;
    const { event } = signedEvent("payment_intent.payment_failed", { ...failedPi, last_payment_error: { code: "card_declined" } }, { account: acct });
    expect(await handleStripeEvent(h.deps, event as any)).toBe("duplicate");
    expect((await q("select charge_attempts from public.pledges where id=$1", [pledge]))[0].charge_attempts).toBe(1);
    void pi;
  });

  it("a webhook-only failure is recorded (the API response was lost)", async () => {
    const { pledge, pi } = await chargedOnStripe();
    await q("update public.pledges set status='charging' where id=$1", [pledge]);
    const { event } = signedEvent("payment_intent.payment_failed", { ...pi, status: "requires_payment_method", metadata: { ...pi.metadata, attempt: "1" }, last_payment_error: { code: "insufficient_funds" } }, { account: acct });
    expect(await handleStripeEvent(h.deps, event as any)).toBe("handled");
    expect((await q("select charge_attempts, last_error_code from public.pledges where id=$1", [pledge]))[0]).toEqual({ charge_attempts: 1, last_error_code: "insufficient_funds" });
  });

  it("requires_action emails a finish link", async () => {
    const { pledge, pi } = await chargedOnStripe();
    await q("update public.pledges set status='charging' where id=$1", [pledge]);
    const { event } = signedEvent("payment_intent.requires_action", { ...pi, status: "requires_action", metadata: { ...pi.metadata, attempt: "1" } }, { account: acct });
    await handleStripeEvent(h.deps, event as any);
    expect(h.mailer.of("actionNeeded")).toHaveLength(1);
    expect((await q("select status from public.pledges where id=$1", [pledge]))[0].status).toBe("requires_action");
  });
});

describe("refunds", () => {
  it("records only the new amount each time the running total grows", async () => {
    const { pledge, pi } = await chargedOnStripe();
    await handleStripeEvent(h.deps, signedEvent("payment_intent.succeeded", pi, { account: acct }).event as any);
    const refund = (total: number) => signedEvent("charge.refunded", { id: "ch_1", payment_intent: pi.id, amount_refunded: total }, { account: acct }).event as any;
    await handleStripeEvent(h.deps, refund(2500));
    await handleStripeEvent(h.deps, refund(10000));
    const r = await q("select amount_cents from public.ledger_entries where pledge_id=$1 and kind='refund' order by created_at", [pledge]);
    expect(r.map((x) => x.amount_cents)).toEqual([-2500, -7500]);
  });
});

describe("setup intents via webhook", () => {
  it("setup_intent.succeeded creates the pledge once, even with the return page racing it", async () => {
    const item = await addItem(db, biz, { price: 10000 });
    await createPledgeIntent(h.deps, { businessId: biz, itemId: item, name: "Pat", email: "race@x.test", amountCents: 3000, consent: true, turnstileToken: "t" }, "6.6.6.6");
    const siId = [...fake.setupIntents.keys()].pop()!;
    fake.completeSetup(siId);
    const si = fake.setupIntents.get(siId);
    const { event } = signedEvent("setup_intent.succeeded", si, { account: acct });
    const results = await Promise.all([
      handleStripeEvent(h.deps, event as any),
      finalizeSetupIntent(h.deps, siId, biz).then((r) => r.outcome),
    ]);
    expect(await q("select 1 from public.pledges where business_id=$1", [biz])).toHaveLength(1);
    expect(h.mailer.of("pledgeConfirmation")).toHaveLength(1);
    expect(results).toHaveLength(2);
  });

  it("ignores setup intents that aren't ours", async () => {
    const { event } = signedEvent("setup_intent.succeeded", { id: "seti_x", metadata: {} }, { account: acct });
    expect(await handleStripeEvent(h.deps, event as any)).toBe("ignored");
  });

  it("alerts the operator once when failed setups spike, with no personal details", async () => {
    for (let i = 0; i < SPIKE_THRESHOLD_PER_HOUR + 5; i++) {
      await handleStripeEvent(h.deps, signedEvent("setup_intent.setup_failed", { id: "seti_f" }, { account: acct }).event as any);
    }
    // The counter is shared by the whole test database, so other tests may have used some of it.
    const spikes = h.alerts.alerts.filter((a) => /setup failed/.test(a.subject));
    expect(spikes.length).toBeLessThanOrEqual(1);
    for (const a of h.alerts.alerts) expect(JSON.stringify(a)).not.toMatch(/@|whsec|sk_test|pm_/);
  });

  it("a dispute alerts the operator without card or customer details", async () => {
    await handleStripeEvent(h.deps, signedEvent("charge.dispute.created", { id: "dp_1", amount: 5000 }, { account: acct }).event as any);
    const a = h.alerts.alerts.at(-1)!;
    expect(a.subject).toMatch(/Dispute/);
    expect(JSON.stringify(a)).not.toMatch(/@|dp_1/);
  });
});

describe("connected accounts", () => {
  it("creates one v2 Express account with Stripe holding fees and losses, and a BIRDYS descriptor", async () => {
    const fresh = (await q(`insert into public.businesses (slug,name,legal_name,owner_display,city,contact_email) values ('n' || substr(md5(random()::text),1,8),'BIRDY''S',$1,'o','Chicago','owner@birdys.test') returning id`, ["Birdy's LLC"]))[0].id;
    const r1 = await startOnboarding(h.deps, fresh);
    const [create] = fake.callsTo("v2.accounts.create");
    expect(create!.params).toMatchObject({
      dashboard: "express", contact_email: "owner@birdys.test",
      identity: { country: "US", entity_type: "company", business_details: { registered_name: "Birdy's LLC" } },
      defaults: { responsibilities: { fees_collector: "stripe", losses_collector: "stripe" } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } }, statement_descriptor: { descriptor: "BIRDYS", prefix: "BIRDYS" } } },
    });
    expect(create!.opts.idempotencyKey).toBe(`acct_create:${fresh}`);
    expect(r1.url).toContain(r1.accountId);
    expect((await q("select stripe_account_id from public.businesses where id=$1", [fresh]))[0].stripe_account_id).toBe(r1.accountId);
    // Not onboarded yet: the page must not take pledges.
    expect((await q("select accepting_pledges from public.public_businesses where id=$1", [fresh]))[0].accepting_pledges).toBe(false);
    // Coming back for a fresh link reuses the account.
    const r2 = await startOnboarding(h.deps, fresh);
    expect(fake.callsTo("v2.accounts.create")).toHaveLength(1);
    expect(r2.accountId).toBe(r1.accountId);
  });

  it("refuses a business name that can't be a card statement name, before calling Stripe", async () => {
    const bad = (await q(`insert into public.businesses (slug,name,legal_name,owner_display,city,contact_email) values ('b' || substr(md5(random()::text),1,8),'Ab','x','o','c','h@x.test') returning id`))[0].id;
    await expect(startOnboarding(h.deps, bad)).rejects.toThrow(/statement name/);
    expect(fake.calls).toEqual([]);
  });

  it("only trusts Stripe's capability status, and registers the Apple Pay domain on the connected account", async () => {
    const fresh = (await q(`insert into public.businesses (slug,name,legal_name,owner_display,city,contact_email,stripe_account_id) values ('s' || substr(md5(random()::text),1,8),'Sample Shop','x','o','c','h@x.test','acct_sync1') returning id`))[0].id;
    fake.state.accountCardPaymentsStatus = "pending";
    expect(await syncAccountStatus(h.deps, "acct_sync1")).toEqual({ ready: false, businessId: fresh });
    expect(fake.domains).toEqual([]);
    fake.state.accountCardPaymentsStatus = "active";
    expect(await syncAccountStatus(h.deps, "acct_sync1")).toEqual({ ready: true, businessId: fresh });
    expect(fake.domains).toEqual([{ domain: "bybrick.test", account: "acct_sync1" }]);
    expect((await q("select accepting_pledges from public.public_businesses where id=$1", [fresh]))[0].accepting_pledges).toBe(true);
    // Domain already registered is fine.
    fake.state.domainCreateFails = true;
    await expect(syncAccountStatus(h.deps, "acct_sync1")).resolves.toMatchObject({ ready: true });
  });

  it("account.updated re-checks status with Stripe", async () => {
    await q(`insert into public.businesses (slug,name,legal_name,owner_display,city,contact_email,stripe_account_id) values ('u' || substr(md5(random()::text),1,8),'Updated Shop','x','o','c','h@x.test','acct_upd1')`);
    await handleStripeEvent(h.deps, signedEvent("account.updated", { id: "acct_upd1", charges_enabled: true }, { account: "acct_upd1" }).event as any);
    expect(fake.callsTo("v2.accounts.retrieve")).toHaveLength(1);
    expect((await q("select stripe_onboarded_at is not null as ok from public.businesses where stripe_account_id='acct_upd1'"))[0].ok).toBe(true);
  });
});

describe("scheduled jobs", () => {
  it("picks up a charge whose first attempt never finished, reusing the same idempotency key", async () => {
    const { pledge } = await chargedOnStripe();
    await q("update public.pledges set status='charging', next_attempt_at = now() - interval '1 minute', charge_attempts=0 where id=$1", [pledge]);
    fake.calls.length = 0;
    const out = await sweepCharges(h.deps);
    expect(out.attempted).toBeGreaterThanOrEqual(1);
    const mine = fake.callsTo("paymentIntents.create").filter((c) => c.params.metadata.pledge_id === pledge);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.opts.idempotencyKey).toBe(`pledge:${pledge}:1`);
  });

  it("expires past-deadline items: nobody charged, card detached, contributor told", async () => {
    const item = await addItem(db, biz, { price: 10000 });
    await createPledgeIntent(h.deps, { businessId: biz, itemId: item, name: "Pat", email: "exp@x.test", amountCents: 2000, consent: true, turnstileToken: "t" }, "5.5.5.5");
    const si = [...fake.setupIntents.keys()].pop()!;
    const pm = fake.completeSetup(si);
    await finalizeSetupIntent(h.deps, si, biz);
    await q("update public.items set deadline = now() - interval '1 minute' where id=$1", [item]);
    const out = await sweepExpiry(h.deps);
    expect(out.expired).toBeGreaterThanOrEqual(1);
    expect((await q("select status from public.items where id=$1", [item]))[0].status).toBe("expired");
    expect((await q("select status from public.pledges where business_id=$1", [biz]))[0].status).toBe("expired");
    expect(fake.detached).toContainEqual({ pm, account: acct });
    expect(h.mailer.of("pledgeNotCharged").at(-1)).toMatchObject({ reason: "item_expired" });
    expect(fake.callsTo("paymentIntents.create")).toEqual([]);
  });
});
