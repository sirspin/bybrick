import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addItem, addPledge, createTestDb, seedTwoBusinesses, type TestDb } from "../helpers/db";

let db: TestDb;
let s: Awaited<ReturnType<typeof seedTwoBusinesses>>;
let itemA: string, itemB: string, entryId: string;

const insertEntry = (c: { query: (...a: any[]) => Promise<any> }, o: { kind?: string; amount?: number; event: string; biz?: string; item?: string | null; reverses?: string | null }) =>
  c.query(
    `insert into public.ledger_entries (business_id, item_id, kind, amount_cents, tax_year, occurred_at, source_event_id, reverses_entry_id)
     values ($1,$2,$3,$4,2027,now(),$5,$6) returning id`,
    [o.biz ?? s.bizA, o.item === undefined ? itemA : o.item, o.kind ?? "contribution_income", o.amount ?? 1000, o.event, o.reverses ?? null]);

beforeAll(async () => {
  db = await createTestDb();
  s = await seedTwoBusinesses(db);
  itemA = await addItem(db, s.bizA);
  itemB = await addItem(db, s.bizB);
  entryId = (await insertEntry(db.pool, { event: "evt_seed" })).rows[0].id;
});
afterAll(async () => { await db?.drop(); });

describe("ledger is append-only, enforced by the database", () => {
  it("server (service_role) can append", async () => {
    const r = await db.as("service_role", null, (c) => insertEntry(c, { event: "evt_append" }));
    expect(r.rowCount).toBe(1);
  });

  it("rejects UPDATE, even from a superuser (trigger, not just privileges)", async () => {
    await expect(db.pool.query(`update public.ledger_entries set amount_cents = 1 where id = $1`, [entryId])).rejects.toThrow(/append-only/);
  });
  it("rejects DELETE, even from a superuser", async () => {
    await expect(db.pool.query(`delete from public.ledger_entries where id = $1`, [entryId])).rejects.toThrow(/append-only/);
  });
  it("rejects TRUNCATE, even from a superuser", async () => {
    await expect(db.pool.query(`truncate public.ledger_entries`)).rejects.toThrow(/append-only/);
  });

  it("rejects UPDATE and DELETE from service_role", async () => {
    await expect(db.as("service_role", null, (c) => c.query(`update public.ledger_entries set memo = 'x'`))).rejects.toThrow(/permission denied|append-only/);
    await expect(db.as("service_role", null, (c) => c.query(`delete from public.ledger_entries`))).rejects.toThrow(/permission denied|append-only/);
  });

  it("the owner audit log is append-only too", async () => {
    const r = await db.pool.query(`insert into public.owner_actions (business_id, actor_user_id, action) values ($1,$2,'close_it_out') returning id`, [s.bizA, s.ownerA]);
    await expect(db.pool.query(`update public.owner_actions set action = 'x' where id = $1`, [r.rows[0].id])).rejects.toThrow(/append-only/);
    await expect(db.pool.query(`delete from public.owner_actions where id = $1`, [r.rows[0].id])).rejects.toThrow(/append-only/);
  });
});

describe("ledger integrity", () => {
  it("rejects a replayed source_event_id", async () => {
    await expect(insertEntry(db.pool, { event: "evt_seed" })).rejects.toThrow(/unique/);
  });

  it("enforces signs: income positive, fees and refunds negative", async () => {
    await expect(insertEntry(db.pool, { event: "e1", kind: "contribution_income", amount: -5 })).rejects.toThrow(/check/);
    await expect(insertEntry(db.pool, { event: "e2", kind: "owner_capital", amount: -5 })).rejects.toThrow(/check/);
    await expect(insertEntry(db.pool, { event: "e3", kind: "platform_fee", amount: 5 })).rejects.toThrow(/check/);
    await expect(insertEntry(db.pool, { event: "e4", kind: "refund", amount: 5 })).rejects.toThrow(/check/);
    await expect(insertEntry(db.pool, { event: "e5", kind: "processor_fee", amount: 0 })).rejects.toThrow(/check/);
    expect((await insertEntry(db.pool, { event: "e6", kind: "processor_fee", amount: -59 })).rowCount).toBe(1);
  });

  it("a correction is a reversal that negates an earlier entry", async () => {
    const rev = await insertEntry(db.pool, { event: "evt_rev", kind: "reversal", amount: -1000, reverses: entryId });
    expect(rev.rowCount).toBe(1);
    await expect(insertEntry(db.pool, { event: "evt_rev_bad_amt", kind: "reversal", amount: -999, reverses: entryId })).rejects.toThrow(/reversal must negate/);
    await expect(insertEntry(db.pool, { event: "evt_rev_other_biz", kind: "reversal", amount: -1000, reverses: entryId, biz: s.bizB, item: itemB })).rejects.toThrow(/reversal must negate/);
    await expect(insertEntry(db.pool, { event: "evt_rev_none", kind: "reversal", amount: -1000 })).rejects.toThrow(/check/);
    await expect(insertEntry(db.pool, { event: "evt_not_rev", kind: "contribution_income", reverses: entryId })).rejects.toThrow(/check|reversal must negate/);
  });

  it("an entry cannot point at another business's item", async () => {
    await expect(insertEntry(db.pool, { event: "evt_cross", item: itemB })).rejects.toThrow(/foreign key/);
  });

  it("a pledge cannot point at another business's item", async () => {
    await expect(addPledge(db, { businessId: s.bizA, itemId: itemB, amount: 100 })).rejects.toThrow(/foreign key/);
  });
});

describe("webhook idempotency table", () => {
  it("accepts each Stripe event id once", async () => {
    await db.pool.query(`insert into public.processed_events (event_id, event_type) values ('evt_1','payment_intent.succeeded')`);
    await expect(db.pool.query(`insert into public.processed_events (event_id) values ('evt_1')`)).rejects.toThrow(/unique|duplicate/);
  });
});

describe("item goal", () => {
  it("is price + shipping + tax + install, computed by the database", async () => {
    const r = await db.pool.query(`insert into public.items (business_id,name,price_cents,shipping_cents,tax_cents,install_cents,goal_cents) values ($1,'x',1000,100,80,20,1) returning goal_cents`, [s.bizA]);
    expect(r.rows[0].goal_cents).toBe(1200);
  });

  it("cannot change after it locks, but descriptive fields still can", async () => {
    const id = await addItem(db, s.bizA, { price: 5000 });
    await db.pool.query(`update public.items set goal_locked_at = now() where id = $1`, [id]);
    for (const col of ["price_cents = 6000", "shipping_cents = 1", "tax_cents = 1", "install_cents = 1", "goal_locked_at = null"]) {
      await expect(db.pool.query(`update public.items set ${col} where id = $1`, [id]), col).rejects.toThrow(/goal is locked/);
    }
    expect((await db.pool.query(`update public.items set name = 'Renamed' where id = $1`, [id])).rowCount).toBe(1);
  });

  it("an open item must have a deadline", async () => {
    await expect(db.pool.query(`insert into public.items (business_id,name,price_cents,status) values ($1,'x',100,'open')`, [s.bizA])).rejects.toThrow(/check/);
  });
});
