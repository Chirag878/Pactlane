import { defineAction, type WriteReceipt } from "@agent-native/core/action";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeProject,
  projectAccessWhere,
  requireActor,
} from "../server/lib/action-context.js";
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

    const inserted = await getDb().transaction(async (tx) => {
      const { commitment, meeting } = await loadLinkPair(
        commitmentId,
        meetingId,
      );
      const dismissalId = crypto.randomUUID();
      const rows = await tx
        .insert(schema.commitmentLinkDismissals)
        .select(
          tx
            .select({
              id: sql<string>`${dismissalId}`.as("id"),
              projectId: sql<string>`${schema.projects.id}`.as("project_id"),
              commitmentId: sql<string>`${commitmentId}`.as("commitment_id"),
              meetingId: sql<string>`${meetingId}`.as("meeting_id"),
              sourceQuote: sql<string>`${quote}`.as("source_quote"),
              dismissedBy: sql<string>`${actor.email}`.as("dismissed_by"),
              createdAt: sql<Date>`now()`.as("created_at"),
            })
            .from(schema.projects)
            .where(projectAccessWhere(commitment.projectId, "editor")),
        )
        .onConflictDoNothing()
        .returning({ id: schema.commitmentLinkDismissals.id });
      if (rows.length === 0) {
        await authorizeProject(commitment.projectId, "editor");
        return false;
      }
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
