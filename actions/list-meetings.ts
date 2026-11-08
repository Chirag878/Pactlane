import { defineAction } from "@agent-native/core/action";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeProject,
  requireActor,
} from "../server/lib/action-context.js";
import { MEETING_PROCESSING_STATUSES } from "../shared/domain.js";

export default defineAction({
  description:
    "List a project's meetings without transcripts, most recent first. Requires viewer access.",
  schema: z.strictObject({
    projectId: z.string().min(1).describe("Project to list meetings for"),
  }),
  http: { method: "GET" },
  outputSchema: z.object({
    project: z.object({ id: z.string(), name: z.string() }),
    meetings: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        meetingDate: z.string(),
        processingStatus: z.enum(MEETING_PROCESSING_STATUSES),
      }),
    ),
  }),
  run: async ({ projectId }, ctx) => {
    requireActor(ctx);
    const { resource } = await authorizeProject(projectId, "viewer");
    const meetings = await getDb()
      .select({
        id: schema.meetings.id,
        title: schema.meetings.title,
        meetingDate: schema.meetings.meetingDate,
        processingStatus: schema.meetings.processingStatus,
      })
      .from(schema.meetings)
      .where(eq(schema.meetings.projectId, projectId))
      .orderBy(
        desc(schema.meetings.meetingDate),
        desc(schema.meetings.createdAt),
      );
    return {
      project: { id: projectId, name: resource.name as string },
      meetings,
    };
  },
});
