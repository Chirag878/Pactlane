import {
  defineAction,
  fail,
  type WriteReceipt,
} from "@agent-native/core/action";
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeMeeting,
  projectAccessExists,
  requireActor,
} from "../server/lib/action-context.js";
import {
  loadMeetingResult,
  meetingResultSchema,
} from "../server/lib/meeting-results.js";

export default defineAction({
  description:
    "Publish a reviewed meeting analysis for project viewers. This is a human UI-only approval: it records the authenticated editor and time, but never confirms individual commitments or changes evidence verification. Repeating publication is safe.",
  schema: z.strictObject({
    meetingId: z
      .string()
      .min(1)
      .describe("Meeting whose draft analysis is ready to publish"),
    expectedContentRevision: z
      .number()
      .int()
      .min(0)
      .describe("The analysis content revision the person reviewed"),
  }),
  outputSchema: meetingResultSchema.extend({
    changed: z.boolean(),
    _receipt: z.custom<WriteReceipt>(),
  }),
  uiOnly: true,
  agentTool: false,
  run: async ({ meetingId, expectedContentRevision }, ctx) => {
    const actor = requireActor(ctx);
    if (actor.actorType !== "user") {
      fail("Only a signed-in person can publish a meeting analysis.", {
        errorCode: "human_review_required",
        statusCode: 403,
      });
    }
    const publishedAt = new Date();
    const outcome = await getDb().transaction(async (tx) => {
      const meeting = await authorizeMeeting(meetingId, "editor");
      const published = await tx
        .update(schema.meetings)
        .set({
          analysisPublicationState: "published",
          analysisPublishedBy: actor.email,
          analysisPublishedAt: publishedAt,
          analysisPublishedRevision: expectedContentRevision,
        })
        .where(
          and(
            eq(schema.meetings.id, meeting.id),
            eq(schema.meetings.projectId, meeting.projectId),
            eq(schema.meetings.analysisPublicationState, "draft"),
            eq(
              schema.meetings.analysisContentRevision,
              expectedContentRevision,
            ),
            isNotNull(schema.meetings.analysisHash),
            projectAccessExists(meeting.projectId, "editor"),
          ),
        )
        .returning({ id: schema.meetings.id });
      let changed = published.length > 0;
      if (published.length === 0) {
        // Re-check through the transaction after the guarded mutation. A
        // revoked editor receives access_denied rather than a state conflict.
        const current = await authorizeMeeting(meetingId, "editor");
        if (!current.analysisHash) {
          fail("Analyze this meeting before publishing it.", {
            errorCode: "analysis_not_saved",
            statusCode: 409,
          });
        }
        if (current.analysisContentRevision !== expectedContentRevision) {
          fail(
            "This analysis changed after you reviewed it. Review the latest draft before publishing.",
            {
              errorCode: "analysis_revision_conflict",
              statusCode: 409,
              details: {
                currentContentRevision: current.analysisContentRevision,
              },
            },
          );
        }
        if (
          current.analysisPublicationState === "published" &&
          current.analysisPublishedRevision === expectedContentRevision
        ) {
          changed = false;
        } else {
          fail("This analysis cannot be published from its current state.", {
            errorCode: "analysis_publication_conflict",
            statusCode: 409,
          });
        }
      }
      if (changed) {
        await tx.insert(schema.changes).values({
          projectId: meeting.projectId,
          entityType: "meeting",
          entityId: meeting.id,
          actorType: "user",
          actorId: actor.email,
          operation: "update",
          beforeState: {
            analysisPublicationState: "draft",
            analysisContentRevision: expectedContentRevision,
          },
          afterState: {
            analysisPublicationState: "published",
            analysisContentRevision: expectedContentRevision,
            analysisPublishedRevision: expectedContentRevision,
            analysisPublishedBy: actor.email,
            analysisPublishedAt: publishedAt.toISOString(),
          },
        });
      }
      const latest = await authorizeMeeting(meetingId, "editor");
      return {
        changed,
        result: await loadMeetingResult(
          latest,
          { includeDraft: true, canPublish: true },
          tx,
        ),
      };
    });

    const { changed, result } = outcome;
    const _receipt: WriteReceipt = {
      changed,
      verified:
        result.analysisPublicationState === "published" &&
        result.analysisPublishedRevision === expectedContentRevision &&
        (changed
          ? result.analysisPublishedBy === actor.email &&
            result.analysisPublishedAt !== null
          : true),
      summary: changed
        ? "Meeting analysis published for project viewers."
        : "This meeting analysis is already published. Nothing changed.",
    };
    return { ...result, changed, _receipt };
  },
});
