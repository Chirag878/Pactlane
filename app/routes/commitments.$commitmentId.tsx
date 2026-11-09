import {
  actionErrorMessage,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useMemo } from "react";
import { Link, useParams } from "react-router";

import {
  FIELD_LABELS,
  formatHistoryValue,
} from "@/components/meetings/CommitmentHistory";
import { EVIDENCE_LABELS } from "@/components/meetings/EvidenceList";
import { HealthBadges } from "@/components/trail/HealthBadges";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS } from "@/lib/commitment-edit";
import {
  formatDay,
  formatMoment,
  localToday,
  meetingHighlightPath,
} from "@/lib/trail-format";
import { cn } from "@/lib/utils";

export function meta() {
  return [{ title: "Commitment Trail - Pactlane" }];
}

interface TrailEvent {
  id: string;
  kind: "origin" | "mention" | "edit" | "review" | "dismissal";
  occurredAt: string;
  precision: "date" | "time";
  actorType: "user" | "agent" | "system" | null;
  actorId: string | null;
  meeting: { id: string; title: string; date: string } | null;
  evidence: {
    id: string;
    sourceQuote: string;
    verificationStatus: keyof typeof EVIDENCE_LABELS;
    linkedAt: string | null;
  }[];
  fields: { field: string; before: unknown; after: unknown }[];
}

function eventCopy(event: TrailEvent) {
  const person = event.actorId ?? "Someone";
  switch (event.kind) {
    case "origin":
      return {
        title: `First recorded in ${event.meeting?.title ?? "a meeting"}`,
        chip: "Original transcript evidence",
      };
    case "mention":
      return {
        title: `Mentioned again in ${event.meeting?.title ?? "a meeting"}`,
        chip: "Human-confirmed link",
      };
    case "review":
      return { title: `Reviewed by ${person}`, chip: "Review decision" };
    case "dismissal":
      return {
        title: `${person} ruled out a suggestion`,
        chip: "Review decision",
      };
    default:
      return event.actorType === "agent"
        ? {
            title: `Changed by the AI agent, for ${person}`,
            chip: "Agent change",
          }
        : { title: `Changed by ${person}`, chip: "Manual change" };
  }
}

function TrailEventItem({
  event,
  commitmentId,
}: {
  event: TrailEvent;
  commitmentId: string;
}) {
  const copy = eventCopy(event);
  const fromTranscript = event.kind === "origin" || event.kind === "mention";
  return (
    <li className="flex gap-4">
      <div className="flex flex-col items-center" aria-hidden="true">
        <span
          className={cn(
            "mt-1 size-2.5 shrink-0 rounded-full",
            fromTranscript
              ? "bg-foreground"
              : "border-2 border-muted-foreground bg-background",
          )}
        />
        <span className="w-px flex-1 bg-border" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2 pb-8">
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">
            <time dateTime={event.occurredAt}>
              {event.precision === "date"
                ? formatDay(event.occurredAt.slice(0, 10))
                : formatMoment(event.occurredAt)}
            </time>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{copy.title}</h3>
            <Badge variant="outline">{copy.chip}</Badge>
          </div>
          {event.kind === "mention" && event.actorId ? (
            <p className="text-xs text-muted-foreground">
              Link confirmed by {event.actorId}
              {event.evidence[0]?.linkedAt
                ? ` on ${formatMoment(event.evidence[0].linkedAt)}`
                : ""}
              .
            </p>
          ) : null}
        </div>

        {event.evidence.length > 0 ? (
          <ul className="flex flex-col gap-3">
            {event.evidence.map((item) => {
              const status = EVIDENCE_LABELS[item.verificationStatus];
              const located = item.verificationStatus === "verified";
              return (
                <li key={item.id} className="flex flex-col items-start gap-1.5">
                  <blockquote className="border-s-2 border-border ps-3 text-sm">
                    {item.sourceQuote}
                  </blockquote>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={status.variant}>{status.label}</Badge>
                    {event.meeting ? (
                      <Link
                        to={meetingHighlightPath(
                          event.meeting.id,
                          commitmentId,
                        )}
                        className="text-xs underline-offset-2 hover:underline"
                      >
                        {located ? "Show in transcript" : "Open meeting"}
                      </Link>
                    ) : null}
                  </div>
                  {located ? null : (
                    <p className="text-xs text-muted-foreground">
                      Pactlane could not place these words in the transcript, so
                      nothing is highlighted.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}

        {event.fields.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-sm text-muted-foreground">
            {event.fields.map((f) => (
              <li key={f.field}>
                {FIELD_LABELS[f.field] ?? f.field}:{" "}
                {f.before !== null || event.kind !== "dismissal" ? (
                  <>
                    {formatHistoryValue(f.field, f.before)}
                    {" → "}
                  </>
                ) : null}
                <span className="text-foreground">
                  {formatHistoryValue(f.field, f.after)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

export default function CommitmentTrailRoute() {
  const { commitmentId = "" } = useParams();
  const asOf = useMemo(localToday, []);
  const { data, isLoading, error } = useActionQuery("get-commitment-trail", {
    id: commitmentId,
    asOf,
  });

  if (error) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <p role="alert" className="text-sm text-destructive">
          {actionErrorMessage(error) ?? "Could not load this commitment."}
        </p>
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="mx-auto w-full max-w-3xl p-6">
        <p className="text-sm text-muted-foreground">Loading the trail…</p>
      </div>
    );
  }

  const { commitment, original, events } = data;
  const { health } = commitment;
  const rejected = commitment.reviewState === "rejected";
  const owner =
    commitment.ownerDisplayName ?? commitment.statedOwnerName ?? "Unassigned";
  const originalOwner = original?.owner ?? original?.statedOwnerName ?? null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <header className="flex flex-col gap-3">
        <Link
          to={`/projects/${commitment.projectId}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          Back to project
        </Link>
        <h1
          className={cn(
            "text-xl font-semibold",
            rejected && "text-muted-foreground line-through",
          )}
        >
          {commitment.description}
        </h1>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline">{STATUS_LABELS[commitment.status]}</Badge>
          <HealthBadges health={health} rejected={rejected} />
        </div>
      </header>

      <section aria-label="Current state" className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Owner</dt>
            <dd className="font-medium">{owner}</dd>
            {originalOwner && originalOwner !== owner ? (
              <dd className="text-xs text-muted-foreground">
                First: {originalOwner}
              </dd>
            ) : null}
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Due</dt>
            <dd className="font-medium">
              {commitment.dueDate ? formatDay(commitment.dueDate) : "No date"}
            </dd>
            {original?.dueDate && original.dueDate !== commitment.dueDate ? (
              <dd className="text-xs text-muted-foreground">
                First: {formatDay(original.dueDate)}
              </dd>
            ) : null}
            {commitment.dueDate && !health.dueDateConfirmed ? (
              <dd className="text-xs text-muted-foreground">Not confirmed</dd>
            ) : null}
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Meetings</dt>
            <dd className="font-medium tabular-nums">{health.meetingCount}</dd>
            {health.firstMeetingDate && health.latestMeetingDate ? (
              <dd className="text-xs text-muted-foreground">
                {formatDay(health.firstMeetingDate)} to{" "}
                {formatDay(health.latestMeetingDate)}
              </dd>
            ) : null}
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Evidence</dt>
            <dd className="font-medium tabular-nums">
              {commitment.evidence.verified} of {commitment.evidence.total}{" "}
              verified
            </dd>
          </div>
        </dl>
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          {health.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
        {commitment.originMeeting ? (
          <Link
            to={meetingHighlightPath(
              commitment.originMeeting.id,
              commitment.id,
            )}
            className="self-start text-sm underline-offset-2 hover:underline"
          >
            Edit or review in {commitment.originMeeting.title}
          </Link>
        ) : null}
      </section>

      <section aria-labelledby="trail-heading" className="flex flex-col gap-4">
        <h2 id="trail-heading" className="text-base font-semibold">
          Trail
        </h2>
        <ol>
          {events.map((event) => (
            <TrailEventItem
              key={event.id}
              event={event}
              commitmentId={commitment.id}
            />
          ))}
          <li className="flex gap-4">
            <div className="flex flex-col items-center" aria-hidden="true">
              <span className="mt-1 size-2.5 shrink-0 rounded-full bg-primary" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="text-xs text-muted-foreground">
                As of {formatDay(data.asOf)}
              </p>
              <h3 className="text-sm font-medium">
                Now {STATUS_LABELS[commitment.status].toLowerCase()}
                {health.overdue ? ", overdue" : ""}
              </h3>
            </div>
          </li>
        </ol>
      </section>
    </div>
  );
}
