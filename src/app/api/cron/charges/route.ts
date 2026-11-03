import { NextResponse, type NextRequest } from "next/server";
import { runtimeDeps } from "@/lib/payments/runtime";
import { sweepCharges } from "@/lib/payments/cron";
import { isCronAuthorized } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await sweepCharges(runtimeDeps()));
  } catch {
    console.error("charge sweep failed");
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
