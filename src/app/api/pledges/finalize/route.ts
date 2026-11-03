import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { runtimeDeps } from "@/lib/payments/runtime";
import { finalizeSetupIntent, PledgeError } from "@/lib/payments/pledges";
import { readJson } from "@/lib/http";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ setupIntentId: z.string().regex(/^seti_[A-Za-z0-9]+$/), businessId: z.string().uuid() });

export async function POST(req: NextRequest) {
  try {
    const parsed = bodySchema.safeParse(await readJson(req));
    if (!parsed.success) return NextResponse.json({ error: "invalid" }, { status: 400 });
    const out = await finalizeSetupIntent(runtimeDeps(), parsed.data.setupIntentId, parsed.data.businessId);
    return NextResponse.json(out, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof PledgeError) {
      return NextResponse.json({ error: err.code }, { status: err.code === "not_found" ? 404 : err.code === "not_ready_to_finalize" ? 409 : 400 });
    }
    console.error("pledge finalize failed");
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
