import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addItem, createTestDb, seedTwoBusinesses, type TestDb } from "../helpers/db";
import { makeDeps, makeFakeStripe, type FakeStripe } from "../helpers/payments";
import { createPledgeIntent, finalizeSetupIntent, PledgeError } from "@/lib/payments/pledges";
import { chargePledge } from "@/lib/payments/charging";
import { hashToken } from "@/lib/payments/tokens";

let db: TestDb;
let s: Awaited<ReturnType<typeof seedTwoBusinesses>>;
beforeAll(async () => { db = await createTestDb(); s = await seedTwoBusinesses(db); });
afterAll(async () => { await db?.drop(); });

let biz: string, acct: string, fake: FakeStripe, h: ReturnType<typeof makeDeps>, ipN = 0, defaultItem: string;
beforeEach(async () => {
  acct = "acct_" + crypto.randomBytes(6).toString("hex");
  biz = (await db.pool.query(
    `insert into public.businesses (slug,name,legal_name,owner_display,city,contact_email,stripe_account_id,stripe_onboarded_at)
     values ('t' || substr(md5(random()::text),1,8), 'BIRDY''S', 'Birdy''s LLC','O','Chicago','h@x.test',$1, now()) returning id`, [acct])).rows[0].id;
  fake = makeFakeStripe();
  h = makeDeps(db, fake);
  defaultItem = await addItem(db, biz, { price: 100000 });
});

const q = async (sql: string, v: unknown[] = []) => (await db.pool.query(sql, v)).rows;
const input = (over: Record<string, unknown> = {}) => ({
  businessId: biz, itemId: defaultItem, name: "Pat Neighbor", email: `p${crypto.randomBytes(4).toString("hex")}@x.test`,
  amountCents: 5000, consent: true, turnstileToken: "tok", ...over,
});
const intent = (over: Record<string, unknown> = {}) => createPledgeIntent(h.deps, input(over), `10.0.0.${++ipN}`);
const lastSi = () => [...fake.setupIntents.keys()].pop()!;
async function pledgeThrough(over: Record<string, unknown> = {}) {
  const r = await intent(over);
  const si = lastSi();
  fake.completeSetup(si);
  return { r, si, fin: await finalizeSetupIntent(h.deps, si, biz) };
}
const code = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof PledgeError ? e.code : `other:${e}`));

describe("step 1: createPledgeIntent", () => {
  it("creates a customer and setup intent on the business's account, taken from the database", async () => {
    const item = await addItem(db, biz, { price: 10000 });
    const r = await intent({ itemId: item, amountCents: 4000 });
    expect(r.stripeAccount).toBe(acct);
    expect(r.consentText).toContain("BIRDYS"); // the apostrophe-free statement name
    expect(r.consentText).toContain("$40");
    const [cust] = fake.callsTo("customers.create");
    const [si] = fake.callsTo("setupIntents.create");
    expect(cust!.opts).toEqual({ stripeAccount: acct });
    expect(si!.opts).toEqual({ stripeAccount: acct });
    expect(si!.params).toMatchObject({ usage: "off_session", metadata: { business_id: biz, item_id: item, amount_cents: "4000", consent_version: "v2-draft" } });
    expect(r.applePay.deferredBilling.amount).toBe(4000);
    // No pledge exists yet and nothing was charged.
    expect(await q("select 1 from public.pledges where business_id=$1", [biz])).toEqual([]);
    expect(fake.callsTo("paymentIntents.create")).toEqual([]);
  });

  it("ignores any account id or fee sent by the browser", async () => {
    await intent({ stripeAccount: "acct_evil", application_fee_amount: 1, accountId: "acct_evil" });
    expect(fake.callsTo("setupIntents.create")[0]!.opts).toEqual({ stripeAccount: acct });
  });

  it("rejects a tampered item id (another business's item) before touching Stripe", async () => {
    const other = await addItem(db, s.bizB);
    expect(await code(intent({ itemId: other }))).toBe("not_found");
    expect(fake.calls).toEqual([]);
  });

  it("checks the amount against the remaining balance in the database", async () => {
    const item = await addItem(db, biz, { price: 10000 });
    expect(await code(intent({ itemId: item, amountCents: 10001 }))).toBe("amount_too_high");
    expect(await code(intent({ itemId: item, amountCents: 499 }))).toBe("amount_too_low");
    expect(await code(intent({ itemId: null }))).toBe("invalid");
    expect(await code(intent({ amountCents: 1.5 }))).toBe("invalid");
    expect(await code(intent({ amountCents: -5 }))).toBe("invalid");
    expect(fake.calls).toEqual([]);
  });

  it("lets the last few dollars of an item through even below the minimum", async () => {
    const item = await addItem(db, biz, { price: 10000 });
    await pledgeThrough({ itemId: item, amountCents: 9700 });
    expect(await code(intent({ itemId: item, amountCents: 300 }))).toBe("ok");
  });

  it("requires explicit consent, valid input and a passing bot check", async () => {
    expect(await code(intent({ consent: false }))).toBe("invalid");
    expect(await code(intent({ consent: undefined }))).toBe("invalid");
    expect(await code(intent({ email: "not-an-email" }))).toBe("invalid");
    expect(await code(intent({ name: "<script>" }))).toBe("invalid");
    h.turnstile.ok = false;
    expect(await code(intent())).toBe("bot_check_failed");
    expect(fake.calls).toEqual([]);
  });

  it("rate limits per IP and per email", async () => {
    const same = input({ email: "same@x.test" });
    const results: string[] = [];
    for (let i = 0; i < 7; i++) results.push(await code(createPledgeIntent(h.deps, same, `9.9.9.${i}`)));
    expect(results.slice(0, 5)).toEqual(Array(5).fill("ok"));
    expect(results.slice(5)).toEqual(["rate_limited", "rate_limited"]);
    const ip = "8.8.8.8";
    const byIp: string[] = [];
    for (let i = 0; i < 12; i++) byIp.push(await code(createPledgeIntent(h.deps, input(), ip)));
    expect(byIp.filter((x) => x === "ok")).toHaveLength(10);
    expect(byIp.slice(10)).toEqual(["rate_limited", "rate_limited"]);
  });

  it("will not take pledges for a business that hasn't finished Stripe onboarding", async () => {
    await q("update public.businesses set stripe_onboarded_at = null where id=$1", [biz]);
    expect(await code(intent())).toBe("business_not_ready");
  });

  it("refuses a closed item and an unknown one", async () => {
    const item = await addItem(db, biz, { price: 5000, status: "funded" });
    expect(await code(intent({ itemId: item }))).toBe("item_closed");
    expect(await code(intent({ itemId: crypto.randomUUID() }))).toBe("not_found");
    expect(fake.calls).toEqual([]);
  });

  it("has no pool or send-extra option: unknown fields are ignored, not honored", async () => {
    const item = await addItem(db, biz, { price: 10000 });
    await intent({ itemId: item, sendExtraToPool: true, pool: true });
    const md = fake.callsTo("setupIntents.create")[0]!.params.metadata;
    expect(md.item_id).toBe(item);
    expect(Object.keys(md).join()).not.toMatch(/pool|extra/i);
  });
});

describe("step 2: finalizeSetupIntent", () => {
  it("creates the pledge, emails a manage link whose hash is what we stored, and does not charge yet", async () => {
    const item = await addItem(db, biz, { price: 10000, name: "Cooler" });
    const { fin } = await pledgeThrough({ itemId: item, amountCents: 4000, name: "Pat Neighbor" });
    expect(fin.outcome).toBe("pending");
    const [mail] = h.mailer.of("pledgeConfirmation");
    expect(mail).toMatchObject({ name: "Pat Neighbor", itemName: "Cooler", amountCents: 4000, businessName: "BIRDY'S" });
    const token = mail.manageUrl.split("/manage/")[1];
    expect(token).toHaveLength(43);
    const row = (await q("select status, amount_cents, manage_token_hash = decode($2,'hex') as hash_ok, consent_text_version from public.pledges where business_id=$1", [biz, hashToken(token).slice(2)]))[0];
    expect(row).toEqual({ status: "pending", amount_cents: 4000, hash_ok: true, consent_text_version: "v2-draft" });
    expect(await q("select 1 from public.pledges where manage_token_hash is not null and encode(manage_token_hash,'escape') like '%' || $1 || '%'", [token])).toEqual([]);
    expect(fake.callsTo("paymentIntents.create")).toEqual([]);
  });

  it("is idempotent: the webhook and the return page can both call it", async () => {
    const item = await addItem(db, biz, { price: 10000 });
    await intent({ itemId: item });
    const si = lastSi(); fake.completeSetup(si);
    expect((await finalizeSetupIntent(h.deps, si, biz)).outcome).toBe("pending");
    expect((await finalizeSetupIntent(h.deps, si, biz)).outcome).toBe("duplicate");
    expect(await q("select 1 from public.pledges where business_id=$1", [biz])).toHaveLength(1);
    expect(h.mailer.of("pledgeConfirmation")).toHaveLength(1);
  });

  it("refuses a setup intent that isn't finished, isn't ours, or belongs to another business", async () => {
    await intent();
    const si = lastSi();
    expect(await code(finalizeSetupIntent(h.deps, si, biz))).toBe("not_ready_to_finalize");
    fake.completeSetup(si);
    const otherAcct = "acct_" + crypto.randomBytes(4).toString("hex");
    const otherBiz = (await q(`insert into public.businesses (slug,name,legal_name,owner_display,city,contact_email,stripe_account_id,stripe_onboarded_at) values ('o' || substr(md5(random()::text),1,8),'Other','Other','o','c','h@x.test',$1,now()) returning id`, [otherAcct]))[0].id;
    // Looked up under the other business's account, the intent doesn't exist.
    await expect(finalizeSetupIntent(h.deps, si, otherBiz)).rejects.toThrow(/No such setupintent/);
    expect(await code(finalizeSetupIntent(h.deps, "seti_nope", biz))).toMatch(/other:/);
    expect(await code(finalizeSetupIntent(h.deps, "not-an-id", biz))).toBe("invalid");
    expect(await q("select 1 from public.pledges where business_id in ($1,$2)", [biz, otherBiz])).toEqual([]);
  });

  it("a pledge that finishes the item is charged immediately: amount and fee from the database", async () => {
    const item = await addItem(db, biz, { price: 10000, name: "Cooler" });
    await pledgeThrough({ itemId: item, amountCents: 6000 });
    const { fin } = await pledgeThrough({ itemId: item, amountCents: 4000 });
    expect(fin.outcome).toBe("funded");
    const creates = fake.callsTo("paymentIntents.create");
    expect(creates).toHaveLength(2);
    for (const c of creates) {
      expect(c.opts.stripeAccount).toBe(acct);
      expect(c.params).toMatchObject({ currency: "usd", off_session: true, confirm: true });
      expect(c.params.application_fee_amount).toBe(Math.round(c.params.amount * 0.03));
      expect(c.opts.idempotencyKey).toBe(`pledge:${c.params.metadata.pledge_id}:1`);
    }
    expect(creates.map((c) => c.params.amount).sort()).toEqual([4000, 6000]);
    expect(await q("select status from public.pledges where business_id=$1", [biz])).toEqual([{ status: "charging" }, { status: "charging" }]);
    // The ledger is NOT written here; only a verified webhook does that.
    expect(await q("select 1 from public.ledger_entries where business_id=$1", [biz])).toEqual([]);
  });

  it("overflow: the crossing pledge is charged only what's needed", async () => {
    const item = await addItem(db, biz, { price: 10000 });
    await pledgeThrough({ itemId: item, amountCents: 6000 });
    // Two people confirm after both saw $40 left: this one pledged $60 earlier.
    const r = await intent({ itemId: item, amountCents: 4000 }); // validated against what's left now
    fake.completeSetup(lastSi());
    // Simulate a stale pledge of $60 by tampering with the stored amount the way a race would.
    fake.setupIntents.get(lastSi()).metadata.amount_cents = "6000";
    await finalizeSetupIntent(h.deps, lastSi(), biz);
    const amounts = fake.callsTo("paymentIntents.create").map((c) => c.params.amount).sort();
    expect(amounts).toEqual([4000, 6000]);
  });

  it("item filled before confirmation: card detached, nothing recorded, contributor told", async () => {
    const item = await addItem(db, biz, { price: 5000 });
    await intent({ itemId: item, amountCents: 5000 });
    const lateSi = lastSi();
    await pledgeThrough({ itemId: item, amountCents: 5000 }); // someone else finishes it first
    const pm = fake.completeSetup(lateSi);
    const fin = await finalizeSetupIntent(h.deps, lateSi, biz);
    expect(fin.outcome).toBe("item_closed");
    expect(fake.detached).toContainEqual({ pm, account: acct });
    expect(h.mailer.of("pledgeNotCharged").at(-1)).toMatchObject({ reason: "item_closed" });
    expect(await q("select 1 from public.pledges where business_id=$1 and setup_intent_id=$2", [biz, lateSi])).toEqual([]);
  });
});

describe("charging", () => {
  async function chargingPledge() {
    const item = await addItem(db, biz, { price: 10000 });
    // Create the pledge but stop the automatic charge by pointing the fake at a failure later.
    const r = await intent({ itemId: item, amountCents: 10000 });
    void r;
    const si = lastSi(); fake.completeSetup(si);
    fake.state.nextCharge = { kind: "processing" };
    await finalizeSetupIntent(h.deps, si, biz);
    const p = (await q("select id from public.pledges where business_id=$1", [biz]))[0].id as string;
    fake.calls.length = 0;
    return { item, pledge: p };
  }

  it("a decline schedules a retry and does not email or detach", async () => {
    const { pledge } = await chargingPledge();
    fake.state.nextCharge = { kind: "decline", code: "card_declined" };
    expect(await chargePledge(h.deps, pledge)).toBe("retry_scheduled");
    expect((await q("select status, charge_attempts, last_error_code from public.pledges where id=$1", [pledge]))[0]).toEqual({ status: "charging", charge_attempts: 1, last_error_code: "card_declined" });
    expect(h.mailer.of("actionNeeded")).toEqual([]);
    expect(fake.detached).toEqual([]);
  });

  it("the retry uses a fresh idempotency key; a crash and rerun of the same attempt reuses it", async () => {
    const { pledge } = await chargingPledge();
    fake.state.nextCharge = { kind: "network" };
    await expect(chargePledge(h.deps, pledge)).rejects.toThrow();
    // Network trouble is not a decline: nothing recorded, the lease will bring it back.
    expect((await q("select charge_attempts from public.pledges where id=$1", [pledge]))[0].charge_attempts).toBe(0);
    fake.state.nextCharge = { kind: "decline", code: "card_declined" };
    await chargePledge(h.deps, pledge);
    fake.state.nextCharge = { kind: "decline", code: "card_declined" };
    await chargePledge(h.deps, pledge);
    const keys = fake.callsTo("paymentIntents.create").map((c) => c.opts.idempotencyKey);
    expect(keys).toEqual([`pledge:${pledge}:1`, `pledge:${pledge}:1`, `pledge:${pledge}:2`]);
  });

  it("three failures mark it failed, detach the card, tell the contributor and the owner", async () => {
    const { pledge, item } = await chargingPledge();
    const owner = crypto.randomUUID();
    await db.pool.query("insert into auth.users (id) values ($1)", [owner]);
    for (let i = 0; i < 3; i++) {
      fake.state.nextCharge = { kind: "decline", code: "insufficient_funds" };
      await chargePledge(h.deps, pledge);
      await q("update public.pledges set next_attempt_at = now() where id=$1 and status='charging'", [pledge]);
    }
    expect((await q("select status from public.pledges where id=$1", [pledge]))[0].status).toBe("failed");
    expect(fake.detached).toHaveLength(1);
    expect(h.mailer.of("pledgeNotCharged").at(-1)).toMatchObject({ reason: "charge_failed" });
    expect(h.mailer.of("ownerItemShort")).toEqual([{ businessId: biz, itemId: item, shortfallCents: 10000 }]);
  });

  it("authentication required: parked, emailed a finish link whose hash we stored", async () => {
    const { pledge } = await chargingPledge();
    fake.state.nextCharge = { kind: "auth_required" };
    expect(await chargePledge(h.deps, pledge)).toBe("requires_action");
    const [mail] = h.mailer.of("actionNeeded");
    const token = mail.actionUrl.split("/pay/")[1];
    const ctx = (await q("select public.action_context(decode($1,'hex')) as c", [hashToken(token).slice(2)]))[0].c;
    expect(ctx).toMatchObject({ pledge_id: pledge, charge_cents: 10000, stripe_account_id: acct });
    expect((await q("select status from public.pledges where id=$1", [pledge]))[0].status).toBe("requires_action");
  });

  it("does nothing for a pledge that is not in the charging state (e.g. cancelled)", async () => {
    const { pledge } = await chargingPledge();
    await q("update public.pledges set status='cancelled' where id=$1", [pledge]);
    expect(await chargePledge(h.deps, pledge)).toBe("skipped");
    expect(fake.callsTo("paymentIntents.create")).toEqual([]);
  });

  it("a successful response is not trusted for the ledger", async () => {
    const { pledge } = await chargingPledge();
    expect(await chargePledge(h.deps, pledge)).toBe("succeeded");
    expect((await q("select status from public.pledges where id=$1", [pledge]))[0].status).toBe("charging");
    expect(await q("select 1 from public.ledger_entries where business_id=$1", [biz])).toEqual([]);
  });
});
