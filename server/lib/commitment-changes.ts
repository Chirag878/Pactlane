import { fail } from "@agent-native/core/action";
import { and, eq, sql } from "drizzle-orm";

import type { ReviewFlag, ReviewState } from "../../shared/domain.js";
import { getDb, schema } from "../db/index.js";
import {
  authorizeProject,
  projectAccessExists,
  type Actor,
} from "./action-context.js";
import { invalidateAnalysisPublication } from "./analysis-publication.js";
import { summarizeFlags } from "./analysis-review.js";
import { loadCommitmentResult } from "./meeting-results.js";

export type Commitment = typeof schema.commitments.$inferSelect;

/** What a change may write. Version, audit and review summary are derived. */
export type CommitmentPatch = Partial<
  Pick<
    Commitment,
    | "description"
    | "ownerId"
    | "dueDate"
    | "priority"
    | "status"
    | "completedAt"
    | "reviewFlags"
    | "reviewState"
    | "reviewedBy"
    | "reviewedAt"
  >
>;

/** `needsReview` follows the open flags. A rejected commitment is no longer pending. */
export function reviewSummary(flags: ReviewFlag[], state: ReviewState) {
  return {
    reviewFlags: flags,
    needsReview: flags.length > 0 && state !== "rejected",
    reviewReason: summarizeFlags(flags),
  };
}

export async function failWithConflict(current: Commitment): Promise<never> {
  return fail(
    "This commitment was changed by someone else after you opened it. Review the current version and try again.",
    {
      errorCode: "version_conflict",
      statusCode: 409,
      details: { current: await loadCommitmentResult(current) },
    },
  );
}

/**
 * Writes a patch only if the commitment is still at the version the caller
 * read, and records the change in the same transaction. Evidence rows are never
 * touched. The audit states hold only the fields that changed.
 */
export async function saveCommitmentChange(options: {
  actor: Actor;
  current: Commitment;
  expectedVersion: number;
  patch: CommitmentPatch;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}): Promise<Commitment> {
  const { actor, current, expectedVersion, patch, before, after } = options;
  const flags = patch.reviewFlags ?? current.reviewFlags;
  const state = patch.reviewState ?? current.reviewState;

  const updated = await getDb().transaction(async (tx) => {
    const [row] = await tx
      .update(schema.commitments)
      .set({
        ...patch,
        ...reviewSummary(flags, state),
        version: sql`${schema.commitments.version} + 1`,
      })
      .where(
        and(
          eq(schema.commitments.id, current.id),
          eq(schema.commitments.projectId, current.projectId),
          eq(schema.commitments.version, expectedVersion),
          projectAccessExists(current.projectId, "editor"),
        ),
      )
      .returning();
    if (!row) {
      // Distinguish a stale value from permission revoked after the row was
      // first read. This check is bound to the active transaction.
      await authorizeProject(current.projectId, "editor");
      return null;
    }
    await tx.insert(schema.changes).values({
      projectId: current.projectId,
      entityType: "commitment",
      entityId: current.id,
      actorType: actor.actorType,
      actorId: actor.email,
      operation: "update",
      beforeState: before,
      afterState: after,
    });
    const invalidated = await invalidateAnalysisPublication(
      tx,
      current.projectId,
      current.originMeetingId,
    );
    if (invalidated) {
      await tx.insert(schema.changes).values({
        projectId: current.projectId,
        entityType: "meeting",
        entityId: current.originMeetingId!,
        actorType: actor.actorType,
        actorId: actor.email,
        operation: "update",
        beforeState: {
          analysisPublicationState: invalidated.previousState,
          analysisContentRevision: invalidated.previousRevision,
        },
        afterState: {
          analysisPublicationState: "draft",
          analysisContentRevision: invalidated.contentRevision,
        },
      });
    }
    return row;
  });

  if (!updated) {
    const [latest] = await getDb()
      .select()
      .from(schema.commitments)
      .where(eq(schema.commitments.id, current.id))
      .limit(1);
    return failWithConflict(latest ?? current);
  }
  return updated;
}
