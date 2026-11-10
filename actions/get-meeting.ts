import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getDb } from "../server/db/index.js";
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
    return getDb().transaction(
      async (tx) => {
        const meeting = await authorizeMeeting(id, "viewer");
        const access = await authorizeProject(meeting.projectId, "viewer");
        const canPublish = access.role !== "viewer";
        return loadMeetingResult(
          meeting,
          { includeDraft: canPublish, canPublish },
          tx,
        );
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  },
});
