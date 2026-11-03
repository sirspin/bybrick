import type { FeeConfig } from "./config";

/** The platform fee never takes more than half of a charge. */
export const MAX_FEE_SHARE_BPS = 5000;

/**
 * application_fee_amount for one charge, in cents. Stripe requires it to be positive and
 * less than the charge, so 0 means "send no fee". Integer math only; rounds half up.
 * With fees_collector = stripe, Stripe takes its own processing fee separately, so this
 * is our fee only.
 */
export function applicationFeeCents(chargeCents: number, fee: FeeConfig): number {
  if (!Number.isSafeInteger(chargeCents) || chargeCents <= 0) {
    throw new RangeError("charge must be a positive whole number of cents");
  }
  const raw = Math.floor((chargeCents * fee.bps + 5000) / 10000) + fee.fixedCents;
  const cap = Math.floor((chargeCents * MAX_FEE_SHARE_BPS) / 10000);
  const capped = Math.min(raw, cap, chargeCents - 1);
  return Math.max(capped, 0);
}
