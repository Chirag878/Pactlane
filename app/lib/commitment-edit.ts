import {
  COMMITMENT_TRANSITIONS,
  MAX_COMMITMENT_DESCRIPTION_LENGTH,
  type CommitmentStatus,
} from "../../shared/domain";

/** The editable part of a commitment, as the form holds it. Empty means none. */
export interface CommitmentDraft {
  description: string;
  ownerId: string;
  dueDate: string;
  priority: string;
  status: CommitmentStatus;
}

interface EditableCommitment {
  description: string;
  ownerId: string | null;
  dueDate: string | null;
  priority: string | null;
  status: CommitmentStatus;
}

export const STATUS_LABELS: Record<CommitmentStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const PRIORITY_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
} as const;

export function draftFromCommitment(c: EditableCommitment): CommitmentDraft {
  return {
    description: c.description,
    ownerId: c.ownerId ?? "",
    dueDate: c.dueDate ?? "",
    priority: c.priority ?? "",
    status: c.status,
  };
}

/** Statuses a person may pick: the current one plus the allowed moves. */
export function selectableStatuses(current: CommitmentStatus) {
  return [current, ...COMMITMENT_TRANSITIONS[current]];
}

export type PatchResult =
  | { ok: true; patch: Record<string, string | null>; changed: boolean }
  | { ok: false; field: "description" | "dueDate"; message: string };

/**
 * Compares the form with the saved commitment and returns only the fields that
 * differ. Nothing is sent for an untouched field, so a concurrent edit to it
 * is not overwritten by a stale form value.
 */
export function buildPatch(
  saved: EditableCommitment,
  draft: CommitmentDraft,
): PatchResult {
  const patch: Record<string, string | null> = {};
  const description = draft.description.trim();
  if (description.length === 0) {
    return { ok: false, field: "description", message: "Enter a description." };
  }
  if (description.length > MAX_COMMITMENT_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      field: "description",
      message: `Keep the description under ${MAX_COMMITMENT_DESCRIPTION_LENGTH} characters.`,
    };
  }
  if (description !== saved.description) patch.description = description;

  if (draft.dueDate !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(draft.dueDate)) {
    return {
      ok: false,
      field: "dueDate",
      message: "Enter the date as year, month and day.",
    };
  }
  if (draft.ownerId !== (saved.ownerId ?? "")) {
    patch.ownerId = draft.ownerId === "" ? null : draft.ownerId;
  }
  if (draft.dueDate !== (saved.dueDate ?? "")) {
    patch.dueDate = draft.dueDate === "" ? null : draft.dueDate;
  }
  if (draft.priority !== (saved.priority ?? "")) {
    patch.priority = draft.priority === "" ? null : draft.priority;
  }
  if (draft.status !== saved.status) patch.status = draft.status;

  return { ok: true, patch, changed: Object.keys(patch).length > 0 };
}

export type FailureKind = "conflict" | "denied" | "invalid" | "other";

const MESSAGES: Record<string, { kind: FailureKind; message: string }> = {
  version_conflict: {
    kind: "conflict",
    message:
      "Someone else changed this commitment while you were editing. Load the latest version, then apply your change again.",
  },
  access_denied: {
    kind: "denied",
    message: "You do not have permission to change this project.",
  },
  not_authenticated: {
    kind: "denied",
    message: "Sign in again to continue.",
  },
  human_review_required: {
    kind: "denied",
    message: "Only a person can review a commitment.",
  },
  commitment_rejected: {
    kind: "invalid",
    message: "This commitment was rejected. Restore it before changing it.",
  },
};

/** Turns an action failure into text a person can act on, and says what kind it was. */
export function describeFailure(error: unknown): {
  kind: FailureKind;
  message: string;
} {
  const code = (error as { errorCode?: unknown } | null)?.errorCode;
  const server = (error as { actionMessage?: unknown } | null)?.actionMessage;
  const known = typeof code === "string" ? MESSAGES[code] : undefined;
  if (known) return known;
  if (typeof server === "string" && server.length > 0) {
    return { kind: "invalid", message: server };
  }
  return {
    kind: "other",
    message: "Could not save. Check your connection and try again.",
  };
}

/** Matches a stated name to a participant by name or alias, as the server does. */
export function findParticipant(
  name: string | null,
  people: { id: string; displayName: string; aliases: string[] }[],
) {
  if (!name) return [];
  const key = name.trim().toLowerCase();
  return people.filter((person) =>
    [person.displayName, ...person.aliases].some(
      (candidate) => candidate.trim().toLowerCase() === key,
    ),
  );
}
