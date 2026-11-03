import { redirect } from "next/navigation";
import { currentOwner, type Owner } from "./session";
import { getRpc } from "../data";
import type { Rpc } from "../payments/rpc";

export interface Dashboard {
  business: {
    id: string; slug: string; name: string; legal_name: string; owner_display: string; owner_line: string | null;
    tagline: string | null; story: string | null; neighborhood: string | null; city: string; status_line: string | null;
    contact_email: string; logo_url: string | null; cover_url: string | null; accent_color: string;
    stripe_connected: boolean; stripe_ready: boolean;
  };
  items: Array<{
    id: string; name: string; short_name: string | null; note: string | null; status: string;
    price_cents: number; shipping_cents: number; tax_cents: number; install_cents: number; goal_cents: number;
    deadline: string | null; goal_locked: boolean; covered_cents: number; remaining_cents: number;
    pledge_count: number; failed_count: number;
    pledges: Array<{ name: string; amount_cents: number; charge_cents: number | null; status: string; created_at: string }>;
  }>;
  ledger: Array<{ item_id: string; item_name: string; status: string; contribution_cents: number; owner_capital_cents: number; fees_cents: number; refunds_cents: number }>;
}

/** For owner pages and actions: the verified owner and their business, or a redirect to sign-in. */
export async function requireOwner(): Promise<{ owner: Owner; rpc: Rpc; dash: Dashboard }> {
  const owner = await currentOwner();
  if (!owner) redirect("/owner/login");
  const rpc = await getRpc();
  const dash = await rpc<Dashboard | null>("owner_dashboard", { p_user_id: owner.id });
  if (!dash) redirect("/owner/login?error=not_registered");
  return { owner, rpc, dash };
}
