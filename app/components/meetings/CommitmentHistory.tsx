import {
  actionErrorMessage,
  useActionQuery,
} from "@agent-native/core/client/hooks";
import { useState } from "react";

import { STATUS_LABELS } from "@/lib/commitment-edit";

export const FIELD_LABELS: Record<string, string> = {
  description: "Description",
  owner: "Owner",
  dueDate: "Due date",
  priority: "Priority",
  status: "Status",
  reviewState: "Review",
  reviewFlags: "Open review flags",
  link: "Linked meeting",
  dismissal: "Ruled out for meeting",
  duplicateOf: "Duplicate of",
};

export function formatHistoryValue(field: string, value: unknown) {
  if (value === null || value === undefined) return "none";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "none";
  if (field === "status") {
    return STATUS_LABELS[value as keyof typeof STATUS_LABELS] ?? String(value);
  }
  return String(value);
}

function actorLabel(actorType: string, actorId: string) {
  if (actorType === "agent") return `AI agent, for ${actorId}`;
  if (actorType === "system") return "Pactlane";
  return actorId;
}

function HistoryEntries({ commitmentId }: { commitmentId: string }) {
  const { data, isLoading, error } = useActionQuery("get-commitment-history", {
    id: commitmentId,
  });
  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {actionErrorMessage(error) ?? "Could not load the history."}
      </p>
    );
  }
  if (isLoading || !data) {
    return <p className="text-sm text-muted-foreground">Loading history…</p>;
  }
  return (
    <ol className="flex flex-col gap-3">
      {data.entries.map((entry) => (
        <li key={entry.id} className="flex flex-col gap-1 text-sm">
          <p>
            <span className="font-medium">
              {actorLabel(entry.actorType, entry.actorId)}
            </span>{" "}
            <span className="text-muted-foreground">
              {entry.operation === "create"
                ? "saved this from analysis"
                : "changed this"}
              {" · "}
              <time dateTime={entry.createdAt}>
                {new Date(entry.createdAt).toLocaleString()}
              </time>
            </span>
          </p>
          <ul className="flex flex-col gap-0.5 text-muted-foreground">
            {entry.fields
              .filter((f) => entry.operation !== "create" || f.after !== null)
              .map((f) => (
                <li key={f.field}>
                  {FIELD_LABELS[f.field] ?? f.field}:{" "}
                  {entry.operation === "create" ? null : (
                    <>
                      <span>{formatHistoryValue(f.field, f.before)}</span>
                      {" → "}
                    </>
                  )}
                  <span className="text-foreground">
                    {formatHistoryValue(f.field, f.after)}
                  </span>
                </li>
              ))}
          </ul>
        </li>
      ))}
      {data.truncated ? (
        <li className="text-sm text-muted-foreground">
          Older changes are not shown.
        </li>
      ) : null}
    </ol>
  );
}

/** Loads the history only once the section is opened. */
export function CommitmentHistory({ commitmentId }: { commitmentId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
        History
      </summary>
      <div className="mt-2">
        {open ? <HistoryEntries commitmentId={commitmentId} /> : null}
      </div>
    </details>
  );
}
