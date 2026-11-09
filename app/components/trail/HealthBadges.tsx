import { Badge } from "@/components/ui/badge";

export const REVIEW_BADGE_CLASS =
  "border-amber-500/60 text-amber-700 dark:text-amber-400";

/** Derived signals only. Each one is shown because saved data supports it. */
export function HealthBadges({
  health,
  rejected,
}: {
  health: {
    overdue: boolean;
    daysOverdue: number | null;
    revisited: boolean;
    needsReview: boolean;
    verifiedMeetingCount: number;
  };
  rejected: boolean;
}) {
  return (
    <>
      {rejected ? <Badge variant="outline">Rejected</Badge> : null}
      {health.overdue ? (
        <Badge variant="destructive">
          Overdue by {health.daysOverdue} day
          {health.daysOverdue === 1 ? "" : "s"}
        </Badge>
      ) : null}
      {health.needsReview ? (
        <Badge variant="outline" className={REVIEW_BADGE_CLASS}>
          Needs review
        </Badge>
      ) : null}
      {health.revisited ? (
        <Badge variant="secondary">
          Revisited in {health.verifiedMeetingCount} meetings
        </Badge>
      ) : null}
    </>
  );
}
