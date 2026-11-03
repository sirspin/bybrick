import { createClient } from "@supabase/supabase-js";
import { supabaseRpc, type Rpc } from "../payments/rpc";

// SERVER ONLY. Uses the service-role key, which bypasses row-level security.
// Never import this from a client component or expose its output without filtering.

let cached: Rpc | null = null;

export function adminRpc(): Rpc {
  if (typeof window !== "undefined") throw new Error("adminRpc must not run in the browser");
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is missing");
  cached = supabaseRpc(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
  return cached;
}
