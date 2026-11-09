import { defineAction } from "@agent-native/core/action";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeProject,
  requireActor,
} from "../server/lib/action-context.js";
import {
  ledgerEntryResult,
  loadLedgerEntries,
  utcToday,
} from "../server/lib/commitment-ledger.js";

export default defineAction({
  description:
    "Read every commitment in a project across its meetings: owner, due date, status, review state, evidence summary, related meetings and health worked out from saved data (overdue, revisited, needs review) with factual sentences you can repeat. Requires viewer access.",
  schema: z.strictObject({
    projectId: z.string().min(1).describe("Project id"),
    asOf: z.iso
      .date()
      .optional()
      .describe(
        "Calendar date overdue is measured against, YYYY-MM-DD; defaults to today in UTC",
      ),
  }),
  http: { method: "GET" },
  maxResultChars: 100_000,
  outputSchema: z.object({
    project: z.object({ id: z.string(), name: z.string() }),
    asOf: z.string(),
    entries: z.array(ledgerEntryResult),
    truncated: z.boolean(),
  }),
  run: async ({ projectId, asOf }, ctx) => {
    requireActor(ctx);
    await authorizeProject(projectId, "viewer");
    const [project] = await getDb()
      .select({ id: schema.projects.id, name: schema.projects.name })
      .from(schema.projects)
      .where(eq(schema.projects.id, projectId))
      .limit(1);
    const date = asOf ?? utcToday();
    return {
      project: project!,
      asOf: date,
      ...(await loadLedgerEntries(projectId, date)),
    };
  },
});
