import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { devPreviewEnabled } from "../dev/preview";

export interface Owner { id: string; email: string }

export const DEV_COOKIE = "bb_dev_owner";

const PROD = process.env.NODE_ENV === "production";

/** Supabase client bound to the visitor's cookies. Session cookies are HttpOnly, SameSite=Lax, and Secure in production. */
export async function supabaseAuthClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Supabase auth is not configured");
  const store = await cookies();
  return createServerClient(url, anon, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) {
            store.set(name, value, { ...options, httpOnly: true, secure: PROD, sameSite: "lax", path: "/" });
          }
        } catch {
          // Called from a Server Component, which can't set cookies. The proxy refreshes sessions.
        }
      },
    },
  });
}

/** The signed-in owner, or null. Asks Supabase to validate the session every time (never trusts the cookie alone). */
export async function currentOwner(): Promise<Owner | null> {
  if (devPreviewEnabled()) {
    const raw = (await cookies()).get(DEV_COOKIE)?.value;
    if (!raw) return null;
    try {
      const v = JSON.parse(decodeURIComponent(raw));
      return typeof v.id === "string" && typeof v.email === "string" ? { id: v.id, email: v.email } : null;
    } catch { return null; }
  }
  try {
    const supabase = await supabaseAuthClient();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user?.email) return null;
    return { id: data.user.id, email: data.user.email };
  } catch {
    return null;
  }
}
