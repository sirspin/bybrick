import type { Rpc } from "./payments/rpc";
import { adminRpc } from "./supabase/admin";
import { devPreviewEnabled, devRpc } from "./dev/preview";

/** The one way server code reaches the database: Supabase in real deployments. */
export async function getRpc(): Promise<Rpc> {
  if (devPreviewEnabled()) return devRpc();
  return adminRpc();
}
