import { redirect } from "next/navigation";
import { currentOwner } from "@/lib/auth/session";
import { devPreviewEnabled } from "@/lib/dev/preview";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Owner sign-in · bybrick", robots: { index: false } };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentOwner()) redirect("/owner");
  const { error } = await searchParams;
  return (
    <main className="narrow">
      <h1>Owner sign-in</h1>
      <p className="muted">For business owners. We email you a link; there is no password.</p>
      {error === "not_registered" && <p role="alert" className="error">That account isn't registered as a business owner.</p>}
      {error === "link" && <p role="alert" className="error">That sign-in link didn't work or has expired. Request a new one.</p>}
      <LoginForm preview={devPreviewEnabled()} />
    </main>
  );
}
