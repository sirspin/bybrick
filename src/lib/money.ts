// Money helpers. All amounts are integer cents. No floats anywhere.
// The database is the source of truth for goals and balances; these helpers are for
// display and for validating owner input before it reaches the database.

export const MAX_CENTS = 100_000_000; // $1,000,000, matches DB check constraints

export function assertCents(n: number, label = "amount"): number {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_CENTS) {
    throw new RangeError(`${label} must be a whole number of cents between 0 and ${MAX_CENTS}`);
  }
  return n;
}

export interface GoalParts {
  priceCents: number;
  shippingCents?: number;
  taxCents?: number;
  installCents?: number;
}

/** Goal = price + shipping + tax + install. Mirrors the database trigger. */
export function computeGoal(p: GoalParts): number {
  const goal =
    assertCents(p.priceCents, "price") +
    assertCents(p.shippingCents ?? 0, "shipping") +
    assertCents(p.taxCents ?? 0, "tax") +
    assertCents(p.installCents ?? 0, "install");
  if (goal <= 0 || goal > MAX_CENTS) throw new RangeError("goal must be between 1 cent and the maximum");
  return goal;
}

export interface Suggestion {
  cents: number;
  /** "finish" is the button that pays the whole remainder. */
  kind: "amount" | "finish";
}

const dollars = (n: number) => n * 100;

/** Round to whole dollars, half up. */
const roundToDollar = (cents: number) => Math.floor((cents + 50) / 100) * 100;

/**
 * Suggested pledge buttons from an item's remaining balance.
 *  - under $60: one button for the full remainder
 *  - $60 to $150 (inclusive): a quarter, a half, and "Finish it"
 *  - over $150 up to $300 (inclusive): $25 / $50 / $100 / "Finish it"
 *  - over $300: $25 / $50 / $100 / $250
 * Never suggests more than the remainder. The brief's ranges share the $150 edge;
 * $150 is treated as the top of the $60 to $150 range.
 */
export function suggestedAmounts(remainingCents: number): Suggestion[] {
  if (!Number.isSafeInteger(remainingCents) || remainingCents <= 0) return [];
  const r = remainingCents;

  if (r < dollars(60)) return [{ cents: r, kind: "finish" }];

  if (r <= dollars(150)) {
    const quarter = roundToDollar(r / 4);
    const half = roundToDollar(r / 2);
    const out: Suggestion[] = [];
    if (quarter < r) out.push({ cents: quarter, kind: "amount" });
    if (half < r && half !== quarter) out.push({ cents: half, kind: "amount" });
    out.push({ cents: r, kind: "finish" });
    return out;
  }

  if (r <= dollars(300)) {
    return [
      ...[25, 50, 100].map((d) => ({ cents: dollars(d), kind: "amount" as const })),
      { cents: r, kind: "finish" as const },
    ];
  }

  return [25, 50, 100, 250].map((d) => ({ cents: dollars(d), kind: "amount" as const }));
}

/** "$1,234.50" style. Whole dollars drop the cents: "$25". */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = abs % 100;
  return `${sign}$${whole}${frac ? "." + frac.toString().padStart(2, "0") : ""}`;
}

/** Parse a user-typed dollar amount ("25", "25.5", "$1,200.00") to cents. Null if invalid. */
export function parseDollarsToCents(input: string): number | null {
  const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const whole = Number(m[1]!.replace(/,/g, ""));
  const frac = m[2] ? Number(m[2].padEnd(2, "0")) : 0;
  const cents = whole * 100 + frac;
  return Number.isSafeInteger(cents) && cents <= MAX_CENTS ? cents : null;
}
