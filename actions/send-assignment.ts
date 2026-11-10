import {
  defineAction,
  fail,
  type WriteReceipt,
} from "@agent-native/core/action";
import { isUniqueViolation } from "@agent-native/core/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import {
  assignmentResult,
  loadAssignmentResult,
  lockOrganizationProjectAccess,
} from "../server/lib/assignments.js";
import {
  normalizeEmail,
  requireHumanActor,
} from "../server/lib/organizations.js";

const alreadyAssigned = (): never =>
  fail("This commitment already has an active assignment.", {
    errorCode: "assignment_already_active",
    statusCode: 409,
  });

export default defineAction({
  description:
    "Deliver a published, human-confirmed commitment to one explicitly selected organization member. Requires editor access and recipient project access. Human app UI only; never inferred or sent by the agent.",
  schema: z.strictObject({
    commitmentId: z.string().min(1),
    recipientEmail: z.string().trim().max(320).pipe(z.email()),
  }),
  outputSchema: z.object({
    assignment: assignmentResult,
    changed: z.boolean(),
    _receipt: z.custom<WriteReceipt>(),
  }),
  uiOnly: true,
  agentTool: false,
  run: async ({ commitmentId, recipientEmail: rawRecipient }, ctx) => {
    const actor = requireHumanActor(requireActor(ctx));
    const recipientEmail = normalizeEmail(rawRecipient);
    const id = crypto.randomUUID();

    try {
      await getDb().transaction(async (tx) => {
        const [commitment] = await tx
          .select()
          .from(schema.commitments)
          .where(eq(schema.commitments.id, commitmentId))
          .limit(1)
          .for("update");
        if (!commitment) {
          fail("This commitment is not available.", {
            errorCode: "access_denied",
            statusCode: 403,
          });
        }
        const [owningProject] = await tx
          .select({ organizationId: schema.projects.organizationId })
          .from(schema.projects)
          .where(eq(schema.projects.id, commitment.projectId))
          .limit(1)
          .for("share");
        if (!owningProject?.organizationId) {
          fail("Assignments are available for organization projects only.", {
            errorCode: "organization_project_required",
            statusCode: 422,
          });
        }
        const project = await lockOrganizationProjectAccess(
          tx,
          commitment.projectId,
          actor,
          "editor",
        );
        if (commitment.reviewState !== "confirmed") {
          fail("Confirm this commitment before assigning it.", {
            errorCode: "commitment_confirmation_required",
            statusCode: 409,
          });
        }
        if (!commitment.originMeetingId) {
          fail("This commitment has no source meeting to publish.", {
            errorCode: "published_meeting_required",
            statusCode: 409,
          });
        }
        const [meeting] = await tx
          .select({
            state: schema.meetings.analysisPublicationState,
            revision: schema.meetings.analysisContentRevision,
            publishedRevision: schema.meetings.analysisPublishedRevision,
          })
          .from(schema.meetings)
          .where(
            and(
              eq(schema.meetings.id, commitment.originMeetingId),
              eq(schema.meetings.projectId, commitment.projectId),
            ),
          )
          .limit(1)
          .for("share");
        if (
          !meeting ||
          meeting.state !== "published" ||
          (meeting.publishedRevision !== null &&
            meeting.publishedRevision !== meeting.revision)
        ) {
          fail("Publish the current meeting analysis before assigning it.", {
            errorCode: "published_meeting_required",
            statusCode: 409,
          });
        }

        // Membership and the project grant are both locked until commit.
        await lockOrganizationProjectAccess(
          tx,
          commitment.projectId,
          recipientEmail,
          "viewer",
        ).catch((error) => {
          if (
            (error as { errorCode?: string } | null)?.errorCode ===
            "access_denied"
          ) {
            fail(
              "Give this organization member project access before assigning the commitment.",
              {
                errorCode: "recipient_project_access_required",
                statusCode: 409,
              },
            );
          }
          throw error;
        });
        const users = (await tx.execute(sql`
          SELECT id FROM "user"
          WHERE lower(email) = ${recipientEmail} AND email_verified = true
          LIMIT 1
        `)) as unknown as { rows: { id: string }[] };
        const recipientAccountId = users.rows[0]?.id;
        if (!recipientAccountId) {
          fail(
            "The recipient needs a verified Pactlane account before receiving assignments.",
            { errorCode: "recipient_account_required", statusCode: 409 },
          );
        }

        const [active] = await tx
          .select({ id: schema.commitmentAssignments.id })
          .from(schema.commitmentAssignments)
          .where(
            and(
              eq(schema.commitmentAssignments.commitmentId, commitmentId),
              inArray(schema.commitmentAssignments.status, [
                "pending",
                "accepted",
                "in_progress",
              ]),
            ),
          )
          .limit(1)
          .for("update");
        if (active) alreadyAssigned();

        const now = new Date();
        await tx.insert(schema.commitmentAssignments).values({
          id,
          projectId: commitment.projectId,
          organizationId: project.organizationId!,
          commitmentId,
          recipientAccountId,
          recipientEmail,
          status: "pending",
          assignedBy: actor,
          assignedAt: now,
          updatedBy: actor,
          updatedAt: now,
        });
        await tx.insert(schema.changes).values({
          projectId: commitment.projectId,
          entityType: "commitment",
          entityId: commitment.id,
          actorType: "user",
          actorId: actor,
          operation: "update",
          beforeState: { assignmentStatus: "none", recipientEmail: null },
          afterState: {
            assignmentId: id,
            assignmentStatus: "pending",
            recipientEmail,
          },
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) alreadyAssigned();
      throw error;
    }

    const assignment = await loadAssignmentResult(getDb(), id);
    const _receipt: WriteReceipt = {
      changed: true,
      verified:
        assignment.status === "pending" &&
        assignment.recipientEmail === recipientEmail,
      summary: `Assignment delivered to ${recipientEmail} for acknowledgement.`,
    };
    return { assignment, changed: true, _receipt };
  },
});
