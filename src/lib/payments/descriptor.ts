// Card-statement descriptor for a business's Stripe account. Rules come from Stripe's
// statement-descriptor requirements: 5 to 22 Latin characters, at least one letter, none of
// < > \ ' " * ; prefix 2 to 10 characters.

const FORBIDDEN = /[<>\\'"*‘’“”]/g;

export interface Descriptor {
  descriptor: string;
  prefix: string;
}

/** "BIRDY'S" becomes "BIRDYS". Returns null if nothing valid can be made. */
export function statementDescriptor(businessName: string): Descriptor | null {
  const cleaned = businessName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents
    .replace(FORBIDDEN, "")
    .replace(/[^\x20-\x7E]/g, "") // anything non-Latin/printable
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .slice(0, 22)
    .trim();

  if (cleaned.length < 5 || !/[A-Z]/.test(cleaned)) return null;
  const prefix = cleaned.slice(0, 10).trim();
  if (prefix.length < 2) return null;
  return { descriptor: cleaned, prefix };
}
