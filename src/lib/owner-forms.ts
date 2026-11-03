import { z } from "zod";
import { MAX_CENTS, parseDollarsToCents } from "./money";
import { chicagoEndOfDay } from "./dates";

// Owner text is plain text: no angle brackets, no control characters.
const plain = (max: number) =>
  z.string().trim().max(max).refine((s) => !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), "Plain text only (no < or >).");
const req = (max: number) => plain(max).refine((s) => s.length > 0, "Required.");

export const profileSchema = z.object({
  name: req(120),
  legal_name: req(160),
  owner_display: req(120),
  owner_line: plain(200),
  tagline: plain(200),
  story: plain(5000),
  neighborhood: plain(80),
  city: req(80),
  status_line: plain(120),
  contact_email: z.string().trim().toLowerCase().email("Enter a valid email.").max(254),
  accent_color: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour."),
});

const dollars = (label: string, { min = 0 }: { min?: number } = {}) =>
  z.string().trim().transform((v, ctx) => {
    const cents = v === "" ? 0 : parseDollarsToCents(v);
    if (cents === null || cents > MAX_CENTS || cents < min) {
      ctx.addIssue({ code: "custom", message: `${label}: enter a dollar amount like 1,250.00.` });
      return z.NEVER;
    }
    return cents;
  });

export const itemSchema = z.object({
  name: req(120),
  short_name: plain(40),
  note: plain(1000),
  price: dollars("Price", { min: 1 }),
  shipping: dollars("Shipping"),
  tax: dollars("Sales tax"),
  install: dollars("Install"),
  deadline: z.string().trim().transform((v, ctx) => {
    const d = chicagoEndOfDay(v);
    if (!d) { ctx.addIssue({ code: "custom", message: "Pick a deadline date." }); return z.NEVER; }
    return d;
  }),
  source_url: z.string().trim().max(500).refine((v) => {
    if (v === "") return true;
    try { return ["http:", "https:"].includes(new URL(v).protocol); } catch { return false; }
  }, "Link must start with http:// or https://"),
});

export function sourceDomain(url: string): string {
  if (!url) return "";
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

export function firstError(err: z.ZodError): string {
  return err.issues[0]?.message ?? "Check the form and try again.";
}
