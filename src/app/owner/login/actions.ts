"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { DEV_COOKIE, supabaseAuthClient } from "@/lib/auth/session";
import { devPreviewEnabled, devSignIn } from "@/lib/dev/preview";
import { getRpc } from "@/lib/data";
import { requestIp, withinLimit } from "@/lib/limits";

export interface SignInState { status: "idle" | "sent" | "error"; message?: string }

const emailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * Sends a sign-in link, but only to emails registered as an owner. The answer is the same
 * whether or not the email is registered, so this can't be used to find out who owns a business.
 */
export async function requestSignIn(_prev: SignInState, form: FormData): Promise<SignInState> {
  const parsed = emailSchema.safeParse(form.get("email"));
  if (!parsed.success) return { status: "error", message: "Enter a valid email address." };
  const email = parsed.data;
  const rpc = await getRpc();

  const ip = await requestIp();
  if (!(await withinLimit(rpc, "signin-ip", ip, 10, "1 hour")) || !(await withinLimit(rpc, "signin-email", email, 5, "1 hour"))) {
    return { status: "error", message: "Too many attempts. Try again in a little while." };
  }

  if (devPreviewEnabled()) {
    const user = await devSignIn(email);
    if (!user) return { status: "error", message: "That email isn't registered as an owner (preview mode)." };
    (await cookies()).set(DEV_COOKIE, encodeURIComponent(JSON.stringify(user)), { httpOnly: true, sameSite: "lax", path: "/" });
    redirect("/owner");
  }

  if (await rpc<boolean>("owner_signin_allowed", { p_email: email })) {
    const site = process.env.NEXT_PUBLIC_SITE_URL;
    if (!site) throw new Error("NEXT_PUBLIC_SITE_URL is not set");
    const supabase = await supabaseAuthClient();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${site.replace(/\/$/, "")}/auth/callback`, shouldCreateUser: true },
    });
    if (error) console.error("sign-in link failed"); // no email address in logs
  }
  return { status: "sent" };
}

export async function signOut() {
  if (devPreviewEnabled()) {
    (await cookies()).delete(DEV_COOKIE);
  } else {
    try { await (await supabaseAuthClient()).auth.signOut(); } catch { /* already signed out */ }
  }
  redirect("/owner/login");
}
