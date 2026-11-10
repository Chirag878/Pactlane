import {
  defineAction,
  fail,
  type WriteReceipt,
} from "@agent-native/core/action";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import {
  assignmentResult,
  loadAssignmentResult,
  lockOrganizationProjectAccess,
  verifiedUserId,
} from "../server/lib/assignments.js";
import { normalizeEmail } from "../server/lib/organization-access.js";
import {
  ASSIGNMENT_STATUSES,
  ASSIGNMENT_TRANSITIONS,
  type AssignmentStatus,
} from "../shared/domain.js";

export default defineAction({
  description:
    "A recipient accepts, disputes or progresses their assignment. Project editors may progress an already accepted assignment, but can never accept or dispute for the recipient. Human app UI only.",
  schema: z.strictObject({
    assignmentId: z.string().min(1),
    expectedVersion: z.number().int().min(1),
    status: z.enum(ASSIGNMENT_STATUSES),
    note: z.string().trim().max(2000).nullable().default(null),
  }),
  outputSchema: z.object({
    assignment: assignmentResult,
    changed: z.boolean(),
    _receipt: z.custom<WriteReceipt>(),
  }),
  uiOnly: true,
  agentTool: false,
  run: async ({ assignmentId, expectedVersion, status, note }, ctx) => {
    const actor = requireActor(ctx);
    if (actor.actorType !== "user") {
      fail("Only a signed-in person can update an assignment.", {
        errorCode: "human_action_required",
        statusCode: 403,
      });
    }
    const email = normalizeEmail(actor.email);
    const actorUserId = await verifiedUserId(getDb(), email);
    if (!actorUserId) {
      fail("A verified account is required to update assignments.", {
        errorCode: "verified_account_required",
        statusCode: 403,
      });
    }

    const result = await getDb().transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.commitmentAssignments)
        .where(eq(schema.commitmentAssignments.id, assignmentId))
        .limit(1)
        .for("update");
      if (!current) {
        fail("This assignment is not available.", {
          errorCode: "assignment_not_found",
          statusCode: 404,
        });
      }
      if (current.version !== expectedVersion) {
        fail("This assignment changed. Load the latest version and try again.", {
          errorCode: "assignment_version_conflict",
          statusCode: 409,
          details: { currentVersion: current.version },
        });
      }
      const isRecipient = current.recipientAccountId === actorUserId;
      await lockOrganizationProjectAccess(
        tx,
        current.projectId,
        email,
        isRecipient ? "viewer" : "editor",
      );

      if (!ASSIGNMENT_TRANSITIONS[current.status].includes(status)) {
        fail(
          `An assignment cannot move from ${current.status} to ${status}.`,
          { errorCode: "assignment_transition_invalid", statusCode: 409 },
        );
      }
      if (!isRecipient) {
        if (status === "accepted" || status === "disputed") {
          fail("Only the recipient can accept or dispute this assignment.", {
            errorCode: "recipient_acknowledgement_required",
            statusCode: 403,
          });
        }
        if (current.status !== "accepted" && current.status !== "in_progress") {
          fail("Editors can update progress only after the recipient accepts.", {
            errorCode: "recipient_acknowledgement_required",
            statusCode: 409,
          });
        }
      }
      if (status === "disputed" && !note) {
        fail("Explain why you dispute this assignment.", {
          errorCode: "dispute_reason_required",
          statusCode: 422,
        });
      }

      const now = new Date();
      const saved = await tx
        .update(schema.commitmentAssignments)
        .set({
          status,
          note,
          updatedBy: email,
          updatedAt: now,
          version: sql`${schema.commitmentAssignments.version} + 1`,
          completedAt: status === "completed" ? now : null,
        })
        .where(
          and(
            eq(schema.commitmentAssignments.id, assignmentId),
            eq(schema.commitmentAssignments.version, expectedVersion),
          ),
        )
        .returning({ version: schema.commitmentAssignments.version });
      if (saved.length !== 1) {
        fail("This assignment changed. Load the latest version and try again.", {
          errorCode: "assignment_version_conflict",
          statusCode: 409,
        });
      }
      await tx.insert(schema.changes).values({
        projectId: current.projectId,
        entityType: "commitment",
        entityId: current.commitmentId,
        actorType: "user",
        actorId: email,
        operation: "update",
        beforeState: {
          assignmentId,
          assignmentStatus: current.status,
          assignmentNote: current.note,
        },
        afterState: {
          assignmentId,
          assignmentStatus: status,
          assignmentNote: note,
        },
      });
      return loadAssignmentResult(tx, assignmentId);
    });

    const _receipt: WriteReceipt = {
      changed: true,
      verified:
        result.status === status && result.version === expectedVersion + 1,
      summary: `Assignment moved to ${status}.`,
    };
    return { assignment: result, changed: true, _receipt };
  },
});
