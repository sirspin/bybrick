import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addItem, createTestDb, seedTwoBusinesses, type TestDb } from "../helpers/db";

let db: TestDb;
let s: Awaited<ReturnType<typeof seedTwoBusinesses>>;
beforeAll(async () => {
  db = await createTestDb();
  s = await seedTwoBusinesses(db); // alpha (ownerA) and bravo (ownerB), both with stripe_account_id
  await db.pool.query("update public.businesses set owner_email='a@x.test', stripe_onboarded_at=now() where id=$1", [s.bizA]);
  await db.pool.query("update public.businesses set owner_email='b@x.test' where id=$1", [s.bizB]);
});
afterAll(async () => { await db?.drop(); });

const q = async (sql: string, v: unknown[] = []) => (await db.pool.query(sql, v)).rows;
const rpc = async (sql: string, v: unknown[] = []) => (await q(sql, v))[0].r;
const future = () => new Date(Date.now() + 30 * 86400_000).toISOString();
const saveItem = (user: string, id: string | null, o: Partial<{ name: string; price: number; deadline: string | null }> = {}) =>
  rpc(`select public.owner_save_item($1,$2,$3,'Short','A note',$4,500,800,0,$5) as r`, [user, id, o.name ?? "Cooler", o.price ?? 10000, o.deadline === undefined ? future() : o.deadline]);

describe("owner sign-in", () => {
  it("allows only registered owner emails, ignoring case", async () => {
    expect(await rpc("select public.owner_signin_allowed('A@X.test') as r")).toBe(true);
    expect(await rpc("select public.owner_signin_allowed('stranger@x.test') as r")).toBe(false);
    expect(await rpc("select public.owner_signin_allowed('') as r")).toBe(false);
  });

  it("claims an unclaimed business for the verified email, and writes an audit row", async () => {
    const fresh = (await q(`insert into public.businesses (slug,name,legal_name,owner_display,city,contact_email,owner_email) values ('c' || substr(md5(random()::text),1,8),'Fresh','Fresh','o','c','pub@x.test','New.Owner@x.test') returning id`))[0].id;
    const user = crypto.randomUUID();
    await q("insert into auth.users (id) values ($1)", [user]);
    expect(await rpc("select public.claim_business($1,'new.owner@x.test') as r", [user])).toBe(fresh);
    expect((await q("select owner_user_id from public.businesses where id=$1", [fresh]))[0].owner_user_id).toBe(user);
    expect(await q("select action from public.owner_actions where business_id=$1", [fresh])).toEqual([{ action: "sign_in" }]);
  });

  it("will not hand a business that already has an owner to someone else", async () => {
    const intruder = crypto.randomUUID();
    await q("insert into auth.users (id) values ($1)", [intruder]);
    expect(await rpc("select public.claim_business($1,'a@x.test') as r", [intruder])).toBeNull();
    expect((await q("select owner_user_id from public.businesses where id=$1", [s.bizA]))[0].owner_user_id).toBe(s.ownerA);
    expect(await rpc("select public.claim_business($1,'nobody@x.test') as r", [intruder])).toBeNull();
  });

  it("the same owner signing in again is fine", async () => {
    expect(await rpc("select public.claim_business($1,'a@x.test') as r", [s.ownerA])).toBe(s.bizA);
  });

  it("owner_email is not writable by owners", async () => {
    await expect(db.as("authenticated", s.ownerA, (c) => c.query("update public.businesses set owner_email='me@x.test'"))).rejects.toThrow(/permission denied/);
  });
});

describe("owner dashboard", () => {
  it("returns only the signed-in owner's business and items", async () => {
    const itemA = await saveItem(s.ownerA, null, { name: "A-item" });
    const itemB = await saveItem(s.ownerB, null, { name: "B-item" });
    const d = await rpc("select public.owner_dashboard($1) as r", [s.ownerA]);
    expect(d.business.id).toBe(s.bizA);
    expect(d.business.stripe_ready).toBe(true);
    const ids = d.items.map((i: any) => i.id);
    expect(ids).toContain(itemA);
    expect(ids).not.toContain(itemB);
    expect(JSON.stringify(d)).not.toContain("acct_bravo");
    expect(JSON.stringify(d.business)).not.toContain("stripe_account_id");
  });

  it("returns null for someone who owns nothing", async () => {
    expect(await rpc("select public.owner_dashboard($1) as r", [crypto.randomUUID()])).toBeNull();
  });

  it("shows pledges to the owner of that item only", async () => {
    const item = await saveItem(s.ownerA, null, { name: "With pledge" });
    await rpc("select public.owner_publish_item($1,$2) as r", [s.ownerA, item]);
    await q(`select public.create_pledge($1,$2,'Pat Neighbor','pat@x.test',2500,$3,'v',now(),'c','pm',null)`, [s.bizA, item, crypto.randomBytes(32)]);
    const a = await rpc("select public.owner_dashboard($1) as r", [s.ownerA]);
    const mine = a.items.find((i: any) => i.id === item);
    expect(mine.pledges).toMatchObject([{ name: "Pat Neighbor", amount_cents: 2500, status: "pending" }]);
    expect(mine).toMatchObject({ covered_cents: 2500, remaining_cents: 10000 + 500 + 800 - 2500, goal_locked: true });
    const b = await rpc("select public.owner_dashboard($1) as r", [s.ownerB]);
    expect(JSON.stringify(b)).not.toContain("Pat Neighbor");
  });
});

describe("owner edits", () => {
  it("updates only the allowed about-card fields and logs which ones", async () => {
    await q("select public.owner_update_business($1, $2::jsonb)", [s.ownerA, JSON.stringify({ tagline: "Hello", accent_color: "#aa3300", stripe_account_id: "acct_evil", owner_user_id: s.ownerB, slug: "stolen", owner_email: "x@x.test" })]);
    const b = (await q("select tagline, accent_color, stripe_account_id, owner_user_id, slug, owner_email from public.businesses where id=$1", [s.bizA]))[0];
    expect(b).toMatchObject({ tagline: "Hello", accent_color: "#aa3300", owner_user_id: s.ownerA, slug: "alpha", owner_email: "a@x.test" });
    expect(b.stripe_account_id).toMatch(/^acct_alpha/);
    const a = (await q("select details from public.owner_actions where business_id=$1 and action='profile_update'", [s.bizA]))[0];
    expect(a.details.fields).toContain("tagline");
    expect(JSON.stringify(a.details)).not.toContain("Hello"); // keys only, not values
  });

  it("clears an optional field when it is sent empty, and rejects a bad colour", async () => {
    await q("select public.owner_update_business($1, $2::jsonb)", [s.ownerA, JSON.stringify({ tagline: "" })]);
    expect((await q("select tagline from public.businesses where id=$1", [s.bizA]))[0].tagline).toBeNull();
    await expect(q("select public.owner_update_business($1, $2::jsonb)", [s.ownerA, JSON.stringify({ accent_color: "red" })])).rejects.toThrow(/check/);
  });

  it("someone who owns nothing cannot edit anything", async () => {
    await expect(q("select public.owner_update_business($1, '{\"name\":\"x\"}')", [crypto.randomUUID()])).rejects.toThrow(/not an owner/);
  });

  it("creates drafts, edits them, and cannot touch another business's item", async () => {
    const id = await saveItem(s.ownerA, null, { name: "Shelf", price: 5000 });
    expect((await q("select status, goal_cents from public.items where id=$1", [id]))[0]).toEqual({ status: "draft", goal_cents: 5000 + 500 + 800 });
    await saveItem(s.ownerA, id, { name: "Shelf v2", price: 6000 });
    expect((await q("select name, goal_cents from public.items where id=$1", [id]))[0]).toEqual({ name: "Shelf v2", goal_cents: 7300 });
    await expect(saveItem(s.ownerB, id, { name: "hijack" })).rejects.toThrow(/item not found/);
    expect((await q("select name from public.items where id=$1", [id]))[0].name).toBe("Shelf v2");
  });

  it("the goal cannot change once a pledge locks it", async () => {
    const id = await saveItem(s.ownerA, null, { price: 5000 });
    await rpc("select public.owner_publish_item($1,$2) as r", [s.ownerA, id]);
    await q(`select public.create_pledge($1,$2,'P','p@x.test',1000,$3,'v',now(),'c','pm',null)`, [s.bizA, id, crypto.randomBytes(32)]);
    await expect(saveItem(s.ownerA, id, { price: 9999 })).rejects.toThrow(/goal is locked/);
  });
});

describe("opening an item", () => {
  it("needs a finished Stripe connection and a future deadline", async () => {
    const noDeadline = await saveItem(s.ownerA, null, { deadline: null });
    await expect(rpc("select public.owner_publish_item($1,$2) as r", [s.ownerA, noDeadline])).rejects.toThrow(/deadline/);
    const bravoItem = await saveItem(s.ownerB, null);
    await expect(rpc("select public.owner_publish_item($1,$2) as r", [s.ownerB, bravoItem])).rejects.toThrow(/connecting Stripe/);
  });

  it("opens a draft once, and not another owner's", async () => {
    const id = await saveItem(s.ownerA, null);
    await expect(rpc("select public.owner_publish_item($1,$2) as r", [s.ownerB, id])).rejects.toThrow(/item not found/);
    await rpc("select public.owner_publish_item($1,$2) as r", [s.ownerA, id]);
    expect((await q("select status from public.items where id=$1", [id]))[0].status).toBe("open");
    await expect(rpc("select public.owner_publish_item($1,$2) as r", [s.ownerA, id])).rejects.toThrow(/only drafts/);
    expect(await q("select 1 from public.owner_actions where target_id=$1 and action='item_open'", [id])).toHaveLength(1);
  });
});

describe("public pages", () => {
  it("show non-draft items with progress and no private fields", async () => {
    const draft = await saveItem(s.ownerA, null, { name: "Secret draft" });
    const open = await saveItem(s.ownerA, null, { name: "Public open" });
    await rpc("select public.owner_publish_item($1,$2) as r", [s.ownerA, open]);
    await q(`select public.create_pledge($1,$2,'Pat','pat@x.test',1000,$3,'v',now(),'c','pm',null)`, [s.bizA, open, crypto.randomBytes(32)]);
    const page = await rpc("select public.public_business_page('alpha') as r");
    const names = page.items.map((i: any) => i.name);
    expect(names).toContain("Public open");
    expect(names).not.toContain("Secret draft");
    expect(page.items.find((i: any) => i.name === "Public open").raised_cents).toBe(1000);
    expect(page.summary.pledges).toBeGreaterThanOrEqual(1);
    const text = JSON.stringify(page);
    for (const banned of ["stripe_account_id", "owner_user_id", "owner_email", "pat@x.test", "manage_token", "acct_"]) expect(text).not.toContain(banned);
    expect(draft).toBeTruthy();
  });

  it("unknown business or an item from another business is null", async () => {
    expect(await rpc("select public.public_business_page('nope') as r")).toBeNull();
    const bravoOpen = await addItem(db, s.bizB, { name: "Bravo open" });
    expect(await rpc("select public.public_item_page('alpha', $1) as r", [bravoOpen])).toBeNull();
    expect((await rpc("select public.public_item_page('bravo', $1) as r", [bravoOpen])).item.name).toBe("Bravo open");
  });

  it("an item page reports what is remaining", async () => {
    const id = await addItem(db, s.bizA, { price: 10000, name: "Remaining test" });
    await q(`select public.create_pledge($1,$2,'P','p@x.test',3000,$3,'v',now(),'c','pm',null)`, [s.bizA, id, crypto.randomBytes(32)]);
    expect((await rpc("select public.public_item_page('alpha', $1) as r", [id])).item).toMatchObject({ raised_cents: 3000, remaining_cents: 7000 });
  });
});

describe("manage view", () => {
  it("shows only that pledge, for any status, and nothing for an unknown token", async () => {
    const id = await addItem(db, s.bizA, { price: 10000, name: "Manage test" });
    const hash = crypto.randomBytes(32);
    await q(`select public.create_pledge($1,$2,'Pat','pat@x.test',3000,$3,'v',now(),'c','pm',null)`, [s.bizA, id, hash]);
    const v = await rpc("select public.manage_view($1) as r", [hash]);
    expect(v).toMatchObject({ status: "pending", amount_cents: 3000, item_name: "Manage test", business_slug: "alpha" });
    expect(JSON.stringify(v)).not.toMatch(/pat@x\.test|acct_|pm_/);
    await q("select public.cancel_pledge($1)", [hash]);
    expect((await rpc("select public.manage_view($1) as r", [hash])).status).toBe("cancelled");
    expect(await rpc("select public.manage_view($1) as r", [crypto.randomBytes(32)])).toBeNull();
  });
});

describe("permissions", () => {
  it("none of the screen functions are callable by browser roles", async () => {
    for (const call of [
      "select public.owner_signin_allowed('a@x.test')",
      `select public.owner_dashboard('${s.ownerA}')`,
      "select public.public_business_page('alpha')",
      `select public.claim_business('${s.ownerA}','a@x.test')`,
    ]) {
      await expect(db.as("anon", null, (c) => c.query(call)), call).rejects.toThrow(/permission denied/);
      await expect(db.as("authenticated", s.ownerA, (c) => c.query(call)), call).rejects.toThrow(/permission denied/);
    }
  });
});
