import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addItem, addPledge, createTestDb, seedTwoBusinesses, type TestDb } from "../helpers/db";

let db: TestDb;
let s: Awaited<ReturnType<typeof seedTwoBusinesses>>;
let itemA: string, itemB: string, draftB: string, pledgeB: string;

beforeAll(async () => {
  db = await createTestDb();
  s = await seedTwoBusinesses(db);
  itemA = await addItem(db, s.bizA, { name: "A cooler" });
  itemB = await addItem(db, s.bizB, { name: "B cooler" });
  draftB = await addItem(db, s.bizB, { name: "B draft", status: "draft" });
  pledgeB = await addPledge(db, { businessId: s.bizB, itemId: itemB, amount: 5000, email: "secret-b@x.test" });
  await db.pool.query(
    `insert into public.ledger_entries (business_id, item_id, kind, amount_cents, tax_year, occurred_at, source_event_id)
     values ($1,$2,'contribution_income',5000,2027,now(),'evt_b1')`, [s.bizB, itemB]);
  await db.pool.query(
    `insert into public.owner_actions (business_id, actor_user_id, action) values ($1,$2,'profile_update')`, [s.bizB, s.ownerB]);
});
afterAll(async () => { await db?.drop(); });

const asA = <T,>(fn: Parameters<TestDb["as"]>[2]) => db.as("authenticated", s.ownerA, fn) as Promise<T>;

describe("deny by default", () => {
  it("has row-level security on every table in public", async () => {
    const r = await db.pool.query(
      `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(r.rows).toEqual([]);
  });

  it("anon cannot read any base table", async () => {
    for (const t of ["businesses", "items", "pledges", "ledger_entries", "assets", "owner_actions", "processed_events"]) {
      await expect(db.as("anon", null, (c) => c.query(`select * from public.${t}`)), t).rejects.toThrow(/permission denied/);
    }
  });

  it("anon cannot write anything", async () => {
    await expect(db.as("anon", null, (c) => c.query(`update public.businesses set name = 'x'`))).rejects.toThrow(/permission denied/);
    await expect(db.as("anon", null, (c) => c.query(`delete from public.items`))).rejects.toThrow(/permission denied/);
  });

  it("processed_events is closed to browser roles", async () => {
    await expect(asA((c) => c.query(`select * from public.processed_events`))).rejects.toThrow(/permission denied/);
    await expect(asA((c) => c.query(`insert into public.processed_events (event_id) values ('evt_x')`))).rejects.toThrow(/permission denied/);
  });
});

describe("public views", () => {
  it("anon can read them and they leak no private columns", async () => {
    const biz = await db.as("anon", null, (c) => c.query(`select * from public.public_businesses`));
    expect(biz.rows).toHaveLength(2);
    const cols = (await db.pool.query(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name in ('public_businesses','public_items','public_pools')`)).rows.map((r) => r.column_name);
    for (const banned of ["stripe_account_id", "owner_user_id", "contributor_email", "contributor_name", "manage_token_hash", "stripe_customer_id", "stripe_payment_method_id"]) {
      expect(cols).not.toContain(banned);
    }
  });

  it("hides draft items and reports raised from pledges", async () => {
    const r = await db.as("anon", null, (c) => c.query(`select id, raised_cents from public.public_items`));
    const ids = r.rows.map((x) => x.id);
    expect(ids).toContain(itemB);
    expect(ids).not.toContain(draftB);
    expect(r.rows.find((x) => x.id === itemB).raised_cents).toBe(5000);
  });
});

describe("owner A cannot read owner B's data", () => {
  it("sees only their own business, items and nothing else's", async () => {
    const b = await asA<any>((c) => c.query(`select id from public.businesses`));
    expect(b.rows.map((r: any) => r.id)).toEqual([s.bizA]);
    const i = await asA<any>((c) => c.query(`select id from public.items`));
    expect(i.rows.map((r: any) => r.id)).toEqual([itemA]);
  });

  it("cannot read B's pledges (names and emails), ledger or audit log", async () => {
    for (const t of ["pledges", "ledger_entries", "assets", "owner_actions"]) {
      const r = await asA<any>((c) => c.query(`select * from public.${t}`));
      expect(r.rows, t).toEqual([]);
    }
    const direct = await asA<any>((c) => c.query(`select * from public.pledges where id = $1`, [pledgeB]));
    expect(direct.rows).toEqual([]);
  });

  it("owner B can read their own pledge (positive control)", async () => {
    const r = await db.as("authenticated", s.ownerB, (c) => c.query(`select contributor_email from public.pledges`));
    expect(r.rows).toEqual([{ contributor_email: "secret-b@x.test" }]);
  });
});

describe("owner A cannot change owner B's data", () => {
  it("cannot update B's business", async () => {
    const r = await asA<any>((c) => c.query(`update public.businesses set name = 'hacked' where id = $1`, [s.bizB]));
    expect(r.rowCount).toBe(0);
    const check = await db.pool.query(`select name from public.businesses where id = $1`, [s.bizB]);
    expect(check.rows[0].name).toBe("bravo");
  });

  it("cannot insert an item into B's business", async () => {
    await expect(asA((c) => c.query(
      `insert into public.items (business_id, name, price_cents) values ($1,'sneaky',100)`, [s.bizB]))).rejects.toThrow(/row-level security/);
  });

  it("cannot update or delete B's items", async () => {
    const u = await asA<any>((c) => c.query(`update public.items set name = 'hacked' where id = $1`, [itemB]));
    expect(u.rowCount).toBe(0);
    const d = await asA<any>((c) => c.query(`delete from public.items where id = $1`, [draftB]));
    expect(d.rowCount).toBe(0);
  });

  it("cannot move their own item into B's business", async () => {
    await expect(asA((c) => c.query(`update public.items set business_id = $1 where id = $2`, [s.bizB, itemA]))).rejects.toThrow(/permission denied/);
  });

  it("cannot write pledges, ledger, assets or audit log at all", async () => {
    await expect(asA((c) => c.query(`update public.pledges set status = 'charged'`))).rejects.toThrow(/permission denied/);
    await expect(asA((c) => c.query(`delete from public.pledges`))).rejects.toThrow(/permission denied/);
    await expect(asA((c) => c.query(
      `insert into public.ledger_entries (business_id, kind, amount_cents, tax_year, occurred_at, source_event_id)
       values ($1,'owner_capital',100,2027,now(),'evt_forged')`, [s.bizA]))).rejects.toThrow(/permission denied/);
    await expect(asA((c) => c.query(`insert into public.assets (business_id, item_id, name, cost_basis_cents, contribution_cents, owner_capital_cents)
       values ($1,$2,'x',1,1,0)`, [s.bizA, itemA]))).rejects.toThrow(/permission denied/);
    await expect(asA((c) => c.query(`insert into public.owner_actions (business_id, actor_user_id, action) values ($1,$2,'x')`, [s.bizA, s.ownerA]))).rejects.toThrow(/permission denied/);
  });
});

describe("owners cannot touch server-controlled fields on their own rows", () => {
  it("cannot change stripe_account_id, owner_user_id or slug", async () => {
    for (const col of ["stripe_account_id = 'acct_evil'", `owner_user_id = '${s.ownerB}'`, "slug = 'taken'"]) {
      await expect(asA((c) => c.query(`update public.businesses set ${col} where id = $1`, [s.bizA])), col).rejects.toThrow(/permission denied/);
    }
  });

  it("cannot create or delete a business", async () => {
    await expect(asA((c) => c.query(`insert into public.businesses (slug,name,legal_name,owner_display,city,contact_email) values ('zz','z','z','z','z','a@b.co')`))).rejects.toThrow(/permission denied/);
    await expect(asA((c) => c.query(`delete from public.businesses where id = $1`, [s.bizA]))).rejects.toThrow(/permission denied/);
  });

  it("cannot set item status, goal_cents or goal_locked_at", async () => {
    for (const col of ["status = 'funded'", "goal_cents = 1", "goal_locked_at = null"]) {
      await expect(asA((c) => c.query(`update public.items set ${col} where id = $1`, [itemA])), col).rejects.toThrow(/permission denied/);
    }
    await expect(asA((c) => c.query(
      `insert into public.items (business_id, name, price_cents, status) values ($1,'x',100,'open')`, [s.bizA]))).rejects.toThrow(/permission denied/);
  });

  it("can edit their own display fields and items (positive control)", async () => {
    const r = await asA<any>((c) => c.query(`update public.businesses set tagline = 'Hi', accent_color = '#aa3300' where id = $1`, [s.bizA]));
    expect(r.rowCount).toBe(1);
    const i = await asA<any>((c) => c.query(
      `insert into public.items (business_id, name, price_cents, shipping_cents, tax_cents, install_cents) values ($1,'Shelf',10000,500,800,1000) returning goal_cents, status`, [s.bizA]));
    expect(i.rows[0]).toEqual({ goal_cents: 12300, status: "draft" });
  });

  it("rejects a bad accent color", async () => {
    await expect(asA((c) => c.query(`update public.businesses set accent_color = 'red; background:url(x)' where id = $1`, [s.bizA]))).rejects.toThrow(/check/);
  });

  it("can delete only draft items", async () => {
    const open = await asA<any>((c) => c.query(`delete from public.items where id = $1`, [itemA]));
    expect(open.rowCount).toBe(0);
  });
});
