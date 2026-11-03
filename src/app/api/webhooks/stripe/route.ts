import { NextResponse, type NextRequest } from "next/server";
import { runtimeDeps } from "@/lib/payments/runtime";
import { handleStripeEvent, verifyWebhook, WebhookRejected } from "@/lib/payments/webhooks";

export const dynamic = "force-dynamic";

// Stripe webhook endpoint for events on connected accounts (direct charges, setup intents).
// The signature is checked on the raw body before anything is parsed or trusted.
export async function POST(req: NextRequest) {
  const raw = await req.text();
  if (raw.length > 1_000_000) return NextResponse.json({ error: "too_large" }, { status: 413 });

  let deps;
  try { deps = runtimeDeps(); } catch { return NextResponse.json({ error: "not_configured" }, { status: 503 }); }

  let event;
  try {
    event = verifyWebhook(deps.stripe, raw, req.headers.get("stripe-signature"), deps.cfg.webhookSecret);
  } catch (err) {
    if (err instanceof WebhookRejected) return NextResponse.json({ error: "rejected" }, { status: 400 });
    throw err;
  }

  try {
    const result = await handleStripeEvent(deps, event);
    return NextResponse.json({ received: true, result });
  } catch {
    // 500 makes Stripe retry. The event was not marked processed, so a retry is safe.
    console.error(`webhook handler failed for ${event.type}`);
    return NextResponse.json({ error: "handler_failed" }, { status: 500 });
  }
}
