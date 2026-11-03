import { formatCents } from "@/lib/money";

const dateFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
export function formatDate(iso: string | null | undefined): string {
  return iso ? dateFmt.format(new Date(iso)) : "";
}

export function Progress({ raised, goal, label }: { raised: number; goal: number; label: string }) {
  const pct = goal > 0 ? Math.min(100, Math.round((raised / goal) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Raised({ raised, goal }: { raised: number; goal: number }) {
  return (
    <span className="raised">
      <strong>{formatCents(raised)}</strong> of {formatCents(goal)}
    </span>
  );
}

const LABELS: Record<string, string> = {
  draft: "Draft", open: "Open", funded: "Funded", purchased: "Purchased", in_use: "In use", expired: "Expired", cancelled: "Cancelled",
  pending: "Pledged", charging: "Charging", requires_action: "Needs action", charged: "Charged", failed: "Failed",
};
export function StatusChip({ status }: { status: string }) {
  return <span className={`chip chip-${status}`}>{LABELS[status] ?? status}</span>;
}
