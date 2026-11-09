/** Today's calendar date on this device, which is what "overdue" means to a person. */
export function localToday() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** Formats a date-only value without letting the time zone shift the day. */
export function formatDay(date: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

export function formatMoment(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const meetingHighlightPath = (meetingId: string, itemId: string) =>
  `/meetings/${meetingId}?highlight=${encodeURIComponent(itemId)}`;

export const LEDGER_FILTERS = [
  "active",
  "needsReview",
  "overdue",
  "revisited",
  "completed",
  "rejected",
] as const;
export type LedgerFilter = (typeof LEDGER_FILTERS)[number];

interface FilterableEntry {
  status: string;
  reviewState: string;
  health: { needsReview: boolean; overdue: boolean; revisited: boolean };
}

/** Rejected commitments only appear under their own filter. */
export function matchesLedgerFilter(
  entry: FilterableEntry,
  filter: LedgerFilter,
) {
  if (filter === "rejected") return entry.reviewState === "rejected";
  if (entry.reviewState === "rejected") return false;
  switch (filter) {
    case "needsReview":
      return entry.health.needsReview;
    case "overdue":
      return entry.health.overdue;
    case "revisited":
      return entry.health.revisited;
    case "completed":
      return entry.status === "completed";
    default:
      return true;
  }
}
