import { useActionMutation } from "@agent-native/core/client/hooks";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  buildPatch,
  describeFailure,
  draftFromCommitment,
  findParticipant,
  PRIORITY_LABELS,
  selectableStatuses,
  STATUS_LABELS,
  type CommitmentDraft,
} from "@/lib/commitment-edit";
import { cn } from "@/lib/utils";

import type { CommitmentResult } from "../../../server/lib/meeting-results";
import { AssignmentHandoff } from "./AssignmentHandoff";
import { CommitmentHistory } from "./CommitmentHistory";
import { EvidenceList, summarizeEvidence } from "./EvidenceList";

export interface Participant {
  id: string;
  displayName: string;
  aliases: string[];
}

const selectClass =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60";

const FLAG_ACTION: Record<string, string> = {
  evidence: "Accept without transcript support",
  owner: "Accept owner as is",
  deadline: "Accept date as is",
  note: "Accept",
  legacy: "Accept",
};

/** Flags are accepted by code, so flags sharing a code share one row and button. */
function groupFlags(flags: CommitmentResult["reviewFlags"]) {
  const grouped = new Map<string, CommitmentResult["reviewFlags"][number]>();
  for (const flag of flags) {
    const existing = grouped.get(flag.code);
    grouped.set(
      flag.code,
      existing
        ? { ...existing, message: `${existing.message} ${flag.message}` }
        : flag,
    );
  }
  return [...grouped.values()];
}

function ReviewState({ commitment }: { commitment: CommitmentResult }) {
  if (commitment.reviewState === "rejected") {
    return <Badge variant="outline">Rejected</Badge>;
  }
  if (commitment.needsReview) {
    return (
      <Badge
        variant="outline"
        className="border-amber-500/60 text-amber-700 dark:text-amber-400"
      >
        Needs review
      </Badge>
    );
  }
  if (commitment.reviewState === "confirmed") {
    return <Badge variant="secondary">Confirmed by a person</Badge>;
  }
  return <Badge variant="outline">Not yet confirmed</Badge>;
}

export function CommitmentCard({
  commitment,
  people,
  selected,
  onSelect,
  onReloadLatest,
}: {
  commitment: CommitmentResult;
  people: Participant[];
  selected: boolean;
  onSelect: () => void;
  onReloadLatest: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CommitmentDraft>(() =>
    draftFromCommitment(commitment),
  );
  const [problem, setProblem] = useState<{
    message: string;
    conflict: boolean;
    field?: string;
  } | null>(null);

  const rejected = commitment.reviewState === "rejected";
  const evidence = summarizeEvidence(commitment.evidence);
  const stated = findParticipant(commitment.statedOwnerName, people);

  const fail = (error: unknown) => {
    const { kind, message } = describeFailure(error);
    setProblem({ message, conflict: kind === "conflict" });
  };

  const update = useActionMutation("update-commitment", {
    onSuccess: (result) => {
      setProblem(null);
      setEditing(false);
      toast.success(result.changed ? "Changes saved." : "Nothing to change.");
    },
    onError: fail,
  });
  const review = useActionMutation("review-commitment", {
    onSuccess: () => setProblem(null),
    onError: fail,
  });
  const addPerson = useActionMutation("add-person", {
    onSuccess: (result) => {
      setProblem(null);
      setDraft((current) => ({ ...current, ownerId: result.person.id }));
      toast.success(`${result.person.displayName} added to the project.`);
    },
    onError: (error) => {
      const matches = (error as { details?: { matches?: Participant[] } })
        .details?.matches;
      if (matches?.length === 1) {
        // An exact match already exists: select it rather than duplicate.
        setDraft((current) => ({ ...current, ownerId: matches[0]!.id }));
        setProblem({
          message: `${matches[0]!.displayName} is already a participant and is selected.`,
          conflict: false,
        });
        return;
      }
      fail(error);
    },
  });

  const busy = update.isPending || review.isPending || addPerson.isPending;

  function openEditor() {
    setDraft(draftFromCommitment(commitment));
    setProblem(null);
    setEditing(true);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    const result = buildPatch(commitment, draft);
    if (!result.ok) {
      setProblem({
        message: result.message,
        conflict: false,
        field: result.field,
      });
      return;
    }
    if (!result.changed) {
      setEditing(false);
      return;
    }
    update.mutate({
      id: commitment.id,
      expectedVersion: commitment.version,
      ...result.patch,
    });
  }

  const decide = (
    outcome: "confirm" | "reject" | "restore",
    resolveFlags: CommitmentResult["reviewFlags"][number]["code"][] = [],
  ) => {
    if (busy) return;
    review.mutate({
      id: commitment.id,
      expectedVersion: commitment.version,
      outcome,
      resolveFlags,
    });
  };

  const headingId = `commitment-${commitment.id}`;
  return (
    <article
      aria-labelledby={headingId}
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-4 transition-colors",
        selected && "border-primary/60 bg-primary/[0.03]",
        rejected && "opacity-70",
      )}
    >
      <div className="flex flex-col gap-2">
        <h3 id={headingId} className="text-sm font-medium">
          <button
            type="button"
            onClick={onSelect}
            aria-pressed={selected}
            title="Show the source in the transcript"
            className={cn(
              "text-start hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              rejected && "line-through",
              commitment.status === "completed" && "text-muted-foreground",
            )}
          >
            {commitment.description}
          </button>
        </h3>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant={evidence.variant}>{evidence.label}</Badge>
          <ReviewState commitment={commitment} />
          <Badge variant="outline">{STATUS_LABELS[commitment.status]}</Badge>
        </div>
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Owner</dt>
        <dd>
          {commitment.ownerDisplayName ?? "Unassigned"}
          {commitment.statedOwnerName &&
          commitment.statedOwnerName !== commitment.ownerDisplayName ? (
            <span className="text-muted-foreground">
              {" "}
              (transcript says “{commitment.statedOwnerName}”)
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Due</dt>
        <dd>
          {commitment.dueDate ?? "No date"}
          {commitment.statedDueText ? (
            <span className="text-muted-foreground">
              {" "}
              (said: “{commitment.statedDueText}”)
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Priority</dt>
        <dd>
          {commitment.priority
            ? PRIORITY_LABELS[
                commitment.priority as keyof typeof PRIORITY_LABELS
              ]
            : "Not set"}
        </dd>
      </dl>

      {commitment.needsReview ? (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
          <p className="text-sm font-medium">Needs your review</p>
          <ul className="flex flex-col gap-2">
            {groupFlags(commitment.reviewFlags).map((flag) => (
              <li
                key={flag.code}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="min-w-0 flex-1">{flag.message}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => decide("confirm", [flag.code])}
                >
                  {FLAG_ACTION[flag.code] ?? "Accept"}
                </Button>
              </li>
            ))}
          </ul>
          {commitment.reviewFlags.some((flag) => flag.code === "evidence") ? (
            <p className="text-xs text-muted-foreground">
              Accepting records your judgement. The quotation stays marked as
              not verified against the transcript.
            </p>
          ) : null}
        </div>
      ) : null}

      <EvidenceList evidence={commitment.evidence} />

      {problem && !editing ? (
        <p role="alert" className="text-sm text-destructive">
          {problem.message}
        </p>
      ) : null}
      {problem?.conflict && !editing ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onReloadLatest}
        >
          Load latest version
        </Button>
      ) : null}

      {editing ? (
        <form
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) setEditing(false);
          }}
          className="flex flex-col gap-3 border-t pt-3"
          aria-label="Edit commitment"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${headingId}-description`}>Description</Label>
            <Textarea
              id={`${headingId}-description`}
              value={draft.description}
              rows={2}
              disabled={busy}
              aria-invalid={problem?.field === "description"}
              onChange={(event) =>
                setDraft({ ...draft, description: event.target.value })
              }
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${headingId}-owner`}>Owner</Label>
              <select
                id={`${headingId}-owner`}
                className={selectClass}
                value={draft.ownerId}
                disabled={busy}
                onChange={(event) =>
                  setDraft({ ...draft, ownerId: event.target.value })
                }
              >
                <option value="">Unassigned</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.displayName}
                  </option>
                ))}
              </select>
              {commitment.statedOwnerName && stated.length === 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="justify-start"
                  disabled={busy}
                  onClick={() =>
                    addPerson.mutate({
                      projectId: commitment.projectId,
                      displayName: commitment.statedOwnerName!,
                      aliases: [],
                      email: null,
                    })
                  }
                >
                  Add “{commitment.statedOwnerName}” as a participant
                </Button>
              ) : null}
              {stated.length > 1 ? (
                <p className="text-xs text-muted-foreground">
                  “{commitment.statedOwnerName}” matches more than one
                  participant, so choose one.
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${headingId}-due`}>Due date</Label>
              <Input
                id={`${headingId}-due`}
                type="date"
                value={draft.dueDate}
                disabled={busy}
                aria-invalid={problem?.field === "dueDate"}
                onChange={(event) =>
                  setDraft({ ...draft, dueDate: event.target.value })
                }
              />
              {commitment.statedDueText ? (
                <p className="text-xs text-muted-foreground">
                  Transcript says “{commitment.statedDueText}”.
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${headingId}-priority`}>Priority</Label>
              <select
                id={`${headingId}-priority`}
                className={selectClass}
                value={draft.priority}
                disabled={busy}
                onChange={(event) =>
                  setDraft({ ...draft, priority: event.target.value })
                }
              >
                <option value="">Not set</option>
                {Object.entries(PRIORITY_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${headingId}-status`}>Status</Label>
              <select
                id={`${headingId}-status`}
                className={selectClass}
                value={draft.status}
                disabled={busy}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    status: event.target.value as CommitmentDraft["status"],
                  })
                }
              >
                {selectableStatuses(commitment.status).map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {problem ? (
            <div role="alert" className="flex flex-col items-start gap-2">
              <p className="text-sm text-destructive">{problem.message}</p>
              {problem.conflict ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setEditing(false);
                    setProblem(null);
                    onReloadLatest();
                  }}
                >
                  Load latest version
                </Button>
              ) : null}
            </div>
          ) : null}

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy}>
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {rejected ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => decide("restore")}
            >
              Restore for review
            </Button>
          ) : (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={openEditor}
              >
                Edit
              </Button>
              {!commitment.needsReview &&
              commitment.reviewState === "proposed" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => decide("confirm")}
                >
                  Confirm
                </Button>
              ) : null}
              {commitment.reviewFlags.length > 1 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    decide(
                      "confirm",
                      commitment.reviewFlags.map((flag) => flag.code),
                    )
                  }
                >
                  Accept all and confirm
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => decide("reject")}
              >
                Reject
              </Button>
            </>
          )}
        </div>
      )}

      {commitment.reviewedBy && commitment.reviewedAt ? (
        <p className="text-xs text-muted-foreground">
          {rejected ? "Rejected" : "Confirmed"} by {commitment.reviewedBy} on{" "}
          {new Date(commitment.reviewedAt).toLocaleDateString()}.
        </p>
      ) : null}

      <Link
        to={`/commitments/${commitment.id}`}
        className="self-start text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
      >
        View trail across meetings
      </Link>

      <AssignmentHandoff
        commitmentId={commitment.id}
        reviewState={commitment.reviewState}
        projectId={commitment.projectId}
      />

      <CommitmentHistory commitmentId={commitment.id} />
    </article>
  );
}
