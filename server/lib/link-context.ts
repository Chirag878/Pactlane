import { fail } from "@agent-native/core/action";

import { authorizeCommitment, authorizeMeeting } from "./action-context.js";

/**
 * Loads a commitment and a meeting for a link decision, checks the caller may
 * edit both, and refuses any pair that cannot be a later mention.
 */
export async function loadLinkPair(commitmentId: string, meetingId: string) {
  const commitment = await authorizeCommitment(commitmentId, "editor");
  const meeting = await authorizeMeeting(meetingId, "editor");

  if (meeting.projectId !== commitment.projectId) {
    fail("A commitment can only be linked to a meeting in its own project.", {
      errorCode: "cross_project_link",
      statusCode: 422,
    });
  }
  if (commitment.reviewState === "rejected") {
    fail("This commitment was rejected. Restore it before linking.", {
      errorCode: "commitment_rejected",
      statusCode: 409,
    });
  }
  return { commitment, meeting };
}
