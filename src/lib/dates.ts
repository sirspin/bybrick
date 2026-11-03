// Deadlines are entered as a calendar date and mean "end of that day in Chicago".

const TZ = "America/Chicago";

function offsetMinutes(at: Date): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" })
    .formatToParts(at).find((p) => p.type === "timeZoneName")?.value ?? "GMT-6";
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part);
  if (!m) return -360;
  const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === "-" ? -mins : mins;
}

/** "2027-03-15" becomes 23:59 on that day in Chicago, as a real instant. Null if not a real date. */
export function chicagoEndOfDay(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d, 23, 59));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  // Local time = UTC + offset, so UTC = local - offset. Recompute once in case the offset changes.
  let utc = new Date(probe.getTime() - offsetMinutes(probe) * 60_000);
  utc = new Date(probe.getTime() - offsetMinutes(utc) * 60_000);
  return utc;
}

/** The Chicago calendar date of an instant, as YYYY-MM-DD (for date inputs). */
export function chicagoDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}
