import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { describeFailure, STATUS_LABELS } from "@/lib/commitment-edit";
import { formatDay, localToday } from "@/lib/trail-format";

import { EVIDENCE_LABELS, type EvidenceStatus } from "./EvidenceList";

export interface InspectRange {
  quote: string;
  start: number | null;
  end: number | null;
}

/** Manual route for a match the suggestions missed, such as one the agent named. */
function ManualLink({
  meetingId,
  projectId,
  meetingDate,
  busy,
  onLink,
}: {
  meetingId: string;
  projectId: string;
  meetingDate: string;
  busy: boolean;
  onLink: (commitmentId: string, quote: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [commitmentId, setCommitmentId] = useState("");
  const [quote, setQuote] = useState("");
  const { data } = useActionQuery(
    "get-commitment-ledger",
    { projectId, asOf: localToday() },
    { enabled: open },
  );
  const eligible = (data?.entries ?? []).filter(
    (entry) =>
      entry.reviewState !== "rejected" &&
      entry.originMeeting?.id !== meetingId &&
      (!entry.originMeeting || entry.originMeeting.date <= meetingDate),
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !commitmentId || !quote.trim()) return;
    onLink(commitmentId, quote);
    setQuote("");
  }

  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
        Link an earlier commitment yourself
      </summary>
      <form onSubmit={submit} className="mt-3 flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-link-commitment">Commitment</Label>
          <select
            id="manual-link-commitment"
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={commitmentId}
            onChange={(event) => setCommitmentId(event.target.value)}
            required
          >
            <option value="">Choose a commitment</option>
            {eligible.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.description}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-link-quote">Quotation from this meeting</Label>
          <Textarea
            id="manual-link-quote"
            rows={2}
            value={quote}
            onChange={(event) => setQuote(event.target.value)}
            required
          />
          <p className="text-xs text-muted-foreground">
            Use the exact words. Anything else is saved as not found in the
            transcript.
          </p>
        </div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          className="self-start"
          disabled={busy}
        >
          Confirm link
        </Button>
      </form>
    </details>
  );
}

/**
 * Suggestions are visually separate from saved facts, and only a person's click
 * here can turn one into evidence.
 */
export function LinkReviewPanel({
  meetingId,
  projectId,
  meetingDate,
  onInspect,
}: {
  meetingId: string;
  projectId: string;
  meetingDate: string;
  onInspect: (range: InspectRange) => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const { data, isLoading, error } = useActionQuery(
    "find-commitment-candidates",
    { meetingId },
  );
  const onError = (failure: unknown) =>
    setProblem(describeFailure(failure).message);
  const link = useActionMutation("link-commitment-evidence", {
    uiOnly: true,
    onSuccess: (result) => {
      setProblem(null);
      if (result.replayed) toast.info("This link already exists.");
      else if (result.verificationStatus === "verified") {
        toast.success("Linked. The quotation is verified in this transcript.");
      } else {
        toast.warning(
          "Linked, but the quotation could not be verified in this transcript.",
        );
      }
    },
    onError,
  });
  const dismiss = useActionMutation("dismiss-commitment-link", {
    uiOnly: true,
    onSuccess: () => setProblem(null),
    onError,
  });
  const busy = link.isPending || dismiss.isPending;

  const statements = data?.statements ?? [];

  return (
    <section
      aria-labelledby="link-review-heading"
      className="flex flex-col gap-3 rounded-lg border border-dashed p-4"
    >
      <div className="flex flex-col gap-1">
        <h2 id="link-review-heading" className="text-base font-semibold">
          Possible links to earlier commitments
        </h2>
        <p className="text-sm text-muted-foreground">
          Suggestions from matching words and names. Nothing is linked until you
          confirm it.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {actionErrorMessage(error) ??
            "Could not look for related commitments."}
        </p>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">Looking for matches…</p>
      ) : statements.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No statement here appears to refer to an earlier commitment.
        </p>
      ) : (
        <ul className="flex flex-col gap-5">
          {statements.map((statement) => {
            const repeated = statement.occurrences > 1;
            const preview =
              EVIDENCE_LABELS[
                (repeated ? "ambiguous" : "verified") as EvidenceStatus
              ];
            return (
              <li key={statement.quote} className="flex flex-col gap-3">
                <div className="flex flex-col items-start gap-1">
                  <p className="text-xs font-medium text-muted-foreground">
                    Said in this meeting
                  </p>
                  <blockquote className="border-s-2 border-border ps-3 text-sm">
                    {statement.quote}
                  </blockquote>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={preview.variant}>{preview.label}</Badge>
                    {statement.start !== null ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          onInspect({
                            quote: statement.quote,
                            start: statement.start,
                            end: statement.end,
                          })
                        }
                      >
                        Show in transcript
                      </Button>
                    ) : null}
                  </div>
                  {repeated ? (
                    <p className="text-xs text-muted-foreground">
                      These exact words appear {statement.occurrences} times in
                      this transcript, so a link is saved as ambiguous.
                    </p>
                  ) : null}
                  {statement.savedFromThisMeeting ? (
                    <p className="text-xs text-muted-foreground">
                      This meeting&apos;s analysis also saved it as “
                      {statement.savedFromThisMeeting.description}”, which may
                      be a duplicate.
                    </p>
                  ) : null}
                </div>

                {statement.candidates.length > 1 ? (
                  <p className="text-sm font-medium">
                    More than one earlier commitment could match. Choose the
                    right one, or rule each out.
                  </p>
                ) : null}

                {statement.candidates.map((candidate) => (
                  <article
                    key={candidate.commitmentId}
                    className="flex flex-col gap-2 rounded-md border p-3"
                  >
                    <h3 className="text-sm font-medium">
                      <Link
                        to={`/commitments/${candidate.commitmentId}`}
                        className="hover:underline"
                      >
                        {candidate.description}
                      </Link>
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {candidate.ownerName ?? "Unassigned"} ·{" "}
                      {STATUS_LABELS[candidate.status]} ·{" "}
                      {candidate.dueDate
                        ? `Due ${formatDay(candidate.dueDate)}`
                        : "No date"}
                      {candidate.originMeeting
                        ? ` · From ${candidate.originMeeting.title}, ${formatDay(candidate.originMeeting.date)}`
                        : ""}
                    </p>
                    {candidate.originalQuotes.map((original) => (
                      <blockquote
                        key={original.quote}
                        className="border-s-2 border-border ps-3 text-sm text-muted-foreground"
                      >
                        {original.quote}
                      </blockquote>
                    ))}
                    <ul className="list-disc ps-4 text-xs text-muted-foreground">
                      {candidate.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          link.mutate({
                            commitmentId: candidate.commitmentId,
                            meetingId,
                            quote: statement.quote,
                            ...(statement.start !== null &&
                            statement.end !== null
                              ? { start: statement.start, end: statement.end }
                              : {}),
                            ...(statement.savedFromThisMeeting
                              ? {
                                  duplicateCommitmentId:
                                    statement.savedFromThisMeeting.id,
                                }
                              : {}),
                            asOf: localToday(),
                          })
                        }
                      >
                        {statement.savedFromThisMeeting
                          ? "Confirm link and reject duplicate"
                          : "Confirm link"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          dismiss.mutate({
                            commitmentId: candidate.commitmentId,
                            meetingId,
                            quote: statement.quote,
                          })
                        }
                      >
                        Not related
                      </Button>
                    </div>
                  </article>
                ))}
              </li>
            );
          })}
        </ul>
      )}

      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}

      <ManualLink
        meetingId={meetingId}
        projectId={projectId}
        meetingDate={meetingDate}
        busy={busy}
        onLink={(commitmentId, quote) =>
          link.mutate({ commitmentId, meetingId, quote, asOf: localToday() })
        }
      />
    </section>
  );
}
