import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  const sql = fs.readFileSync(path.resolve(import.meta.dirname, "../../supabase/seed.sql"), "utf8");
  await db.pool.query(sql);
});
afterAll(async () => { await db?.drop(); });

describe("seed data", () => {
  it("loads Birdy's with three open sample items and computed goals", async () => {
    const r = await db.as("anon", null, (c) =>
      c.query(`select b.slug, b.accepting_pledges, i.short_name, i.goal_cents, i.status, i.raised_cents
               from public.public_businesses b join public.public_items i on i.business_id = b.id order by i.position`));
    expect(r.rows.map((x) => x.short_name)).toEqual(["Cooler", "Shelving", "Counter"]);
    expect(r.rows.map((x) => x.goal_cents)).toEqual([384000, 110000, 216500]);
    expect(new Set(r.rows.map((x) => x.status))).toEqual(new Set(["open"]));
    expect(r.rows.every((x) => x.raised_cents === 0)).toBe(true);
    // Not connected to Stripe yet, so the page must not take pledges.
    expect(r.rows[0].accepting_pledges).toBe(false);
  });

  it("is safe to run twice", async () => {
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, "../../supabase/seed.sql"), "utf8");
    await db.pool.query(sql);
    const r = await db.pool.query(`select count(*)::int as n from public.items`);
    expect(r.rows[0].n).toBe(3);
  });
});
