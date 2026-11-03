import type { Rpc } from "../payments/rpc";

// DEVELOPMENT-ONLY preview mode: runs the app against a local Postgres with no Supabase and no
// real sign-in email, so screens can be looked at and clicked through. It can never switch on
// in a deployed build: it needs NODE_ENV=development (Vercel always builds for production),
// no VERCEL variable, and DEV_PREVIEW=1 plus a local database URL.

export function devPreviewEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.DEV_PREVIEW === "1" &&
    !process.env.VERCEL &&
    !!process.env.DEV_DATABASE_URL &&
    /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DEV_DATABASE_URL)
  );
}

type PgPool = { query(sql: string, values?: unknown[]): Promise<{ rows: any[] }> };
let pool: PgPool | null = null;

async function devPool(): Promise<PgPool> {
  if (!devPreviewEnabled()) throw new Error("dev preview is not enabled");
  if (pool) return pool;
  const name = "pg"; // loaded by name at run time so production bundles never include it
  const mod: any = await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ name);
  const { Pool } = mod.default ?? mod;
  pool = new Pool({ connectionString: process.env.DEV_DATABASE_URL, max: 5 }) as PgPool;
  return pool;
}

export async function devRpc(): Promise<Rpc> {
  const p = await devPool();
  return async <T>(fn: string, args: Record<string, unknown> = {}) => {
    const keys = Object.keys(args);
    const named = keys.map((k, i) => `${k} => $${i + 1}`).join(", ");
    const r = await p.query(`select public.${fn}(${named}) as r`, keys.map((k) => args[k]));
    return r.rows[0]!.r as T;
  };
}

/** Stand-in for clicking an emailed link: finds or creates the local auth user for an email. */
export async function devSignIn(email: string): Promise<{ id: string; email: string } | null> {
  const p = await devPool();
  const rpc = await devRpc();
  if (!(await rpc<boolean>("owner_signin_allowed", { p_email: email }))) return null;
  const found = await p.query("select id from auth.users where lower(email) = lower($1)", [email]);
  const id: string = found.rows[0]?.id ?? (await p.query("insert into auth.users (email) values ($1) returning id", [email])).rows[0].id;
  await rpc("claim_business", { p_user_id: id, p_email: email });
  return { id, email };
}
