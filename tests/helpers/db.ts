// Test harness: a real Postgres (not a mock) with a minimal stand-in for Supabase's
// auth schema and roles, then our migrations applied for real.
import { Client, Pool } from "pg";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE_URL = process.env.TEST_DATABASE_URL;

export function requireDb(): string {
  if (!BASE_URL) {
    throw new Error(
      "TEST_DATABASE_URL is not set. DB tests need a throwaway Postgres (see .env.example). " +
        "These tests must run before any live money, so they fail instead of skipping.",
    );
  }
  const host = new URL(BASE_URL).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
    throw new Error(`Refusing to run DB tests against non-local host "${host}": they create and drop databases.`);
  }
  return BASE_URL;
}

const SHIM = `
do $$ begin
  begin create role anon nologin; exception when duplicate_object or unique_violation then null; end;
  begin create role authenticated nologin; exception when duplicate_object or unique_violation then null; end;
  begin create role service_role nologin bypassrls; exception when duplicate_object or unique_violation then null; end;
end $$;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.uid() returns uuid language sql stable as
  $f$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $f$;
grant usage on schema public, auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
-- Supabase grants everything on new public tables to these roles by default. Mirror that.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
`;

export interface TestDb {
  name: string;
  url: string;
  pool: Pool;
  /** Run fn on one connection as the given role. Always rolled back unless commit is true. */
  as<T>(role: "anon" | "authenticated" | "service_role", userId: string | null, fn: (c: Client) => Promise<T>, opts?: { commit?: boolean }): Promise<T>;
  drop(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const base = requireDb();
  const name = `bybrick_t_${crypto.randomBytes(6).toString("hex")}`;
  const admin = new Client({ connectionString: base });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = base.replace(/\/[^/]*$/, `/${name}`);
  const setup = new Client({ connectionString: url });
  await setup.connect();
  await setup.query(SHIM);
  const dir = path.resolve(__dirname, "../../supabase/migrations");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    await setup.query(fs.readFileSync(path.join(dir, f), "utf8"));
  }
  await setup.end();

  const pool = new Pool({ connectionString: url, max: 12 });
  return {
    name,
    url,
    pool,
    async as(role, userId, fn, opts) {
      const c = await pool.connect() as unknown as Client & { release(): void };
      try {
        await c.query("begin");
        await c.query(`set local role ${role}`);
        if (userId) await c.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
        const out = await fn(c);
        await c.query(opts?.commit ? "commit" : "rollback");
        return out;
      } catch (e) {
        await c.query("rollback").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    async drop() {
      await pool.end();
      const a = new Client({ connectionString: base });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

/** Insert two businesses with two owners. Returns ids. Runs as superuser (setup only). */
export async function seedTwoBusinesses(db: TestDb) {
  const ownerA = crypto.randomUUID();
  const ownerB = crypto.randomUUID();
  await db.pool.query("insert into auth.users (id, email) values ($1,'a@x.test'), ($2,'b@x.test')", [ownerA, ownerB]);
  const biz = async (slug: string, owner: string) =>
    (await db.pool.query(
      `insert into public.businesses (slug, name, legal_name, owner_display, city, contact_email, owner_user_id, stripe_account_id)
       values ($1, $1, $1 || ' LLC', 'Owner', 'Chicago', 'hello@x.test', $2, 'acct_' || $3) returning id`,
      [slug, owner, slug.replace(/-/g, "")],
    )).rows[0].id as string;
  const bizA = await biz("alpha", ownerA);
  const bizB = await biz("bravo", ownerB);
  return { ownerA, ownerB, bizA, bizB };
}

export async function addItem(db: TestDb, businessId: string, o: Partial<{ name: string; price: number; shipping: number; tax: number; install: number; status: string; deadlineDays: number }> = {}) {
  const r = await db.pool.query(
    `insert into public.items (business_id, name, price_cents, shipping_cents, tax_cents, install_cents, status, deadline)
     values ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' days')::interval) returning id`,
    [businessId, o.name ?? "Walk-in cooler", o.price ?? 100000, o.shipping ?? 0, o.tax ?? 0, o.install ?? 0, o.status ?? "open", String(o.deadlineDays ?? 30)],
  );
  return r.rows[0].id as string;
}

export async function addPledge(db: TestDb, p: { businessId: string; itemId: string | null; amount: number; status?: string; email?: string; sendExtra?: boolean; createdAt?: string }) {
  const r = await db.pool.query(
    `insert into public.pledges (business_id, item_id, contributor_name, contributor_email, amount_cents, status,
        send_extra_to_pool, manage_token_hash, consent_text_version, consented_at, created_at)
     values ($1,$2,'Pat Neighbor',$3,$4,$5,$6, decode(md5(random()::text) || md5(random()::text), 'hex'), 'v0-draft', now(), coalesce($7::timestamptz, now()))
     returning id`,
    [p.businessId, p.itemId, p.email ?? "pat@x.test", p.amount, p.status ?? "pending", p.sendExtra ?? false, p.createdAt ?? null],
  );
  return r.rows[0].id as string;
}
