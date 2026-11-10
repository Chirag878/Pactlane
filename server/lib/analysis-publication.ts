import { and, eq, sql } from "drizzle-orm";

import { getDb, schema } from "../db/index.js";
import { summarizeFlags } from "./analysis-review.js";

type Commitment = typeof schema.commitments.$inferSelect;

export interface LinkedEvidenceReviewSource {
  meetingId: string;
  meetingTitle: string;
  verificationStatus: string;
}

/** The persisted wording for a review flag created by a linked quotation. */
export function linkedEvidenceReviewFlag(source: LinkedEvidenceReviewSource) {
  if (
    source.verificationStatus !== "missing" &&
    source.verificationStatus !== "ambiguous"
  ) {
    return null;
  }
  return {
    code: "evidence" as const,
    message:
      source.verificationStatus === "missing"
        ? `A quotation linked from "${source.meetingTitle}" was not found in that transcript.`
        : `A quotation linked from "${source.meetingTitle}" occurs more than once in that transcript.`,
    sourceMeetingId: source.meetingId,
  };
}

/**
 * Removes review metadata caused only by meetings a viewer cannot inspect.
 * New flags carry a meeting id; exact legacy wording remains a safe fallback
 * for rows written before that provenance was stored.
 */
export function viewerVisibleCommitmentReview(
  commitment: Commitment,
  hiddenSources: LinkedEvidenceReviewSource[],
) {
  const hiddenMeetingIds = new Set(hiddenSources.map((row) => row.meetingId));
  const legacyMessages = new Set(
    hiddenSources.flatMap((source) => {
      const flag = linkedEvidenceReviewFlag(source);
      return flag ? [flag.message] : [];
    }),
  );
  const reviewFlags = commitment.reviewFlags.filter(
    (flag) =>
      !(
        flag.code === "evidence" &&
        ((flag.sourceMeetingId && hiddenMeetingIds.has(flag.sourceMeetingId)) ||
          (!flag.sourceMeetingId && legacyMessages.has(flag.message)))
      ),
  );
  return {
    reviewFlags,
    reviewReason: summarizeFlags(reviewFlags),
    needsReview:
      reviewFlags.length > 0 && commitment.reviewState !== "rejected",
  };
}

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
