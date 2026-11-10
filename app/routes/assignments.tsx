import {
  actionErrorMessage,
  useActionMutation,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export function meta() {
  return [{ title: "My Assignments - Pactlane" }];
}

const STATUS_LABELS = {
  pending: "Awaiting acknowledgement",
  accepted: "Accepted",
  disputed: "Disputed",
  in_progress: "In progress",
  completed: "Completed",
} as const;

type Assignment = {
  id: string;
  commitmentId: string;
  projectId: string;
  projectName: string;
  organizationId: string;
  organizationName: string;
  description: string;
  dueDate: string | null;
  status: keyof typeof STATUS_LABELS;
  assignedBy: string;
  assignedAt: string;
  note: string | null;
  version: number;
  sourceMeetingId: string | null;
  sourceMeetingTitle: string | null;
};

function AssignmentCard({
  assignment,
  onChanged,
}: {
  assignment: Assignment;
  onChanged: () => void;
}) {
  const [note, setNote] = useState("");
  const update = useActionMutation("update-assignment", {
    uiOnly: true,
    onSuccess: (result) => {
      setNote("");
      onChanged();
      toast.success(`Assignment ${result.assignment.status.replace("_", " ")}.`);
    },
    onError: (error) =>
      toast.error(actionErrorMessage(error) ?? "Could not update the assignment."),
  });

  function move(status: Assignment["status"]) {
    if (update.isPending) return;
    update.mutate({
      assignmentId: assignment.id,
      expectedVersion: assignment.version,
      status,
      note: note.trim() ? note.trim() : null,
    });
  }

  return (
    <article aria-labelledby={`assignment-${assignment.id}`} className="flex flex-col gap-3 rounded-xl border p-4 sm:p-5">
      <div className="flex flex-col gap-1">
        <h2 id={`assignment-${assignment.id}`} className="text-sm font-medium">
          {assignment.description}
        </h2>
        <p className="text-xs text-muted-foreground">
          {assignment.organizationName} · {assignment.projectName}
          {assignment.dueDate ? ` \u00b7 Due ${assignment.dueDate}` : ""}
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Badge variant={assignment.status === "completed" ? "secondary" : "outline"}>
          {STATUS_LABELS[assignment.status]}
        </Badge>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Assigned by</dt>
        <dd>{assignment.assignedBy} on {new Date(assignment.assignedAt).toLocaleDateString()}</dd>
        {assignment.sourceMeetingId ? (
          <>
            <dt className="text-muted-foreground">Source</dt>
            <dd>
              <Link to={`/meetings/${assignment.sourceMeetingId}`} className="underline-offset-2 hover:underline">
                {assignment.sourceMeetingTitle ?? "Source meeting"}
              </Link>
            </dd>
          </>
        ) : null}
        {assignment.note ? (
          <>
            <dt className="text-muted-foreground">Note</dt>
            <dd>{assignment.note}</dd>
          </>
        ) : null}
      </dl>
      {assignment.status === "pending" ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`note-${assignment.id}`}>
              Note <span className="text-muted-foreground">(required to dispute, optional otherwise)</span>
            </Label>
            <Textarea
              id={`note-${assignment.id}`}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              maxLength={2000}
              disabled={update.isPending}
              placeholder="Add context for the assigner\u2026"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={update.isPending} onClick={() => move("accepted")}>
              {update.isPending ? "Saving\u2026" : "Accept"}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={update.isPending || note.trim().length === 0} onClick={() => move("disputed")}>
              Dispute
            </Button>
          </div>
        </div>
      ) : null}
      {assignment.status === "accepted" || assignment.status === "in_progress" ? (
        <div className="flex flex-wrap gap-2">
          {assignment.status === "accepted" ? (
            <Button type="button" size="sm" variant="outline" disabled={update.isPending} onClick={() => move("in_progress")}>
              Start progress
            </Button>
          ) : null}
          <Button type="button" size="sm" variant="outline" disabled={update.isPending} onClick={() => move("completed")}>
            Mark completed
          </Button>
          <Link to={`/commitments/${assignment.commitmentId}`} className="self-center text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            View commitment trail
          </Link>
        </div>
      ) : null}
    </article>
  );
}

export default function AssignmentsRoute() {
  const { data, isLoading, error, refetch } = useActionQuery("list-my-assignments", {});

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold">My Assignments</h1>
        <p className="text-sm text-muted-foreground">
          Work explicitly assigned to you. Accept it yourself; nobody can acknowledge on your behalf.
        </p>
      </header>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {actionErrorMessage(error) ?? "Could not load your assignments."}
        </p>
      ) : isLoading || !data ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : data.assignments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing assigned to you. When a teammate assigns a confirmed commitment, it appears here.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {data.assignments.map((assignment) => (
            <AssignmentCard key={assignment.id} assignment={assignment as Assignment} onChanged={() => void refetch()} />
          ))}
        </div>
      )}
    </div>
  );
}
