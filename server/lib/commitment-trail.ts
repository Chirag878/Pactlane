import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { EVIDENCE_VERIFICATION_STATUSES } from "../../shared/domain.js";
import { getDb, schema } from "../db/index.js";
import {
  describeChanges,
  historyFieldResult,
  loadCommitmentChanges,
  type HistoryEntry,
} from "./commitment-history.js";
import { ledgerEntryResult, loadLedgerEntries } from "./commitment-ledger.js";

const CHANGE_LIMIT = 500;

const trailEvidence = z.object({
  id: z.string(),
  sourceQuote: z.string(),
  sourceStart: z.number().nullable(),
  sourceEnd: z.number().nullable(),
  verificationStatus: z.enum(EVIDENCE_VERIFICATION_STATUSES),
  linkedBy: z.string().nullable(),
  linkedAt: z.string().nullable(),
});

export const TRAIL_EVENT_KINDS = [
  "origin",
  "mention",
  "edit",
  "review",
  "dismissal",
] as const;

export const trailEventResult = z.object({
  id: z.string(),
  kind: z.enum(TRAIL_EVENT_KINDS),
  occurredAt: z.string(),
  precision: z
    .enum(["date", "time"])
    .describe("Transcript events are known to the day, changes to the moment"),
  actorType: z.enum(["user", "agent", "system"]).nullable(),
  actorId: z.string().nullable(),
  meeting: z
    .object({ id: z.string(), title: z.string(), date: z.string() })
    .nullable(),
  evidence: z.array(trailEvidence),
  fields: z.array(historyFieldResult),
});

export const commitmentTrailResult = z.object({
  commitment: ledgerEntryResult,
  original: z
    .object({
      description: z.string().nullable(),
      owner: z.string().nullable(),
      statedOwnerName: z.string().nullable(),
      dueDate: z.string().nullable(),
      statedDueText: z.string().nullable(),
    })
    .nullable()
    .describe("Values first saved, from the audit record. Null if none exists"),
  asOf: z.string(),
  events: z.array(trailEventResult),
});

export type CommitmentTrail = z.infer<typeof commitmentTrailResult>;
type TrailEvent = z.infer<typeof trailEventResult>;
type Commitment = typeof schema.commitments.$inferSelect;

const midnightUtc = (date: string) => `${date}T00:00:00.000Z`;

const REVIEW_ONLY = new Set(["reviewState", "reviewFlags", "duplicateOf"]);

function changeEventKind(entry: HistoryEntry): TrailEvent["kind"] | null {
  const names = entry.fields.map((f) => f.field);
  if (entry.operation === "create") return null; // shown as the origin event
  if (names.includes("link")) return null; // shown as the mention event
  if (names.includes("dismissal")) return "dismissal";
  if (names.length > 0 && names.every((name) => REVIEW_ONLY.has(name))) {
    return "review";
  }
  return "edit";
}

const KIND_RANK: Record<TrailEvent["kind"], number> = {
  origin: 0,
  mention: 1,
  edit: 2,
  review: 2,
  dismissal: 2,
};

/** The origin comes first; then by time, with fixed tie-breaks so order is stable. */
export function sortTrailEvents(events: TrailEvent[]) {
  return [...events].sort((a, b) => {
    if ((a.kind === "origin") !== (b.kind === "origin")) {
      return a.kind === "origin" ? -1 : 1;
    }
    return (
      a.occurredAt.localeCompare(b.occurredAt) ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      a.id.localeCompare(b.id)
    );
  });
}

/** Call only after authorizing the caller against the commitment's project. */
export async function loadCommitmentTrail(
  commitment: Commitment,
  asOf: string,
  includeDraft = false,
  db: ReturnType<typeof getDb> = getDb(),
): Promise<CommitmentTrail> {
  const { projectId, id, originMeetingId } = commitment;
  const [{ entries }, evidence, meetings, changes] = await Promise.all([
    loadLedgerEntries(projectId, asOf, id, includeDraft, db),
    db
      .select()
      .from(schema.commitmentEvidence)
      .where(
        and(
          eq(schema.commitmentEvidence.projectId, projectId),
          eq(schema.commitmentEvidence.commitmentId, id),
        ),
      )
      .orderBy(
        asc(schema.commitmentEvidence.sourceStart),
        asc(schema.commitmentEvidence.id),
      ),
    db
      .select({
        id: schema.meetings.id,
        title: schema.meetings.title,
        date: schema.meetings.meetingDate,
        analysisPublicationState: schema.meetings.analysisPublicationState,
      })
      .from(schema.meetings)
      .where(eq(schema.meetings.projectId, projectId)),
    loadCommitmentChanges(projectId, id, CHANGE_LIMIT, includeDraft, db).then(
      (rows) =>
        describeChanges(projectId, rows, db).then((described) => ({
          rows,
          described,
        })),
    ),
  ]);

  const visibleMeetingIds = new Set(
    includeDraft
      ? meetings.map((meeting) => meeting.id)
      : meetings
          .filter((meeting) => meeting.analysisPublicationState !== "draft")
          .map((meeting) => meeting.id),
  );
  const meetingById = new Map(
    meetings
      .filter((meeting) => visibleMeetingIds.has(meeting.id))
      .map((m) => [m.id, m]),
  );
  const draftMeetingIds = new Set(
    meetings
      .filter((meeting) => meeting.analysisPublicationState === "draft")
      .map((meeting) => meeting.id),
  );
  const mentionsDraftMeeting = (state: Record<string, unknown> | null) => {
    const link = state?.evidenceLink ?? state?.dismissedLink;
    return (
      link !== null &&
      typeof link === "object" &&
      "meetingId" in link &&
      typeof link.meetingId === "string" &&
      draftMeetingIds.has(link.meetingId)
    );
  };
  const visibleChangeIds = new Set(
    changes.rows
      .filter(
        (row) =>
          includeDraft ||
          (!mentionsDraftMeeting(row.beforeState) &&
            !mentionsDraftMeeting(row.afterState)),
      )
      .map((row) => row.id),
  );
  const visibleChanges = {
    rows: changes.rows.filter((row) => visibleChangeIds.has(row.id)),
    described: changes.described.filter((entry) =>
      visibleChangeIds.has(entry.id),
    ),
  };
  const byMeeting = new Map<string, typeof evidence>();
  for (const row of evidence) {
    if (!visibleMeetingIds.has(row.meetingId)) continue;
    const list = byMeeting.get(row.meetingId) ?? [];
    list.push(row);
    byMeeting.set(row.meetingId, list);
  }
  const toEvidence = (row: (typeof evidence)[number]) => ({
    id: row.id,
    sourceQuote: row.sourceQuote,
    sourceStart: row.sourceStart,
    sourceEnd: row.sourceEnd,
    verificationStatus: row.verificationStatus,
    linkedBy: row.linkedBy,
    linkedAt: row.linkedAt ? row.linkedAt.toISOString() : null,
  });

  const created = visibleChanges.described.find(
    (e) => e.operation === "create",
  );
  const createdState = visibleChanges.rows.find(
    (r) => r.operation === "create",
  )?.afterState;
  const text = (key: string) =>
    typeof createdState?.[key] === "string" ? createdState[key] : null;
  const original = createdState
    ? {
        description: text("description"),
        owner:
          (created?.fields.find((f) => f.field === "owner")?.after as
            | string
            | null
            | undefined) ?? null,
        statedOwnerName: text("statedOwnerName"),
        dueDate: text("dueDate"),
        statedDueText: text("statedDueText"),
      }
    : null;

  const events: TrailEvent[] = [];
  const origin = originMeetingId ? meetingById.get(originMeetingId) : undefined;
  if (origin) {
    events.push({
      id: `origin-${id}`,
      kind: "origin",
      occurredAt: midnightUtc(origin.date),
      precision: "date",
      actorType: created?.actorType ?? null,
      actorId: created?.actorId ?? null,
      meeting: origin,
      evidence: (byMeeting.get(origin.id) ?? []).map(toEvidence),
      fields: [],
    });
  }

  // One event per meeting, so several quotes never read as several mentions.
  for (const [meetingId, rows] of byMeeting) {
    const meeting = meetingById.get(meetingId);
    if (!meeting || meetingId === originMeetingId) continue;
    const linked = rows.filter((row) => row.linkedBy !== null);
    if (linked.length === 0) continue;
    events.push({
      id: `mention-${meetingId}`,
      kind: "mention",
      occurredAt: midnightUtc(meeting.date),
      precision: "date",
      actorType: "user",
      actorId: linked[0]!.linkedBy,
      meeting,
      evidence: linked.map(toEvidence),
      fields: [],
    });
  }

  for (const entry of visibleChanges.described) {
    const kind = changeEventKind(entry);
    if (!kind) continue;
    events.push({
      id: entry.id,
      kind,
      occurredAt: entry.createdAt,
      precision: "time",
      actorType: entry.actorType,
      actorId: entry.actorId,
      meeting: null,
      evidence: [],
      fields: entry.fields,
    });
  }

  return {
    commitment: entries[0]!,
    original,
    asOf,
    events: sortTrailEvents(events),
  };
}
