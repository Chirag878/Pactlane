import { defineAction, fail } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeMeeting,
  authorizeProject,
  requireActor,
} from "../server/lib/action-context.js";
import {
  loadMeetingResult,
  meetingResultSchema,
} from "../server/lib/meeting-results.js";

export default defineAction({
  description:
    "Read a meeting: its original transcript, summary, decisions, commitments and evidence with server verification status. Requires viewer access.",
  schema: z.strictObject({
    id: z.string().min(1).describe("Meeting id"),
  }),
  http: { method: "GET" },
  // A full transcript must reach the model intact or its quotes cannot match.
  maxResultChars: 250_000,
  outputSchema: meetingResultSchema,
  run: async ({ id }, ctx) => {
    requireActor(ctx);
    const meeting = await authorizeMeeting(id, "viewer");
    const access = await authorizeProject(meeting.projectId, "viewer");
    const canPublish = access.role !== "viewer";
    return getDb().transaction(
      async (tx) => {
        const [snapshotMeeting] = await tx
          .select()
          .from(schema.meetings)
          .where(
            and(
              eq(schema.meetings.id, meeting.id),
              eq(schema.meetings.projectId, meeting.projectId),
            ),
          )
          .limit(1);
        if (!snapshotMeeting) {
          fail(
            "This project does not exist or you do not have the required access.",
            {
              errorCode: "access_denied",
              statusCode: 403,
            },
          );
        }
        return loadMeetingResult(
          snapshotMeeting,
          { includeDraft: canPublish, canPublish },
          tx,
        );
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  },
});
