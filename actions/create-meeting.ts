import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeProject,
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
    await authorizeProject(projectId, "editor");
    const id = crypto.randomUUID();
    const meeting = { title: title.trim(), meetingDate };

    await getDb().transaction(async (tx) => {
      await tx
        .insert(schema.meetings)
        .values({ id, projectId, transcript, ...meeting });
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
