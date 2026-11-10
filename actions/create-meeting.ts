import { defineAction } from "@agent-native/core/action";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeProject,
  projectAccessWhere,
  requireActor,
} from "../server/lib/action-context.js";
import { MAX_TRANSCRIPT_LENGTH } from "../shared/domain.js";

export default defineAction({
  description:
    "Store a meeting and its original transcript in a project. Requires editor access. The transcript is kept exactly as given, because evidence offsets index into it.",
  schema: z.strictObject({
    projectId: z.string().min(1).describe("Project the meeting belongs to"),
    title: z
      .string()
      .max(200)
      .refine((value) => value.trim().length > 0, "Must not be blank.")
      .describe("Meeting title"),
    meetingDate: z.iso
      .date()
      .describe("Calendar date of the meeting, YYYY-MM-DD"),
    transcript: z
      .string()
      .max(MAX_TRANSCRIPT_LENGTH)
      .refine((value) => value.trim().length > 0, "Must not be blank.")
      .describe("Full original transcript text"),
  }),
  outputSchema: z.object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    meetingDate: z.string(),
  }),
  run: async ({ projectId, title, meetingDate, transcript }, ctx) => {
    const actor = requireActor(ctx);
    const id = crypto.randomUUID();
    const meeting = { title: title.trim(), meetingDate };

    await getDb().transaction(async (tx) => {
      await authorizeProject(projectId, "editor");
      const inserted = await tx
        .insert(schema.meetings)
        .select(
          tx
            .select({
              id: sql<string>`${id}`.as("id"),
              projectId: sql<string>`${schema.projects.id}`.as("project_id"),
              title: sql<string>`${meeting.title}`.as("title"),
              meetingDate: sql<string>`${meetingDate}`.as("meeting_date"),
              transcript: sql<string>`${transcript}`.as("transcript"),
              summary: sql<null>`null`.as("summary"),
              processingStatus: sql<string>`'pending'`.as("processing_status"),
              analysisHash: sql<null>`null`.as("analysis_hash"),
              analysisPublicationState: sql<string>`'draft'`.as(
                "analysis_publication_state",
              ),
              analysisContentRevision: sql<number>`0`.as(
                "analysis_content_revision",
              ),
              analysisPublishedBy: sql<null>`null`.as("analysis_published_by"),
              analysisPublishedAt: sql<null>`null`.as("analysis_published_at"),
              analysisPublishedRevision: sql<null>`null`.as(
                "analysis_published_revision",
              ),
              createdAt: sql<Date>`now()`.as("created_at"),
              updatedAt: sql<Date>`now()`.as("updated_at"),
            })
            .from(schema.projects)
            .where(projectAccessWhere(projectId, "editor")),
        )
        .returning({ id: schema.meetings.id });
      if (inserted.length === 0) {
        await authorizeProject(projectId, "editor");
        return;
      }
      await tx.insert(schema.changes).values({
        projectId,
        entityType: "meeting",
        entityId: id,
        actorType: actor.actorType,
        actorId: actor.email,
        operation: "create",
        afterState: meeting,
      });
    });

    return { id, projectId, ...meeting };
  },
});
