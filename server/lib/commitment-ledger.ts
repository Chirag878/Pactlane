import { and, desc, eq, getTableColumns, isNull, max, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";

import {
  COMMITMENT_PRIORITIES,
  COMMITMENT_STATUSES,
  REVIEW_STATES,
} from "../../shared/domain.js";
import { getDb, schema } from "../db/index.js";
import { viewerVisibleChange } from "./analysis-publication.js";
import {
  commitmentHealth,
  commitmentHealthResult,
} from "./commitment-health.js";

export const LEDGER_LIMIT = 500;

/** The calendar date used when a caller does not say which day "today" is. */
export const utcToday = () => new Date().toISOString().slice(0, 10);

const meetingRef = z.object({
  id: z.string(),
  title: z.string(),
  date: z.string(),
});

export const ledgerEntryResult = z.object({
  id: z.string(),
  projectId: z.string(),
  description: z.string(),
  originMeeting: meetingRef.nullable(),
  ownerId: z.string().nullable(),
  ownerDisplayName: z.string().nullable(),
  statedOwnerName: z.string().nullable(),
  dueDate: z.string().nullable(),
  statedDueText: z.string().nullable(),
  priority: z.enum(COMMITMENT_PRIORITIES).nullable(),
  status: z.enum(COMMITMENT_STATUSES),
  reviewState: z.enum(REVIEW_STATES),
  evidence: z.object({
    total: z.number(),
    verified: z.number(),
    notVerified: z.number(),
  }),
  meetings: z.array(
    meetingRef.extend({
      verified: z
        .boolean()
        .describe("At least one quotation from it is verified"),
    }),
  ),
  lastUpdatedAt: z.string(),
  health: commitmentHealthResult,
});

export type LedgerEntry = z.infer<typeof ledgerEntryResult>;

/**
 * Reads a fixed number of queries however many commitments exist. Every query
 * is scoped to the project, which the caller must have authorized.
 */
export async function loadLedgerEntries(
  projectId: string,
  asOf: string,
  commitmentId?: string,
  includeDraft = false,
  db: ReturnType<typeof getDb> = getDb(),
): Promise<{ entries: LedgerEntry[]; truncated: boolean }> {
  const inProject = eq(schema.commitments.projectId, projectId);
  const originMeeting = alias(schema.meetings, "ledger_origin_meeting");
  const commitmentScope = and(
    commitmentId
      ? and(inProject, eq(schema.commitments.id, commitmentId))
      : inProject,
    includeDraft
      ? undefined
      : or(
          isNull(schema.commitments.originMeetingId),
          eq(originMeeting.analysisPublicationState, "published"),
        ),
  );
  const evidenceScope = commitmentId
    ? and(
        eq(schema.commitmentEvidence.projectId, projectId),
        eq(schema.commitmentEvidence.commitmentId, commitmentId),
      )
    : eq(schema.commitmentEvidence.projectId, projectId);

  const [commitments, evidence, meetings, people, latestChanges] =
    await Promise.all([
      db
        .select(getTableColumns(schema.commitments))
        .from(schema.commitments)
        .leftJoin(
          originMeeting,
          and(
            eq(originMeeting.projectId, schema.commitments.projectId),
            eq(originMeeting.id, schema.commitments.originMeetingId),
          ),
        )
        .where(commitmentScope)
        .orderBy(
          desc(schema.commitments.createdAt),
          desc(schema.commitments.id),
        )
        .limit(LEDGER_LIMIT + 1),
      db
        .select({
          commitmentId: schema.commitmentEvidence.commitmentId,
          meetingId: schema.commitmentEvidence.meetingId,
          verificationStatus: schema.commitmentEvidence.verificationStatus,
          linkedBy: schema.commitmentEvidence.linkedBy,
        })
        .from(schema.commitmentEvidence)
        .where(evidenceScope),
      db
        .select({
          id: schema.meetings.id,
          title: schema.meetings.title,
          date: schema.meetings.meetingDate,
          analysisPublicationState: schema.meetings.analysisPublicationState,
        })
        .from(schema.meetings)
        .where(eq(schema.meetings.projectId, projectId)),
      db
        .select({ id: schema.people.id, name: schema.people.displayName })
        .from(schema.people)
        .where(eq(schema.people.projectId, projectId)),
      db
        .select({
          entityId: schema.changes.entityId,
          at: max(schema.changes.createdAt),
        })
        .from(schema.changes)
        .where(
          and(
            eq(schema.changes.projectId, projectId),
            eq(schema.changes.entityType, "commitment"),
            includeDraft ? undefined : viewerVisibleChange(),
          ),
        )
        .groupBy(schema.changes.entityId),
    ]);

  const meetingById = new Map(meetings.map((m) => [m.id, m]));
  const visibleMeetingIds = new Set(
    includeDraft
      ? meetings.map((meeting) => meeting.id)
      : meetings
          .filter((meeting) => meeting.analysisPublicationState !== "draft")
          .map((meeting) => meeting.id),
  );
  const visibleCommitments = commitments;
  const visibleEvidence = evidence.filter((row) =>
    visibleMeetingIds.has(row.meetingId),
  );
  const meetingDates = new Map(
    meetings
      .filter((meeting) => visibleMeetingIds.has(meeting.id))
      .map((m) => [m.id, m.date]),
  );
  const ownerNames = new Map(people.map((p) => [p.id, p.name]));
  const lastChange = new Map(latestChanges.map((c) => [c.entityId, c.at]));
  const evidenceByCommitment = new Map<string, typeof evidence>();
  for (const row of visibleEvidence) {
    const list = evidenceByCommitment.get(row.commitmentId) ?? [];
    list.push(row);
    evidenceByCommitment.set(row.commitmentId, list);
  }

  const entries = visibleCommitments
    .slice(0, LEDGER_LIMIT)
    .map((c): LedgerEntry => {
      const rows = evidenceByCommitment.get(c.id) ?? [];
      const health = commitmentHealth(
        {
          status: c.status,
          dueDate: c.dueDate,
          reviewState: c.reviewState,
          needsReview: c.needsReview,
          reviewFlags: c.reviewFlags,
          originMeetingId: c.originMeetingId,
          evidence: rows,
        },
        meetingDates,
        asOf,
      );
      const verifiedMeetings = new Set(
        rows
          .filter((r) => r.verificationStatus === "verified")
          .map((r) => r.meetingId),
      );
      const relatedIds = new Set(rows.map((r) => r.meetingId));
      if (c.originMeetingId) relatedIds.add(c.originMeetingId);
      const related = [...relatedIds]
        .flatMap((id) => {
          const meeting = meetingById.get(id);
          return meeting
            ? [{ ...meeting, verified: verifiedMeetings.has(id) }]
            : [];
        })
        .sort(
          (a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id),
        );
      const verified = rows.filter(
        (r) => r.verificationStatus === "verified",
      ).length;
      const origin = c.originMeetingId
        ? meetingById.get(c.originMeetingId)
        : undefined;

      return {
        id: c.id,
        projectId: c.projectId,
        description: c.description,
        originMeeting: origin ?? null,
        ownerId: c.ownerId,
        ownerDisplayName: c.ownerId
          ? (ownerNames.get(c.ownerId) ?? null)
          : null,
        statedOwnerName: c.statedOwnerName,
        dueDate: c.dueDate,
        statedDueText: c.statedDueText,
        priority: c.priority,
        status: c.status,
        reviewState: c.reviewState,
        evidence: {
          total: rows.length,
          verified,
          notVerified: rows.length - verified,
        },
        meetings: related,
        lastUpdatedAt: new Date(
          lastChange.get(c.id) ?? c.updatedAt,
        ).toISOString(),
        health,
      };
    });

  entries.sort(
    (a, b) =>
      b.lastUpdatedAt.localeCompare(a.lastUpdatedAt) ||
      a.id.localeCompare(b.id),
  );
  return { entries, truncated: visibleCommitments.length > LEDGER_LIMIT };
}
