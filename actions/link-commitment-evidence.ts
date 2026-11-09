import {
  defineAction,
  fail,
  type WriteReceipt,
} from "@agent-native/core/action";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import { invalidateAnalysisPublication } from "../server/lib/analysis-publication.js";
import { utcToday } from "../server/lib/commitment-ledger.js";
import {
  commitmentTrailResult,
  loadCommitmentTrail,
} from "../server/lib/commitment-trail.js";
import { verifyQuote } from "../server/lib/evidence.js";
import { loadLinkPair } from "../server/lib/link-context.js";
import {
  EVIDENCE_VERIFICATION_STATUSES,
  MAX_EVIDENCE_QUOTE_LENGTH,
} from "../shared/domain.js";

export default defineAction({
  description:
    "A person confirms that a statement in a later meeting refers to an existing commitment. The server checks the quotation against that meeting's stored transcript and attaches it as new evidence, whatever the result. Never changes the owner, due date or status. Repeating the same link is safe. Only usable from the signed-in app. Requires editor access.",
  schema: z
    .strictObject({
      commitmentId: z.string().min(1).describe("Existing commitment id"),
      meetingId: z
        .string()
        .min(1)
        .describe("A later meeting of the same project"),
      quote: z
        .string()
        .max(MAX_EVIDENCE_QUOTE_LENGTH)
        .refine((value) => value.trim().length > 0, "Must not be blank.")
        .describe("Exact words from that meeting's transcript"),
      start: z.number().int().min(0).optional().describe("Start offset"),
      end: z.number().int().min(1).optional().describe("End offset, exclusive"),
      duplicateCommitmentId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "A commitment that analysis of this meeting saved, to reject as a duplicate of the existing one",
        ),
      asOf: z.iso
        .date()
        .optional()
        .describe("Calendar date for the returned health, YYYY-MM-DD"),
    })
    .refine(
      ({ start, end }) =>
        (start === undefined) === (end === undefined) &&
        (start === undefined || start < end!),
      "Send both start and end, with start before end, or neither.",
    ),
  outputSchema: z.object({
    trail: commitmentTrailResult,
    replayed: z.boolean(),
    verificationStatus: z.enum(EVIDENCE_VERIFICATION_STATUSES),
    duplicateRejected: z.boolean(),
    _receipt: z.custom<WriteReceipt>(),
  }),
  // Enforced on the server: a request must come from this app's signed-in UI.
  uiOnly: true,
  agentTool: false,
  run: async (input, ctx) => {
    const actor = requireActor(ctx);
    const { commitmentId, meetingId, quote, start, end } = input;
    const { commitment, meeting } = await loadLinkPair(commitmentId, meetingId);
    const { projectId } = commitment;
    const db = getDb();

    if (meeting.transcript === null) {
      fail("This meeting has no transcript to check the quotation against.", {
        errorCode: "no_transcript",
        statusCode: 409,
      });
    }
    if (meeting.id === commitment.originMeetingId) {
      fail("This commitment was first recorded in that meeting.", {
        errorCode: "not_a_later_meeting",
        statusCode: 422,
      });
    }
    if (commitment.originMeetingId) {
      const [origin] = await db
        .select({ date: schema.meetings.meetingDate })
        .from(schema.meetings)
        .where(
          and(
            eq(schema.meetings.projectId, projectId),
            eq(schema.meetings.id, commitment.originMeetingId),
          ),
        )
        .limit(1);
      if (origin && meeting.meetingDate < origin.date) {
        fail("That meeting took place before this commitment was made.", {
          errorCode: "not_a_later_meeting",
          statusCode: 422,
        });
      }
    }

    let duplicate: typeof commitment | undefined;
    if (input.duplicateCommitmentId) {
      [duplicate] = await db
        .select()
        .from(schema.commitments)
        .where(
          and(
            eq(schema.commitments.projectId, projectId),
            eq(schema.commitments.id, input.duplicateCommitmentId),
          ),
        )
        .limit(1);
      if (
        !duplicate ||
        duplicate.id === commitmentId ||
        duplicate.originMeetingId !== meetingId
      ) {
        fail(
          "Only a commitment saved from this meeting can be its duplicate.",
          {
            errorCode: "invalid_duplicate",
            statusCode: 422,
          },
        );
      }
    }

    const verification = verifyQuote(meeting.transcript, quote, { start, end });
    const linkedAt = new Date();
    const evidenceLink = {
      meetingId,
      meetingTitle: meeting.title,
      meetingDate: meeting.meetingDate,
      quote,
      verificationStatus: verification.status,
    };
    const flag =
      verification.status === "verified"
        ? null
        : {
            code: "evidence" as const,
            message:
              verification.status === "missing"
                ? `A quotation linked from "${meeting.title}" was not found in that transcript.`
                : `A quotation linked from "${meeting.title}" occurs more than once in that transcript.`,
          };

    const outcome = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.commitmentEvidence)
        .values({
          projectId,
          commitmentId,
          meetingId,
          sourceQuote: quote,
          sourceStart: verification.sourceStart,
          sourceEnd: verification.sourceEnd,
          verificationStatus: verification.status,
          linkedBy: actor.email,
          linkedAt,
        })
        .onConflictDoNothing()
        .returning({ id: schema.commitmentEvidence.id });
      const isNew = inserted.length > 0;

      if (isNew) {
        const before: Record<string, unknown> = { evidenceLink: null };
        const after: Record<string, unknown> = {
          evidenceLink: { ...evidenceLink, evidenceId: inserted[0]!.id },
        };
        if (flag) {
          // Appended in one statement, so a concurrent review cannot be lost.
          const [row] = await tx
            .update(schema.commitments)
            .set({
              reviewFlags: sql`${schema.commitments.reviewFlags} || ${JSON.stringify([flag])}::jsonb`,
              reviewReason: sql`COALESCE(${schema.commitments.reviewReason} || ' ', '') || ${flag.message}`,
              needsReview: true,
              version: sql`${schema.commitments.version} + 1`,
            })
            .where(
              and(
                eq(schema.commitments.projectId, projectId),
                eq(schema.commitments.id, commitmentId),
                ne(schema.commitments.reviewState, "rejected"),
              ),
            )
            .returning({ flags: schema.commitments.reviewFlags });
          if (!row) {
            fail("This commitment was rejected. Restore it before linking.", {
              errorCode: "commitment_rejected",
              statusCode: 409,
            });
          }
          const codes = row.flags.map((f) => f.code);
          before.reviewFlags = codes.slice(0, -1);
          after.reviewFlags = codes;
        }
        await tx.insert(schema.changes).values({
          projectId,
          entityType: "commitment",
          entityId: commitmentId,
          actorType: actor.actorType,
          actorId: actor.email,
          operation: "update",
          beforeState: before,
          afterState: after,
        });
        const invalidated = await invalidateAnalysisPublication(
          tx,
          projectId,
          meetingId,
        );
        if (invalidated) {
          await tx.insert(schema.changes).values({
            projectId,
            entityType: "meeting",
            entityId: meetingId,
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
      }

      let duplicateRejected = false;
      if (duplicate) {
        const rejected = await tx
          .update(schema.commitments)
          .set({
            reviewState: "rejected",
            reviewedBy: actor.email,
            reviewedAt: linkedAt,
            needsReview: false,
            version: sql`${schema.commitments.version} + 1`,
          })
          .where(
            and(
              eq(schema.commitments.projectId, projectId),
              eq(schema.commitments.id, duplicate.id),
              ne(schema.commitments.reviewState, "rejected"),
            ),
          )
          .returning({ id: schema.commitments.id });
        if (rejected.length > 0) {
          duplicateRejected = true;
          await tx.insert(schema.changes).values({
            projectId,
            entityType: "commitment",
            entityId: duplicate.id,
            actorType: actor.actorType,
            actorId: actor.email,
            operation: "update",
            beforeState: { reviewState: duplicate.reviewState },
            afterState: {
              reviewState: "rejected",
              duplicateOf: commitment.description,
              duplicateOfId: commitmentId,
            },
          });
        }
      }
      return { isNew, duplicateRejected };
    });

    const [saved] = await db
      .select()
      .from(schema.commitments)
      .where(eq(schema.commitments.id, commitmentId))
      .limit(1);
    const trail = await loadCommitmentTrail(
      saved!,
      input.asOf ?? utcToday(),
      true,
    );
    const linked = trail.events.some(
      (event) =>
        event.meeting?.id === meetingId &&
        event.evidence.some((e) => e.sourceQuote === quote),
    );
    const _receipt: WriteReceipt = {
      changed: outcome.isNew || outcome.duplicateRejected,
      verified: linked,
      summary: outcome.isNew
        ? `Linked to "${meeting.title}"; quotation is ${verification.status}.`
        : "This link already exists. Nothing was added.",
    };
    return {
      trail,
      replayed: !outcome.isNew,
      verificationStatus: verification.status,
      duplicateRejected: outcome.duplicateRejected,
      _receipt,
    };
  },
});
