import { formatCents } from "../money";

// Consent wording for saving a payment method and charging it later (off-session).
// Stripe's save-and-reuse guide says our terms must cover: (1) the customer's agreement to
// our initiating payments on their behalf, (2) timing and frequency, (3) how the amount is
// determined, (4) cancellation. We record which version each contributor agreed to.
//
// DRAFT until an attorney reviews it. Changing any wording REQUIRES a new version string:
// tests/unit/consent.test.ts pins a hash of the current rendering and fails otherwise.

export const CONSENT_VERSION = "v2-draft";

export interface ConsentInput {
  legalName: string;
  itemName: string;
  amountCents: number;
  deadline: Date | null;
  descriptor: string;
}

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });

export function consentText(i: ConsentInput): string {
  const amount = formatCents(i.amountCents);
  const retry = "If a charge doesn't go through, it may be retried up to two more times over about four days. If my bank needs extra verification, I'll get an email with a link to finish.";
  const manage = "Until I'm charged, I can cancel my pledge from the link emailed to me.";
  const statement = `The charge will appear on my statement as ${i.descriptor}.`;

  const by = i.deadline ? ` by ${dateFmt.format(i.deadline)}` : "";
  return [
    `I authorize ${i.legalName} to charge the payment method I'm providing, one time, for up to ${amount} toward ${i.itemName}.`,
    `I won't be charged unless ${i.itemName} is fully pledged${by}. If it is, the charge happens automatically soon after, without further action from me.`,
    `If the item needs less than my pledge, I'll be charged only the amount needed, and the rest won't be charged.`,
    manage, retry, statement,
  ].join(" ");
}
