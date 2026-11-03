import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addItem, createTestDb, seedTwoBusinesses, type TestDb } from "../helpers/db";

let db: TestDb;
let s: Awaited<ReturnType<typeof seedTwoBusinesses>>;

beforeAll(async () => {
  db = await createTestDb();
  s = await seedTwoBusinesses(db);
});
afterAll(async () => { await db?.drop(); });

let biz: string;
let acct: string;
beforeEach(async () => {
  acct = "acct_" + crypto.randomBytes(6).toString("hex");
  biz = (await db.pool.query(
    `insert into public.businesses (slug,name,legal_name,owner_display,city,contact_email,stripe_account_id,stripe_onboarded_at)
     values ('t' || substr(md5(random()::text),1,8),'Biz','Biz LLC','O','Chicago','h@x.test',$1, now()) returning id`, [acct])).rows[0].id;
});

const q = async (sql: string, v: unknown[] = []) => (await db.pool.query(sql, v)).rows;
const hash = () => crypto.createHash("sha256").update(crypto.randomBytes(32)).digest();
const evt = () => "evt_" + crypto.randomBytes(8).toString("hex");

/** A funded item with one pledge in 'charging', charge_cents = price. */
async function chargingPledge(price = 10000, pm = "pm_" + crypto.randomBytes(4).toString("hex")) {
  const item = await addItem(db, biz, { price });
  const r = (await q(
    `select public.create_pledge($1,$2,'Pat','pat@x.test',$3,false,$4,'v0',now(),'cus_1',$5,$6) as res`,
    [biz, item, price, hash(), pm, "seti_" + crypto.randomBytes(5).toString("hex")]))[0].res;
  expect(r.outcome).toBe("funded");
  return { item, pledge: r.pledge_id as string, pm };
}

const succeed = (o: { event?: string; account?: string; pledge: string; amount?: number; fee?: number; proc?: number }) =>
  q(`select public.record_charge_succeeded($1,$2,$3,$7,$4,$5,$6,now()) as r`,
    [o.event ?? evt(), o.account ?? acct, o.pledge, o.amount ?? 10000, o.fee ?? 300, o.proc ?? 320, "pi_" + o.pledge]).then((r) => r[0].r);

describe("payment_intent.succeeded", () => {
  it("marks the pledge charged and writes income, platform fee and processor fee", async () => {
    const { pledge, item, pm } = await chargingPledge();
    const e = evt();
    const out = await succeed({ event: e, pledge });
    expect(out).toMatchObject({ outcome: "recorded", can_detach: true, stripe_payment_method_id: pm });
    const p = (await q("select status, charged_at, payment_intent_id from public.pledges where id=$1", [pledge]))[0];
    expect(p.status).toBe("charged");
    expect(p.charged_at).not.toBeNull();
    const l = await q("select kind, amount_cents, item_id, source_event_id from public.ledger_entries where pledge_id=$1 order by amount_cents desc", [pledge]);
    expect(l.map((x) => [x.kind, x.amount_cents])).toEqual([["contribution_income", 10000], ["platform_fee", -300], ["processor_fee", -320]]);
    expect(l.every((x) => x.item_id === item)).toBe(true);
    expect(l.map((x) => x.source_event_id)).toEqual([`${e}:income`, `${e}:platform_fee`, `${e}:processor_fee`]);
  });

  it("a replayed event does not write the ledger twice", async () => {
    const { pledge } = await chargingPledge();
    const e = evt();
    expect((await succeed({ event: e, pledge })).outcome).toBe("recorded");
    expect((await succeed({ event: e, pledge })).outcome).toBe("duplicate");
    expect((await succeed({ event: e, pledge })).outcome).toBe("duplicate");
    expect(await q("select 1 from public.ledger_entries where pledge_id=$1", [pledge])).toHaveLength(3);
    expect(await q("select 1 from public.processed_events where event_id=$1", [e])).toHaveLength(1);
  });

  it("a different event for an already-charged pledge writes nothing", async () => {
    const { pledge } = await chargingPledge();
    await succeed({ pledge });
    expect((await succeed({ pledge })).outcome).toBe("already_charged");
    expect(await q("select 1 from public.ledger_entries where pledge_id=$1", [pledge])).toHaveLength(3);
  });

  it("concurrent deliveries of the same event write the ledger once", async () => {
    const { pledge } = await chargingPledge();
    const e = evt();
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => succeed({ event: e, pledge })));
    expect(rs.filter((r) => r.status === "fulfilled" && (r.value as any).outcome === "recorded")).toHaveLength(1);
    expect(await q("select 1 from public.ledger_entries where pledge_id=$1", [pledge])).toHaveLength(3);
  });

  it("rejects an event from the wrong account, and leaves the event unprocessed", async () => {
    const { pledge } = await chargingPledge();
    const e = evt();
    await expect(succeed({ event: e, pledge, account: "acct_other" })).rejects.toThrow(/does not match the pledge/);
    expect(await q("select 1 from public.processed_events where event_id=$1", [e])).toEqual([]);
    expect(await q("select 1 from public.ledger_entries where pledge_id=$1", [pledge])).toEqual([]);
  });

  it("rejects an amount that differs from the planned charge", async () => {
    const { pledge } = await chargingPledge();
    const e = evt();
    await expect(succeed({ event: e, pledge, amount: 9999 })).rejects.toThrow(/does not match the planned charge/);
    expect(await q("select status from public.pledges where id=$1", [pledge])).toEqual([{ status: "charging" }]);
    expect(await q("select 1 from public.processed_events where event_id=$1", [e])).toEqual([]);
  });

  it("omits zero fees", async () => {
    const { pledge } = await chargingPledge();
    await succeed({ pledge, fee: 0, proc: 0 });
    expect(await q("select kind from public.ledger_entries where pledge_id=$1", [pledge])).toEqual([{ kind: "contribution_income" }]);
  });

  it("will not charge a cancelled pledge", async () => {
    const item = await addItem(db, biz, { price: 10000 });
    const h = hash();
    const r = (await q(`select public.create_pledge($1,$2,'P','p@x.test',3000,false,$3,'v0',now(),'c','pm',null) as res`, [biz, item, h]))[0].res;
    await q("select public.cancel_pledge($1)", [h]);
    await q("update public.pledges set charge_cents = 3000 where id=$1", [r.pledge_id]);
    await expect(succeed({ pledge: r.pledge_id, amount: 3000 })).rejects.toThrow(/cannot be charged/);
  });
});

describe("failed charges", () => {
  const fail = (pledge: string, o: { requiresAction?: boolean; now?: string; event?: string; token?: Buffer | null } = {}) =>
    q(`select public.record_charge_failed($1,$2,$3,'card_declined',$4,$7,$5,$6::timestamptz) as r`,
      [o.event ?? evt(), acct, pledge, o.requiresAction ?? false, o.token ?? null, o.now ?? "2027-03-01T12:00:00Z", "pi_x" + pledge]).then((r) => r[0].r);

  it("retries after 1 day, then after 3 more days, then marks failed and reports the shortfall", async () => {
    const { pledge } = await chargingPledge(10000);
    const a = await fail(pledge);
    expect(a.outcome).toBe("retry_scheduled");
    expect(new Date(a.next_attempt_at).toISOString()).toBe("2027-03-02T12:00:00.000Z");
    const b = await fail(pledge, { now: "2027-03-02T12:05:00Z" });
    expect(new Date(b.next_attempt_at).toISOString()).toBe("2027-03-05T12:05:00.000Z");
    const c = await fail(pledge, { now: "2027-03-05T12:10:00Z" });
    expect(c).toMatchObject({ outcome: "failed", next_attempt_at: null, item_shortfall_cents: 10000, can_detach: true });
    expect((await q("select status, charge_attempts from public.pledges where id=$1", [pledge]))[0]).toEqual({ status: "failed", charge_attempts: 3 });
  });

  it("claims due retries once, with a lease", async () => {
    const { pledge } = await chargingPledge();
    await fail(pledge); // retry due 2027-03-02 12:00
    const early = (await q("select public.claim_due_retries('2027-03-02T11:59:00Z') as r"))[0].r;
    expect(early).toEqual([]);
    const due = (await q("select public.claim_due_retries('2027-03-02T12:00:01Z') as r"))[0].r;
    expect(due.map((x: any) => x.pledge_id)).toEqual([pledge]);
    const again = (await q("select public.claim_due_retries('2027-03-02T12:00:02Z') as r"))[0].r;
    expect(again).toEqual([]); // leased
    const later = (await q("select public.claim_due_retries('2027-03-02T13:01:00Z') as r"))[0].r;
    expect(later).toHaveLength(1); // lease expired: not lost
  });

  it("a payment needing authentication is parked with an action token, not retried", async () => {
    const { pledge } = await chargingPledge();
    const token = hash();
    const out = await fail(pledge, { requiresAction: true, token });
    expect(out.outcome).toBe("requires_action");
    expect((await q("select status, next_attempt_at, payment_intent_id from public.pledges where id=$1", [pledge]))[0])
      .toEqual({ status: "requires_action", next_attempt_at: null, payment_intent_id: "pi_x" + pledge });
    const ctx = (await q("select public.action_context($1) as c", [token]))[0].c;
    expect(ctx).toMatchObject({ pledge_id: pledge, charge_cents: 10000, payment_intent_id: "pi_x" + pledge, stripe_account_id: acct });
    expect((await q("select public.action_context($1) as c", [hash()]))[0].c).toBeNull();
    // After the customer authenticates, success clears the token.
    await succeed({ pledge });
    expect((await q("select public.action_context($1) as c", [token]))[0].c).toBeNull();
  });

  it("a replayed failure event is counted once", async () => {
    const { pledge } = await chargingPledge();
    const e = evt();
    await fail(pledge, { event: e });
    expect((await fail(pledge, { event: e })).outcome).toBe("duplicate");
    expect((await q("select charge_attempts from public.pledges where id=$1", [pledge]))[0].charge_attempts).toBe(1);
  });

  it("failure of one pledge only reports a shortfall for the share that is actually missing", async () => {
    const item = await addItem(db, biz, { price: 10000 });
    const mk = async (amt: number) => (await q(`select public.create_pledge($1,$2,'P','p@x.test',$3,false,$4,'v0',now(),'c',$5,null) as res`, [biz, item, amt, hash(), "pm_" + amt]))[0].res;
    const a = await mk(6000);
    const b = await mk(4000);
    expect(b.outcome).toBe("funded");
    await fail(a.pledge_id); await fail(a.pledge_id, { now: "2027-03-02T12:05:00Z" });
    const last = await fail(a.pledge_id, { now: "2027-03-05T12:10:00Z" });
    expect(last.item_shortfall_cents).toBe(6000);
    // The owner can then close it out for exactly that shortfall.
    const owner = crypto.randomUUID();
    await db.pool.query("insert into auth.users (id) values ($1)", [owner]);
    await db.pool.query("update public.businesses set owner_user_id=$1 where id=$2", [owner, biz]);
    const co = (await q("select public.close_it_out($1,$2) as r", [item, owner]))[0].r;
    expect(co.owner_capital_cents).toBe(6000);
  });
});

describe("refunds", () => {
  const refund = (pledge: string, cents: number, feeRefunded: boolean, event = evt()) =>
    q(`select public.record_refund($1,$2,$3,$4,$5,now()) as r`, [event, acct, pledge, cents, feeRefunded]).then((r) => r[0].r);

  it("a full refund with the fee refunded reverses the platform fee entry", async () => {
    const { pledge } = await chargingPledge();
    await succeed({ pledge });
    const out = await refund(pledge, 10000, true);
    expect(out).toMatchObject({ outcome: "recorded", full_refund: true });
    const net = (await q("select sum(amount_cents)::int as n from public.ledger_entries where pledge_id=$1", [pledge]))[0].n;
    expect(net).toBe(-320); // income - refund = 0, fee reversed, only the processor fee remains
  });

  it("a partial refund records the refund only", async () => {
    const { pledge } = await chargingPledge();
    await succeed({ pledge });
    await refund(pledge, 2500, true);
    const kinds = (await q("select kind from public.ledger_entries where pledge_id=$1 order by created_at, kind", [pledge])).map((r) => r.kind);
    expect(kinds).not.toContain("reversal");
    expect(kinds).toContain("refund");
  });

  it("replays are ignored; uncharged pledges cannot be refunded", async () => {
    const { pledge } = await chargingPledge();
    await expect(refund(pledge, 100, false)).rejects.toThrow(/nothing to refund/);
    await succeed({ pledge });
    const e = evt();
    await refund(pledge, 10000, false, e);
    expect((await refund(pledge, 10000, false, e)).outcome).toBe("duplicate");
    expect(await q("select 1 from public.ledger_entries where pledge_id=$1 and kind='refund'", [pledge])).toHaveLength(1);
  });
});

describe("lookups and account state", () => {
  it("payment_context returns the account from the database and rejects a mismatched item", async () => {
    const item = await addItem(db, biz, { price: 10000 });
    const ctx = (await q("select public.payment_context($1,$2) as c", [biz, item]))[0].c;
    expect(ctx.business).toMatchObject({ stripe_account_id: acct, ready: true, legal_name: "Biz LLC" });
    expect(ctx.item).toMatchObject({ id: item, goal_cents: 10000, remaining_cents: 10000, status: "open" });
    const other = await addItem(db, s.bizB);
    await expect(q("select public.payment_context($1,$2)", [biz, other])).rejects.toThrow(/does not belong/);
    expect((await q("select public.payment_context($1,null) as c", [biz]))[0].c.item).toBeNull();
  });

  it("remaining shrinks as pledges arrive", async () => {
    const item = await addItem(db, biz, { price: 10000 });
    await q(`select public.create_pledge($1,$2,'P','p@x.test',3000,false,$3,'v0',now(),'c','pm',null)`, [biz, item, hash()]);
    expect((await q("select public.payment_context($1,$2) as c", [biz, item]))[0].c.item.remaining_cents).toBe(7000);
  });

  it("onboarding: account set once; readiness toggles the public flag", async () => {
    const fresh = (await q(`insert into public.businesses (slug,name,legal_name,owner_display,city,contact_email) values ('f' || substr(md5(random()::text),1,8),'F','F','o','c','h@x.test') returning id`))[0].id;
    expect((await q("select accepting_pledges from public.public_businesses where id=$1", [fresh]))[0].accepting_pledges).toBe(false);
    await q("select public.set_stripe_account($1,'acct_abc123')", [fresh]);
    await q("select public.set_stripe_account($1,'acct_abc123')", [fresh]); // same id again is fine
    await expect(q("select public.set_stripe_account($1,'acct_zzz')", [fresh])).rejects.toThrow(/different Stripe account/);
    expect((await q("select accepting_pledges from public.public_businesses where id=$1", [fresh]))[0].accepting_pledges).toBe(false);
    expect((await q("select public.set_onboarding_status('acct_abc123', true) as r"))[0].r).toBe(fresh);
    expect((await q("select accepting_pledges from public.public_businesses where id=$1", [fresh]))[0].accepting_pledges).toBe(true);
    await q("select public.set_onboarding_status('acct_abc123', false)");
    expect((await q("select accepting_pledges from public.public_businesses where id=$1", [fresh]))[0].accepting_pledges).toBe(false);
    expect((await q("select public.set_onboarding_status('acct_nope', true) as r"))[0].r).toBeNull();
  });

  it("an owner cannot mark themselves onboarded or set an account", async () => {
    await expect(db.as("authenticated", s.ownerA, (c) => c.query("update public.businesses set stripe_onboarded_at = now()"))).rejects.toThrow(/permission denied/);
    await expect(db.as("authenticated", s.ownerA, (c) => c.query("select public.set_stripe_account($1,'acct_x1')", [s.bizA]))).rejects.toThrow(/permission denied/);
  });
});

describe("rate limiting", () => {
  it("allows up to the max in a window, then blocks, then resets", async () => {
    const key = "k_" + crypto.randomBytes(4).toString("hex");
    const hit = () => q("select public.hit_rate_limit($1,3,interval '1 minute') as ok", [key]).then((r) => r[0].ok as boolean);
    expect([await hit(), await hit(), await hit(), await hit(), await hit()]).toEqual([true, true, true, false, false]);
    await q("update public.rate_limits set window_start = now() - interval '2 minutes' where key=$1", [key]);
    expect(await hit()).toBe(true);
  });

  it("is closed to browser roles", async () => {
    await expect(db.as("anon", null, (c) => c.query("select public.hit_rate_limit('x',1,interval '1 minute')"))).rejects.toThrow(/permission denied/);
    await expect(db.as("authenticated", s.ownerA, (c) => c.query("select * from public.rate_limits"))).rejects.toThrow(/permission denied/);
  });
});
