import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../db/index.js";
import { viewerVisibleChange } from "./analysis-publication.js";

const fieldValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);

/** Fields a person can read in the history, in display order. */
export const HISTORY_FIELDS = [
  "description",
  "owner",
  "dueDate",
  "priority",
  "status",
  "reviewState",
  "reviewFlags",
  "link",
  "dismissal",
  "duplicateOf",
] as const;

export const historyFieldResult = z.object({
  field: z.enum(HISTORY_FIELDS),
  before: fieldValue,
  after: fieldValue,
});

export const historyEntryResult = z.object({
  id: z.string(),
  operation: z.enum(["create", "update", "delete"]),
  actorType: z.enum(["user", "agent", "system"]),
  actorId: z.string(),
  createdAt: z.string(),
  fields: z.array(historyFieldResult),
});

export type HistoryEntry = z.infer<typeof historyEntryResult>;
export type ChangeRow = typeof schema.changes.$inferSelect;
type Field = (typeof HISTORY_FIELDS)[number];
type State = Record<string, unknown> | null;

/** The state key that holds each field, where the two names differ. */
const STATE_KEYS: Partial<Record<Field, string[]>> = {
  owner: ["ownerId", "ownerName"],
  link: ["evidenceLink"],
  dismissal: ["dismissedLink"],
};

function asValue(raw: unknown): z.infer<typeof fieldValue> {
  if (typeof raw === "string" || typeof raw === "number") return raw;
  if (typeof raw === "boolean") return raw;
  if (Array.isArray(raw)) return raw.map(String);
  return null;
}

function meetingLabel(raw: unknown) {
  if (!raw || typeof raw !== "object") return null;
  const { meetingTitle, meetingDate } = raw as Record<string, unknown>;
  return typeof meetingTitle === "string"
    ? `${meetingTitle} (${String(meetingDate)})`
    : null;
}

/** All recorded changes to one commitment, oldest first. */
export async function loadCommitmentChanges(
  projectId: string,
  commitmentId: string,
  limit: number,
  includeDraft = true,
  db: ReturnType<typeof getDb> = getDb(),
) {
  return db
    .select()
    .from(schema.changes)
    .where(
      and(
        eq(schema.changes.projectId, projectId),
        eq(schema.changes.entityType, "commitment"),
        eq(schema.changes.entityId, commitmentId),
        includeDraft ? undefined : viewerVisibleChange(),
      ),
    )
    .orderBy(asc(schema.changes.createdAt), asc(schema.changes.id))
    .limit(limit);
}

/** Turns raw change rows into field-level entries, resolving owner names. */
export async function describeChanges(
  projectId: string,
  rows: ChangeRow[],
  db: ReturnType<typeof getDb> = getDb(),
): Promise<HistoryEntry[]> {
  // Records saved with the analysis carry only an owner id: resolve names here.
  const ownerIds = [
    ...new Set(
      rows.flatMap((row) =>
        [row.beforeState?.ownerId, row.afterState?.ownerId].filter(
          (v): v is string => typeof v === "string",
        ),
      ),
    ),
  ];
  const people = ownerIds.length
    ? await db
        .select({ id: schema.people.id, name: schema.people.displayName })
        .from(schema.people)
        .where(
          and(
            eq(schema.people.projectId, projectId),
            inArray(schema.people.id, ownerIds),
          ),
        )
    : [];
  const names = new Map(people.map((p) => [p.id, p.name]));

  const read = (state: State, field: Field) => {
    if (!state) return null;
    if (field === "owner") {
      if (typeof state.ownerName === "string") return state.ownerName;
      return typeof state.ownerId === "string"
        ? (names.get(state.ownerId) ?? null)
        : null;
    }
    if (field === "link") return meetingLabel(state.evidenceLink);
    if (field === "dismissal") return meetingLabel(state.dismissedLink);
    return asValue(state[field]);
  };
  const touched = (state: State, field: Field) =>
    state !== null &&
    (STATE_KEYS[field] ?? [field]).some((key) => key in state);

  return rows.map((row) => ({
    id: row.id,
    operation: row.operation,
    actorType: row.actorType,
    actorId: row.actorId,
    createdAt: row.createdAt.toISOString(),
    fields: HISTORY_FIELDS.filter(
      (field) =>
        touched(row.beforeState, field) || touched(row.afterState, field),
    ).map((field) => ({
      field,
      before: read(row.beforeState, field),
      after: read(row.afterState, field),
    })),
  }));
}
