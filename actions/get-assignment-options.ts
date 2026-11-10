import {
  defineAction,
  fail,
} from "@agent-native/core/action";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeCommitment,
  authorizeProject,
  requireActor,
} from "../server/lib/action-context.js";
import {
  assignmentResult,
  loadAssignmentResult,
  verifiedUserId,
} from "../server/lib/assignments.js";
import { requireHumanActor } from "../server/lib/organizations.js";

export default defineAction({
  description:
    "List active organization members who may receive a confirmed commitment, their current project access, and any active handoff. Requires project editor access. Human app UI only; the agent never selects a recipient.",
  schema: z.strictObject({
    commitmentId: z.string().min(1),
  }),
  http: { method: "GET" },
  uiOnly: true,
  agentTool: false,
  outputSchema: z.object({
    members: z.array(
      z.object({
        email: z.string(),
        role: z.string(),
        hasAccount: z.boolean(),
        hasProjectAccess: z.boolean(),
      }),
    ),
    activeAssignment: assignmentResult.nullable(),
    readiness: z.object({
      confirmed: z.boolean(),
      published: z.boolean(),
    }),
  }),
  run: async ({ commitmentId }, ctx) => {
    requireHumanActor(requireActor(ctx));
    const commitment = await authorizeCommitment(commitmentId, "editor");
    const access = await authorizeProject(commitment.projectId, "editor");
    const organizationId = (access.resource.organizationId as string | null) ?? null;
    if (!organizationId) {
      fail("Assignments are available for organization projects only.", {
        errorCode: "organization_project_required",
        statusCode: 422,
      });
    }
    const [members, activeRows] = await Promise.all([
      getDb()
        .select({
          email: schema.organizationMemberships.email,
          role: schema.organizationMemberships.role,
        })
        .from(schema.organizationMemberships)
        .where(
          and(
            eq(schema.organizationMemberships.organizationId, organizationId),
            eq(schema.organizationMemberships.status, "active"),
          ),
        )
        .orderBy(asc(schema.organizationMemberships.email)),
      getDb()
        .select({ id: schema.commitmentAssignments.id })
        .from(schema.commitmentAssignments)
        .where(
          and(
            eq(schema.commitmentAssignments.commitmentId, commitmentId),
            eq(schema.commitmentAssignments.projectId, commitment.projectId),
            inArray(schema.commitmentAssignments.status, [
              "pending",
              "accepted",
              "in_progress",
            ]),
          ),
        )
        .orderBy(desc(schema.commitmentAssignments.assignedAt))
        .limit(1),
    ]);

    const shares = await getDb()
      .select({
        email: schema.projectShares.principalId,
        role: schema.projectShares.role,
      })
      .from(schema.projectShares)
      .where(
        and(
          eq(schema.projectShares.resourceId, commitment.projectId),
          eq(schema.projectShares.principalType, "user"),
        ),
      );
    const owner = String(access.resource.ownerEmail).toLowerCase();
    const shareByEmail = new Map(
      shares.map((share) => [share.email.toLowerCase(), share.role]),
    );
    const db = getDb();
    const options = await Promise.all(
      members.map(async (member) => ({
        email: member.email,
        role: member.role,
        hasAccount: (await verifiedUserId(db, member.email)) !== null,
        hasProjectAccess:
          member.email === owner ||
          ["viewer", "commenter", "editor", "admin"].includes(
            shareByEmail.get(member.email) ?? "",
          ),
      })),
    );
    const active = activeRows[0]
      ? await loadAssignmentResult(getDb(), activeRows[0].id)
      : null;
    const confirmed = commitment.reviewState === "confirmed";
    let published = false;
    if (commitment.originMeetingId) {
      const [meeting] = await getDb()
        .select({
          state: schema.meetings.analysisPublicationState,
          revision: schema.meetings.analysisContentRevision,
          publishedRevision: schema.meetings.analysisPublishedRevision,
        })
        .from(schema.meetings)
        .where(eq(schema.meetings.id, commitment.originMeetingId))
        .limit(1);
      published =
        !!meeting &&
        meeting.state === "published" &&
        (meeting.publishedRevision === null || meeting.publishedRevision === meeting.revision);
    }
    return { members: options, activeAssignment: active, readiness: { confirmed, published } };
  },
});
