"use client";

import { useActionState } from "react";
import { requestSignIn, type SignInState } from "./actions";

export function LoginForm({ preview }: { preview: boolean }) {
  const [state, action, pending] = useActionState<SignInState, FormData>(requestSignIn, { status: "idle" });

  if (state.status === "sent") {
    return (
      <div role="status" className="notice">
        <p><strong>Check your email.</strong></p>
        <p>If that address is registered, a sign-in link is on its way. It works once and expires quickly.</p>
      </div>
    );
  }
  return (
    <form action={action} className="stack">
      <label htmlFor="email">Email</label>
      <input id="email" name="email" type="email" autoComplete="email" inputMode="email" required />
      {state.status === "error" && <p role="alert" className="error">{state.message}</p>}
      <button type="submit" className="btn" disabled={pending}>
        {pending ? "Sending…" : preview ? "Sign in (preview)" : "Email me a sign-in link"}
      </button>
      {preview && <p className="muted">Preview mode: no email is sent. Use the owner email registered for the business.</p>}
    </form>
  );
}
