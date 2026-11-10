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

const STATUS_LABELS = {
  pending: "Awaiting acknowledgement",
  accepted: "Accepted",
  disputed: "Disputed",
  in_progress: "In progress",
  completed: "Completed",
} as const;

/**
 * Human handoff for one confirmed commitment. Only editors of an
 * organization project ever see this: personal projects and viewers get
 * nothing, and the agent can never send an assignment from here.
 */
export function AssignmentHandoff({
  commitmentId,
  reviewState,
  projectId,
}: {
  commitmentId: string;
  reviewState: string;
  projectId: string;
}) {
  const [recipient, setRecipient] = useState("");
  const options = useActionQuery(
    "get-assignment-options",
    { commitmentId },
    { enabled: reviewState === "confirmed" },
  );
  const send = useActionMutation("send-assignment", {
    uiOnly: true,
    onSuccess: (result) => {
      setRecipient("");
      void options.refetch();
      toast.success(`Assigned to ${result.assignment.recipientEmail}.`);
    },
    onError: (error) =>
      toast.error(actionErrorMessage(error) ?? "Could not send the assignment."),
  });

  if (reviewState !== "confirmed") return null;
  if (options.isLoading) {
    return (
      <p className="text-sm text-muted-foreground">Checking assignment options…</p>
    );
  }
  if (options.error || !options.data) {
    const code = (options.error as { errorCode?: string } | null)?.errorCode;
    // Personal projects, viewers and outsiders simply have no handoff here.
    if (code === "organization_project_required" || code === "access_denied") return null;
    return (
      <p role="alert" className="text-sm text-destructive">
        {actionErrorMessage(options.error) ?? "Could not load assignment options."}
      </p>
    );
  }

  const { members, activeAssignment, readiness } = options.data;

  if (activeAssignment) {
    return (
      <div className="flex flex-col gap-1.5 rounded-lg border p-3">
        <p className="text-sm">
          <span className="font-medium">Assigned to {activeAssignment.recipientEmail}</span>{" "}
          <Badge variant="outline">{STATUS_LABELS[activeAssignment.status]}</Badge>
        </p>
        <p className="text-xs text-muted-foreground">
          Sent by {activeAssignment.assignedBy} · {new Date(activeAssignment.assignedAt).toLocaleDateString()}
        </p>
        <Link to="/assignments" className="self-start text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          Open My Assignments
        </Link>
      </div>
    );
  }

  if (!readiness.published) {
    return (
      <p className="text-sm text-muted-foreground">
        Publish this meeting’s analysis before assigning the commitment.
      </p>
    );
  }

  const eligible = members.filter((member) => member.hasAccount && member.hasProjectAccess);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!recipient || send.isPending) return;
    send.mutate({ commitmentId, recipientEmail: recipient });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">Assign this commitment</p>
        <p className="text-xs text-muted-foreground">
          Only an organization member you choose receives it. They accept or dispute it themselves; nothing is inferred from names.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`assign-${commitmentId}`}>Recipient</Label>
        <select
          id={`assign-${commitmentId}`}
          value={recipient}
          disabled={send.isPending || eligible.length === 0}
          onChange={(event) => setRecipient(event.target.value)}
          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          <option value="">Choose a team member</option>
          {members.map((member) => {
            const disabled = !member.hasAccount || !member.hasProjectAccess;
            const reason = !member.hasAccount
              ? "needs a verified account"
              : !member.hasProjectAccess
                ? "needs project access"
                : member.role;
            return (
              <option key={member.email} value={member.email} disabled={disabled}>
                {member.email} · {reason}
              </option>
            );
          })}
        </select>
        {eligible.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nobody can receive this yet. Give a member{" "}
            <Link to={`/projects/${projectId}`} className="underline-offset-2 hover:underline">project access</Link>{" "}
            and make sure they have a verified account.
          </p>
        ) : null}
      </div>
      <Button type="submit" size="sm" className="self-start" disabled={send.isPending || recipient.length === 0}>
        {send.isPending ? "Sending\u2026" : "Send assignment"}
      </Button>
    </form>
  );
}
