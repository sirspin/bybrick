import { NextResponse, type NextRequest } from "next/server";
import { runtimeDeps } from "@/lib/payments/runtime";
import { createPledgeIntent, PledgeError } from "@/lib/payments/pledges";
import { clientIp, readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const STATUS: Record<PledgeError["code"], number> = {
  invalid: 400, rate_limited: 429, bot_check_failed: 403, not_found: 404, business_not_ready: 409,
  item_closed: 409, amount_too_high: 422, amount_too_low: 422, not_ready_to_finalize: 409, mismatch: 400,
};

export async function POST(req: NextRequest) {
  try {
    const body = await readJson(req);
    const out = await createPledgeIntent(runtimeDeps(), body, clientIp(req));
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof PledgeError) return NextResponse.json({ error: err.code }, { status: STATUS[err.code] });
    console.error("pledge intent failed"); // no details: they can include names and emails
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
