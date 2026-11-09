import { defineAction, fail } from "@agent-native/core/action";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeCommitment,
  authorizeProject,
  requireActor,
} from "../server/lib/action-context.js";
import {
  commitmentIsPublished,
  viewerVisibleChange,
} from "../server/lib/analysis-publication.js";
import {
  describeChanges,
  historyEntryResult,
} from "../server/lib/commitment-history.js";

const HISTORY_LIMIT = 100;

export default defineAction({
  description:
    "Read the history of a commitment, newest first: who changed which field from what to what, and when. Includes the original AI-saved values. Requires viewer access.",
  schema: z.strictObject({
    id: z.string().min(1).describe("Commitment id"),
  }),
  http: { method: "GET" },
  outputSchema: z.object({
    entries: z.array(historyEntryResult),
    truncated: z.boolean(),
  }),
  run: async ({ id }, ctx) => {
    requireActor(ctx);
    const commitment = await authorizeCommitment(id, "viewer");
    const access = await authorizeProject(commitment.projectId, "viewer");
    const includeDraft = access.role !== "viewer";
    return getDb().transaction(
      async (tx) => {
        const [snapshotCommitment] = await tx
          .select()
          .from(schema.commitments)
          .where(
            and(
              eq(schema.commitments.id, commitment.id),
              eq(schema.commitments.projectId, commitment.projectId),
            ),
          )
          .limit(1);
        if (
          !snapshotCommitment ||
          (!includeDraft &&
            !(await commitmentIsPublished(snapshotCommitment, tx)))
        ) {
          fail(
            "This project does not exist or you do not have the required access.",
            {
              errorCode: "access_denied",
              statusCode: 403,
            },
          );
        }
        const rows = await tx
          .select()
          .from(schema.changes)
          .where(
            and(
              eq(schema.changes.projectId, commitment.projectId),
              eq(schema.changes.entityType, "commitment"),
              eq(schema.changes.entityId, id),
              includeDraft ? undefined : viewerVisibleChange(),
            ),
          )
          .orderBy(desc(schema.changes.createdAt), desc(schema.changes.id))
          .limit(HISTORY_LIMIT + 1);

        return {
          truncated: rows.length > HISTORY_LIMIT,
          entries: await describeChanges(
            commitment.projectId,
            rows.slice(0, HISTORY_LIMIT),
            tx,
          ),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  },
});
