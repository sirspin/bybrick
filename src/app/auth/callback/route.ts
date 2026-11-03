import { NextResponse, type NextRequest } from "next/server";
import { supabaseAuthClient } from "@/lib/auth/session";
import { adminRpc } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

// Where the emailed sign-in link lands. Handles both link styles Supabase can send:
// a PKCE `code`, or a `token_hash` (when the email template links straight here).
// The destination is always one of our own fixed paths, never taken from the request.
export async function GET(req: NextRequest) {
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? req.nextUrl.origin).replace(/\/$/, "");
  const fail = () => NextResponse.redirect(`${site}/owner/login?error=link`, 303);

  const code = req.nextUrl.searchParams.get("code");
  const tokenHash = req.nextUrl.searchParams.get("token_hash");
  const type = req.nextUrl.searchParams.get("type");

  try {
    const supabase = await supabaseAuthClient();
    if (tokenHash && (type === "email" || type === "magiclink")) {
      const { error } = await supabase.auth.verifyOtp({ type: "email", token_hash: tokenHash });
      if (error) return fail();
    } else if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) return fail();
    } else {
      return fail();
    }

    const { data } = await supabase.auth.getUser();
    if (!data.user?.email) return fail();

    // Attach this verified email to the business registered for it. No match: no access.
    const claimed = await adminRpc()<string | null>("claim_business", { p_user_id: data.user.id, p_email: data.user.email });
    if (!claimed) {
      await supabase.auth.signOut();
      return NextResponse.redirect(`${site}/owner/login?error=not_registered`, 303);
    }
    return NextResponse.redirect(`${site}/owner`, 303);
  } catch {
    return fail();
  }
}
