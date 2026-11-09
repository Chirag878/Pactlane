import { and, eq, sql } from "drizzle-orm";

import { getDb, schema } from "../db/index.js";

/**
 * A commitment is private while its originating analysis is a draft. This is
 * used by read actions in addition to the normal project access check.
 */
export async function commitmentIsPublished(
  commitment: typeof schema.commitments.$inferSelect,
  db: ReturnType<typeof getDb> = getDb(),
) {
  if (!commitment.originMeetingId) return true;
  const [origin] = await db
    .select({ state: schema.meetings.analysisPublicationState })
    .from(schema.meetings)
    .where(
      and(
        eq(schema.meetings.projectId, commitment.projectId),
        eq(schema.meetings.id, commitment.originMeetingId),
      ),
    )
    .limit(1);
  return origin?.state !== "draft";
}

/**
 * Excludes audit events whose link or dismissal refers to a draft meeting.
 * Keeping this predicate in SQL means pagination is applied after redaction.
 */
export function viewerVisibleChange() {
  return sql<boolean>`NOT EXISTS (
    SELECT 1
    FROM ${schema.meetings}
    WHERE ${schema.meetings.projectId} = ${schema.changes.projectId}
      AND ${schema.meetings.analysisPublicationState} = 'draft'
      AND ${schema.meetings.id} IN (
        ${schema.changes.beforeState}->'evidenceLink'->>'meetingId',
        ${schema.changes.beforeState}->'dismissedLink'->>'meetingId',
        ${schema.changes.afterState}->'evidenceLink'->>'meetingId',
        ${schema.changes.afterState}->'dismissedLink'->>'meetingId'
      )
  )`;
}

/**
 * A material commitment change invalidates every approval of its source
 * analysis, even when that analysis is already a draft. Locking and bumping
 * the revision in the writer's transaction makes a concurrent or delayed
 * publication request fail closed.
 */
export async function invalidateAnalysisPublication(
  tx: ReturnType<typeof getDb>,
  projectId: string,
  meetingId: string | null,
) {
  if (!meetingId) return null;
  const [current] = await tx
    .select({
      analysisHash: schema.meetings.analysisHash,
      state: schema.meetings.analysisPublicationState,
      contentRevision: schema.meetings.analysisContentRevision,
    })
    .from(schema.meetings)
    .where(
      and(
        eq(schema.meetings.projectId, projectId),
        eq(schema.meetings.id, meetingId),
      ),
    )
    .for("update")
    .limit(1);
  if (!current?.analysisHash) return null;

  const contentRevision = current.contentRevision + 1;
  const [invalidated] = await tx
    .update(schema.meetings)
    .set({
      analysisPublicationState: "draft",
      analysisContentRevision: contentRevision,
      analysisPublishedBy: null,
      analysisPublishedAt: null,
      analysisPublishedRevision: null,
    })
    .where(
      and(
        eq(schema.meetings.projectId, projectId),
        eq(schema.meetings.id, meetingId),
        eq(schema.meetings.analysisContentRevision, current.contentRevision),
      ),
    )
    .returning({ id: schema.meetings.id });
  if (!invalidated) {
    throw new Error(
      "Analysis revision changed while its publication was being invalidated.",
    );
  }
  return {
    previousState: current.state,
    previousRevision: current.contentRevision,
    contentRevision,
  };
}
