import { defineAction, type WriteReceipt } from "@agent-native/core/action";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import { loadLinkPair } from "../server/lib/link-context.js";
import { MAX_EVIDENCE_QUOTE_LENGTH } from "../shared/domain.js";

export default defineAction({
  description:
    "A person rules out a suggested link between a statement in a meeting and a commitment, so it is not suggested again. Only usable from the signed-in app. Requires editor access.",
  schema: z.strictObject({
    commitmentId: z.string().min(1).describe("Commitment id"),
    meetingId: z.string().min(1).describe("Meeting id"),
    quote: z
      .string()
      .min(1)
      .max(MAX_EVIDENCE_QUOTE_LENGTH)
      .describe("The suggested statement, exactly as offered"),
  }),
  outputSchema: z.object({
    dismissed: z.boolean(),
    replayed: z.boolean(),
    _receipt: z.custom<WriteReceipt>(),
  }),
  // Enforced on the server: a request must come from this app's signed-in UI.
  uiOnly: true,
  agentTool: false,
  run: async ({ commitmentId, meetingId, quote }, ctx) => {
    const actor = requireActor(ctx);
    const { commitment, meeting } = await loadLinkPair(commitmentId, meetingId);

    const inserted = await getDb().transaction(async (tx) => {
      const rows = await tx
        .insert(schema.commitmentLinkDismissals)
        .values({
          projectId: commitment.projectId,
          commitmentId,
          meetingId,
          sourceQuote: quote,
          dismissedBy: actor.email,
        })
        .onConflictDoNothing()
        .returning({ id: schema.commitmentLinkDismissals.id });
      if (rows.length === 0) return false;
      await tx.insert(schema.changes).values({
        projectId: commitment.projectId,
        entityType: "commitment",
        entityId: commitmentId,
        actorType: actor.actorType,
        actorId: actor.email,
        operation: "update",
        beforeState: { dismissedLink: null },
        afterState: {
          dismissedLink: {
            meetingId,
            meetingTitle: meeting.title,
            meetingDate: meeting.meetingDate,
            quote,
          },
        },
      });
      return true;
    });

    const _receipt: WriteReceipt = {
      changed: inserted,
      verified: true,
      summary: inserted
        ? "Suggestion dismissed."
        : "This suggestion was already dismissed.",
    };
    return { dismissed: true, replayed: !inserted, _receipt };
  },
});
