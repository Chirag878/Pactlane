import {
  actionErrorMessage,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useMemo, useState } from "react";
import { Link } from "react-router";

import { STATUS_LABELS } from "@/lib/commitment-edit";
import {
  formatDay,
  formatMoment,
  LEDGER_FILTERS,
  localToday,
  matchesLedgerFilter,
  type LedgerFilter,
} from "@/lib/trail-format";
import { cn } from "@/lib/utils";

import { HealthBadges } from "./HealthBadges";

const FILTER_LABELS: Record<LedgerFilter, string> = {
  active: "All",
  needsReview: "Needs review",
  overdue: "Overdue",
  revisited: "Revisited",
  completed: "Completed",
  rejected: "Rejected",
};

const ownerLabel = (entry: {
  ownerDisplayName: string | null;
  statedOwnerName: string | null;
}) => entry.ownerDisplayName ?? entry.statedOwnerName ?? "Unassigned";

const meetingsLabel = (count: number) =>
  `${count} meeting${count === 1 ? "" : "s"}`;

export function CommitmentLedger({ projectId }: { projectId: string }) {
  const [filter, setFilter] = useState<LedgerFilter>("active");
  const asOf = useMemo(localToday, []);
  const { data, isLoading, error } = useActionQuery("get-commitment-ledger", {
    projectId,
    asOf,
  });

  const entries = data?.entries ?? [];
  const visible = entries.filter((e) => matchesLedgerFilter(e, filter));

  return (
    <section aria-labelledby="ledger-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="ledger-heading" className="text-base font-semibold">
          Commitments
        </h2>
        <p className="text-sm text-muted-foreground">
          Every promise in this project, across its meetings.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {actionErrorMessage(error) ?? "Could not load the commitments."}
        </p>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">Loading commitments…</p>
      ) : entries.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          No commitments yet. Add a meeting below and analyze it, and what
          people promised will appear here.
        </p>
      ) : (
        <>
          <div
            role="group"
            aria-label="Filter commitments"
            className="flex flex-wrap gap-1.5"
          >
            {LEDGER_FILTERS.map((option) => {
              const count = entries.filter((e) =>
                matchesLedgerFilter(e, option),
              ).length;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={filter === option}
                  onClick={() => setFilter(option)}
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    filter === option
                      ? "border-foreground bg-foreground text-background"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {FILTER_LABELS[option]}{" "}
                  <span className="tabular-nums opacity-70">{count}</span>
                </button>
              );
            })}
          </div>

          {visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing matches this filter.
            </p>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              <table className="w-full table-fixed text-sm">
                <caption className="sr-only">
                  Commitments in this project
                </caption>
                <thead className="hidden border-b bg-muted/30 text-start text-xs text-muted-foreground md:table-header-group">
                  <tr>
                    <th
                      scope="col"
                      className="w-[38%] px-4 py-2 text-start font-medium"
                    >
                      Commitment
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-start font-medium"
                    >
                      Owner
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-start font-medium"
                    >
                      Due
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-start font-medium"
                    >
                      Status
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-start font-medium"
                    >
                      Meetings
                    </th>
                    <th
                      scope="col"
                      className="px-3 py-2 text-start font-medium"
                    >
                      Last activity
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {visible.map((entry) => (
                    <tr key={entry.id} className="align-top">
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1.5">
                          <Link
                            to={`/commitments/${entry.id}`}
                            className={cn(
                              "font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              entry.reviewState === "rejected" &&
                                "text-muted-foreground line-through",
                            )}
                          >
                            {entry.description}
                          </Link>
                          <div className="flex flex-wrap gap-1 empty:hidden">
                            <HealthBadges
                              health={entry.health}
                              rejected={entry.reviewState === "rejected"}
                            />
                          </div>
                          <p className="text-xs text-muted-foreground md:hidden">
                            {ownerLabel(entry)} ·{" "}
                            {entry.dueDate
                              ? formatDay(entry.dueDate)
                              : "No date"}{" "}
                            · {STATUS_LABELS[entry.status]} ·{" "}
                            {meetingsLabel(entry.health.meetingCount)}
                          </p>
                        </div>
                      </td>
                      <td className="hidden px-3 py-3 md:table-cell">
                        {ownerLabel(entry)}
                      </td>
                      <td className="hidden px-3 py-3 md:table-cell">
                        {entry.dueDate ? formatDay(entry.dueDate) : "No date"}
                      </td>
                      <td className="hidden px-3 py-3 md:table-cell">
                        {STATUS_LABELS[entry.status]}
                      </td>
                      <td className="hidden px-3 py-3 tabular-nums md:table-cell">
                        {meetingsLabel(entry.health.meetingCount)}
                      </td>
                      <td className="hidden px-3 py-3 text-muted-foreground md:table-cell">
                        {formatMoment(entry.lastUpdatedAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data?.truncated ? (
            <p className="text-xs text-muted-foreground">
              Showing the first {entries.length} commitments.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
