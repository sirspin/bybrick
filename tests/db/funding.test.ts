import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addItem, addPledge, createTestDb, seedTwoBusinesses, type TestDb } from "../helpers/db";

let db: TestDb;
let s: Awaited<ReturnType<typeof seedTwoBusinesses>>;

beforeAll(async () => {
  db = await createTestDb();
  s = await seedTwoBusinesses(db);
});
afterAll(async () => { await db?.drop(); });

// Each test gets its own business so state never leaks between tests.
let biz: string;
let owner: string;
beforeEach(async () => {
  owner = crypto.randomUUID();
  await db.pool.query("insert into auth.users (id, email) values ($1, $2)", [owner, `${owner}@x.test`]);
  const slug = "t" + crypto.randomBytes(5).toString("hex");
  biz = (await db.pool.query(
    `insert into public.businesses (slug,name,legal_name,owner_display,city,contact_email,owner_user_id)
     values ($1,$1,$1,'O','Chicago','h@x.test',$2) returning id`, [slug, owner])).rows[0].id;
});

const hash = () => crypto.createHash("sha256").update(crypto.randomBytes(32)).digest();
const dollars = (n: number) => n * 100;

interface P { item: string; amount: number; pm?: string; si?: string | null; hash?: Buffer; business?: string; name?: string }
async function pledge(p: P) {
  const r = await db.pool.query(
    `select public.create_pledge($1,$2,$3,$4,$5,$6,'v0-draft',now(),$7,$8,$9) as res`,
    [p.business ?? biz, p.item, p.name ?? "Pat", "pat@x.test", p.amount, p.hash ?? hash(),
     "cus_" + crypto.randomBytes(3).toString("hex"), p.pm ?? "pm_" + crypto.randomBytes(4).toString("hex"),
     p.si === undefined ? "seti_" + crypto.randomBytes(5).toString("hex") : p.si]);
  return r.rows[0].res as { pledge_id: string | null; outcome: string; charges: any[] };
}
const q = async (sql: string, v: unknown[] = []) => (await db.pool.query(sql, v)).rows;
const item = async (id: string) => (await q("select status, goal_locked_at from public.items where id=$1", [id]))[0];
const sumCharges = (res: { charges: any[] }) => res.charges.reduce((a, c) => a + c.charge_cents, 0);

describe("create_pledge and the funding check", () => {
  it("keeps a pledge pending below the goal, and locks the goal", async () => {
    const i = await addItem(db, biz, { price: dollars(100) });
    expect((await item(i)).goal_locked_at).toBeNull();
    const res = await pledge({ item: i, amount: dollars(30) });
    expect(res.outcome).toBe("pending");
    expect(res.charges).toEqual([]);
    const it = await item(i);
    expect(it.status).toBe("open");
    expect(it.goal_locked_at).not.toBeNull();
    await expect(db.pool.query("update public.items set price_cents = 1 where id=$1", [i])).rejects.toThrow(/goal is locked/);
  });

  it("funds the item when a pledge reaches the goal and charges every pending pledge", async () => {
    const i = await addItem(db, biz, { price: dollars(100) });
    await pledge({ item: i, amount: dollars(40) });
    await pledge({ item: i, amount: dollars(30) });
    const res = await pledge({ item: i, amount: dollars(30) });
    expect(res.outcome).toBe("funded");
    expect(res.charges).toHaveLength(3);
    expect(sumCharges(res)).toBe(dollars(100));
    expect((await item(i)).status).toBe("funded");
    const rows = await q("select status, charge_cents from public.pledges where item_id=$1", [i]);
    expect(rows.every((r) => r.status === "charging")).toBe(true);
  });

  it("overflow: the crossing pledge is charged only what is needed, and the rest is not charged", async () => {
    const i = await addItem(db, biz, { price: dollars(100) });
    await pledge({ item: i, amount: dollars(60) });
    const res = await pledge({ item: i, amount: dollars(60) });
    expect(res.charges.map((c) => c.charge_cents).sort()).toEqual([dollars(40), dollars(60)]);
    expect(sumCharges(res)).toBe(dollars(100));
    // Nothing else is created for the leftover $20.
    expect(await q("select 1 from public.pledges where business_id=$1", [biz])).toHaveLength(2);
  });

  it("charges nothing for a pledge that arrives entirely after the goal is covered (oldest first)", async () => {
    const i = await addItem(db, biz, { price: dollars(100) });
    // Three pledges already pending (as if confirmed at the same moment): 50, 50, 50.
    const a = await addPledge(db, { businessId: biz, itemId: i, amount: dollars(50), createdAt: "2027-01-01T00:00:01Z" });
    const b = await addPledge(db, { businessId: biz, itemId: i, amount: dollars(50), createdAt: "2027-01-01T00:00:02Z" });
    const c = await addPledge(db, { businessId: biz, itemId: i, amount: dollars(50), createdAt: "2027-01-01T00:00:03Z" });
    await db.pool.query("update public.items set goal_locked_at=now() where id=$1", [i]);
    const charges = (await q("select private.fund_item($1) as c", [i]))[0].c;
    expect(charges.map((x: any) => x.pledge_id).sort()).toEqual([a, b].sort());
    const third = (await q("select status, charge_cents from public.pledges where id=$1", [c]))[0];
    expect(third).toEqual({ status: "cancelled", charge_cents: 0 });
  });

  it("late arrival after the item is funded: nothing is recorded", async () => {
    const i = await addItem(db, biz, { price: dollars(50) });
    await pledge({ item: i, amount: dollars(50) });
    const late = await pledge({ item: i, amount: dollars(20) });
    expect(late).toMatchObject({ outcome: "item_closed", pledge_id: null, charges: [] });
    expect(await q("select 1 from public.pledges where item_id=$1", [i])).toHaveLength(1);
  });

  it("is replay-safe: the same setup intent is recorded once", async () => {
    const i = await addItem(db, biz, { price: dollars(100) });
    const first = await pledge({ item: i, amount: dollars(10), si: "seti_same" });
    const again = await pledge({ item: i, amount: dollars(10), si: "seti_same" });
    expect(first.outcome).toBe("pending");
    expect(again.outcome).toBe("duplicate");
    expect(await q("select 1 from public.pledges where setup_intent_id='seti_same'")).toHaveLength(1);
  });

  it("rejects an item that belongs to another business (tampered item id)", async () => {
    const other = await addItem(db, s.bizB);
    await expect(pledge({ item: other, amount: dollars(10) })).rejects.toThrow(/does not belong/);
    expect(await q("select 1 from public.pledges where item_id=$1", [other])).toEqual([]);
  });

  it("does not take pledges for draft or expired items", async () => {
    const d = await addItem(db, biz, { status: "draft" });
    expect((await pledge({ item: d, amount: dollars(10) })).outcome).toBe("item_closed");
    const past = await addItem(db, biz, { deadlineDays: -1 });
    expect((await pledge({ item: past, amount: dollars(10) })).outcome).toBe("item_closed");
  });

  it("every pledge must belong to an item: there is no pool", async () => {
    await expect(db.pool.query(
      `insert into public.pledges (business_id, item_id, contributor_name, contributor_email, amount_cents, manage_token_hash, consent_text_version, consented_at)
       values ($1, null, 'P', 'p@x.test', 1000, $2, 'v', now())`, [biz, hash()])).rejects.toThrow(/null value|not-null/);
    const cols = (await q("select column_name from information_schema.columns where table_name='pledges'")).map((c) => c.column_name);
    expect(cols).not.toContain("send_extra_to_pool");
    expect(cols).not.toContain("split_from_pledge_id");
  });
});

describe("concurrency", () => {
  it("many simultaneous pledges fund the item exactly once and charge exactly the goal", async () => {
    const i = await addItem(db, biz, { price: dollars(100) });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, n) => pledge({ item: i, amount: dollars(30), name: `P${n}` })),
    );
    const allCharges = results.flatMap((r) => r.charges);
    // The item was funded by exactly one call.
    expect(results.filter((r) => r.outcome === "funded")).toHaveLength(1);
    expect(allCharges.reduce((a, c) => a + c.charge_cents, 0)).toBe(dollars(100));
    expect(new Set(allCharges.map((c) => c.pledge_id)).size).toBe(allCharges.length);
    expect((await item(i)).status).toBe("funded");

    // Pledges that came after the item filled were not recorded at all.
    const recorded = results.filter((r) => r.pledge_id !== null).length;
    const closed = results.filter((r) => r.outcome === "item_closed").length;
    expect(recorded + closed).toBe(10);
    const [{ charged }] = await q("select coalesce(sum(charge_cents),0)::int as charged from public.pledges where item_id=$1 and status='charging'", [i]);
    expect(charged).toBe(dollars(100));
    // No pledge is ever charged more than it pledged.
    expect(await q("select 1 from public.pledges where charge_cents > amount_cents")).toEqual([]);
  });

  it("concurrent pledges on different businesses stay correct", async () => {
    const other = (await db.pool.query(
      `insert into public.businesses (slug,name,legal_name,owner_display,city,contact_email)
       values ('c' || substr(md5(random()::text),1,6),'x','x','o','c','h@x.test') returning id`)).rows[0].id as string;
    const i1 = await addItem(db, biz, { price: dollars(60) });
    const i2 = await addItem(db, other, { price: dollars(60) });
    const rs = await Promise.all([
      ...Array.from({ length: 4 }, () => pledge({ item: i1, amount: dollars(15) })),
      ...Array.from({ length: 4 }, () => pledge({ item: i2, amount: dollars(15), business: other })),
    ]);
    expect(rs.filter((r) => r.outcome === "funded")).toHaveLength(2);
    expect((await item(i1)).status).toBe("funded");
    expect((await item(i2)).status).toBe("funded");
  });
});

describe("deadline expiry", () => {
  it("expires unfunded items and their pledges, charges nobody, and says what can be detached", async () => {
    const a = await addItem(db, biz, { price: dollars(100) });
    const b = await addItem(db, biz, { price: dollars(100), deadlineDays: 30 });
    await db.pool.query("update public.items set deadline = now() + interval '1 day' where id=$1", [a]);
    await pledge({ item: a, amount: dollars(20), pm: "pm_a" });
    await pledge({ item: a, amount: dollars(20), pm: "pm_shared" });
    await pledge({ item: b, amount: dollars(10), pm: "pm_shared" }); // same card also backs a pledge on a later item
    const out = await q("select public.expire_due(now() + interval '2 days', $1) as r", [biz]);
    const expired = out[0].r as any[];
    expect(expired).toHaveLength(2);
    expect((await item(a)).status).toBe("expired");
    expect((await item(b)).status).toBe("open");
    expect(await q("select 1 from public.pledges where charge_cents is not null and business_id=$1", [biz])).toEqual([]);
    const byPm = Object.fromEntries(expired.map((e) => [e.stripe_payment_method_id, e.can_detach]));
    expect(byPm.pm_a).toBe(true);
    expect(byPm.pm_shared).toBe(false); // still needed by the live pledge on item b
  });

  it("leaves funded items alone", async () => {
    const i = await addItem(db, biz, { price: dollars(50) });
    await pledge({ item: i, amount: dollars(50) });
    const out = (await q("select public.expire_due(now() + interval '400 days', $1) as r", [biz]))[0].r;
    expect(out).toEqual([]);
    expect((await item(i)).status).toBe("funded");
  });
});

describe("close it out", () => {
  async function stalled() {
    const i = await addItem(db, biz, { price: dollars(100) });
    const a = await pledge({ item: i, amount: dollars(30) });
    const b = await pledge({ item: i, amount: dollars(20) });
    return { i, a, b };
  }

  it("records owner capital for exactly the remainder and charges the pending pledges in full", async () => {
    const { i } = await stalled();
    const res = (await q("select public.close_it_out($1,$2) as r", [i, owner]))[0].r;
    expect(res.owner_capital_cents).toBe(dollars(50));
    expect(res.charges.map((c: any) => c.charge_cents).sort()).toEqual([dollars(20), dollars(30)]);
    expect((await item(i)).status).toBe("funded");
    const ledger = await q("select kind, amount_cents, item_id from public.ledger_entries where business_id=$1", [biz]);
    expect(ledger).toEqual([{ kind: "owner_capital", amount_cents: dollars(50), item_id: i }]);
    // Contribution vs owner capital split adds up to the goal.
    const pledged = res.charges.reduce((x: number, c: any) => x + c.charge_cents, 0);
    expect(pledged + ledger[0].amount_cents).toBe(dollars(100));
  });

  it("writes an audit row", async () => {
    const { i } = await stalled();
    await q("select public.close_it_out($1,$2)", [i, owner]);
    const a = await q("select action, actor_user_id, target_id, details from public.owner_actions where business_id=$1", [biz]);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action: "close_it_out", actor_user_id: owner, target_id: i });
    expect(a[0].details.owner_capital_cents).toBe(dollars(50));
  });

  it("refuses anyone but the owner, and refuses a second close-out with nothing to cover", async () => {
    const { i } = await stalled();
    await expect(q("select public.close_it_out($1,$2)", [i, s.ownerB])).rejects.toThrow(/only the business owner/);
    expect(await q("select 1 from public.ledger_entries where business_id=$1", [biz])).toEqual([]);
    await q("select public.close_it_out($1,$2)", [i, owner]);
    await expect(q("select public.close_it_out($1,$2)", [i, owner])).rejects.toThrow(/nothing left to cover|cannot be closed out|check/i);
    expect(await q("select 1 from public.ledger_entries where business_id=$1", [biz])).toHaveLength(1);
  });

  it("covers a shortfall left by a failed charge on a funded item", async () => {
    const i = await addItem(db, biz, { price: dollars(100) });
    const r = await pledge({ item: i, amount: dollars(100) });
    await q("update public.pledges set status='failed' where id=$1", [r.pledge_id]);
    const res = (await q("select public.close_it_out($1,$2) as r", [i, owner]))[0].r;
    expect(res.owner_capital_cents).toBe(dollars(100));
    expect(res.charges).toEqual([]);
  });

  it("refuses expired items", async () => {
    const i = await addItem(db, biz, { status: "expired" });
    await expect(q("select public.close_it_out($1,$2)", [i, owner])).rejects.toThrow(/cannot be closed out/);
  });
});

describe("manage link: cancel", () => {
  it("cancels a pending pledge; the item stays open", async () => {
    const i = await addItem(db, biz, { price: dollars(100) });
    const h = hash();
    const r = await pledge({ item: i, amount: dollars(40), hash: h, pm: "pm_x" });
    const out = (await q("select public.cancel_pledge($1) as r", [h]))[0].r;
    expect(out).toEqual({ outcome: "cancelled", pledges: [{ pledge_id: r.pledge_id, stripe_payment_method_id: "pm_x", can_detach: true }] });
    expect((await q("select status from public.pledges where id=$1", [r.pledge_id]))[0].status).toBe("cancelled");
    expect((await item(i)).status).toBe("open");
  });

  it("a cancelled pledge no longer counts toward the goal", async () => {
    const i = await addItem(db, biz, { price: dollars(100) });
    const h = hash();
    await pledge({ item: i, amount: dollars(60), hash: h });
    await q("select public.cancel_pledge($1)", [h]);
    const res = await pledge({ item: i, amount: dollars(60) });
    expect(res.outcome).toBe("pending"); // $60 of $100, not $120
  });

  it("a token cannot act on any other pledge", async () => {
    const i = await addItem(db, biz, { price: dollars(100) });
    const h1 = hash();
    const mine = await pledge({ item: i, amount: dollars(10), hash: h1 });
    const theirs = await pledge({ item: i, amount: dollars(10) });
    await q("select public.cancel_pledge($1)", [h1]);
    expect((await q("select status from public.pledges where id=$1", [theirs.pledge_id]))[0].status).toBe("pending");
    expect((await q("select status from public.pledges where id=$1", [mine.pledge_id]))[0].status).toBe("cancelled");
    expect((await q("select public.cancel_pledge($1) as r", [hash()]))[0].r.outcome).toBe("not_allowed");
  });

  it("changes nothing once a pledge is charged, cancelled or expired", async () => {
    const i = await addItem(db, biz, { price: dollars(100) });
    for (const st of ["charging", "charged", "cancelled", "expired", "failed", "requires_action"]) {
      const h = hash();
      const r = await pledge({ item: i, amount: dollars(1), hash: h });
      await q("update public.pledges set status=$2::public.pledge_status, charge_cents=case when $3::text in ('charging','charged') then amount_cents end, charged_at=case when $3::text='charged' then now() end where id=$1", [r.pledge_id, st, st]);
      expect((await q("select public.cancel_pledge($1) as r", [h]))[0].r.outcome, st).toBe("not_allowed");
      expect((await q("select status from public.pledges where id=$1", [r.pledge_id]))[0].status).toBe(st);
    }
  });

  it("there is no move-to-pool function any more", async () => {
    const fns = (await q("select proname from pg_proc where proname in ('move_pledge_to_pool','allocate_pool','split_to_pool')"));
    expect(fns).toEqual([]);
  });
});

describe("permissions", () => {
  it("funding functions are callable by service_role only", async () => {
    const i = await addItem(db, biz, { price: dollars(100) });
    const call = (role: "anon" | "authenticated" | "service_role") =>
      db.as(role, owner, (c) => c.query(`select public.expire_due(now(), $1)`, [biz]));
    await expect(call("anon")).rejects.toThrow(/permission denied/);
    await expect(call("authenticated")).rejects.toThrow(/permission denied/);
    await expect(call("service_role")).resolves.toBeDefined();
    await expect(db.as("authenticated", owner, (c) => c.query(`select public.close_it_out($1,$2)`, [i, owner]))).rejects.toThrow(/permission denied/);
    await expect(db.as("authenticated", owner, (c) => c.query(`select private.fund_item($1)`, [i]))).rejects.toThrow(/permission denied/);
  });
});
