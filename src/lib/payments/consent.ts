import { formatCents } from "../money";

// Consent wording for saving a payment method and charging it later (off-session).
// Stripe's save-and-reuse guide says our terms must cover: (1) the customer's agreement to
// our initiating payments on their behalf, (2) timing and frequency, (3) how the amount is
// determined, (4) cancellation. We record which version each contributor agreed to.
//
// DRAFT until an attorney reviews it. Changing any wording REQUIRES a new version string:
// tests/unit/consent.test.ts pins a hash of the current rendering and fails otherwise.

export const CONSENT_VERSION = "v1-draft";
export const POOL_EXPIRY_DAYS = 90; // assumption pending a product decision

export interface ConsentInput {
  legalName: string;
  /** null = the "wherever it's needed" pool */
  itemName: string | null;
  amountCents: number;
  /** Item deadline; ignored for the pool. */
  deadline: Date | null;
  sendExtraToPool: boolean;
  descriptor: string;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });

export function consentText(i: ConsentInput): string {
  const amount = formatCents(i.amountCents);
  const retry = "If a charge doesn't go through, it may be retried up to two more times over about four days. If my bank needs extra verification, I'll get an email with a link to finish.";
  const manage = "Until I'm charged, I can cancel, or move my pledge to where it's needed, from the link emailed to me.";
  const statement = `The charge will appear on my statement as ${i.descriptor}.`;

  if (i.itemName === null) {
    return [
      `I authorize ${i.legalName} to charge the payment method I'm providing, one time, for up to ${amount} toward whatever it needs next.`,
      `I'll be charged only when my pledge is applied to an item that becomes fully pledged, which could happen any time in the next ${POOL_EXPIRY_DAYS} days, without further action from me. After that my pledge expires and I won't be charged.`,
      "If that item needs less than my pledge, I'll be charged only what's needed and the rest stays in the pool.",
      manage, retry, statement,
    ].join(" ");
  }

  const by = i.deadline ? ` by ${dateFmt.format(i.deadline)}` : "";
  const rest = i.sendExtraToPool
    ? "the rest may be applied to other items at the same business"
    : "the rest won't be charged";
  return [
    `I authorize ${i.legalName} to charge the payment method I'm providing, one time, for up to ${amount} toward ${i.itemName}.`,
    `I won't be charged unless ${i.itemName} is fully pledged${by}. If it is, the charge happens automatically soon after, without further action from me.`,
    `If the item needs less than my pledge, I'll be charged only the amount needed, and ${rest}.`,
    manage, retry, statement,
  ].join(" ");
}
