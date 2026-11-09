import { defineAction } from "@agent-native/core/action";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeCommitment,
  requireActor,
} from "../server/lib/action-context.js";
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
    const rows = await getDb()
      .select()
      .from(schema.changes)
      .where(
        and(
          eq(schema.changes.projectId, commitment.projectId),
          eq(schema.changes.entityType, "commitment"),
          eq(schema.changes.entityId, id),
        ),
      )
      .orderBy(desc(schema.changes.createdAt), desc(schema.changes.id))
      .limit(HISTORY_LIMIT + 1);

    return {
      truncated: rows.length > HISTORY_LIMIT,
      entries: await describeChanges(
        commitment.projectId,
        rows.slice(0, HISTORY_LIMIT),
      ),
    };
  },
});
