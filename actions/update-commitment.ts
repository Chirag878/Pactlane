import {
  defineAction,
  fail,
  type WriteReceipt,
} from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeCommitment,
  requireActor,
} from "../server/lib/action-context.js";
import {
  failWithConflict,
  saveCommitmentChange,
  type CommitmentPatch,
} from "../server/lib/commitment-changes.js";
import {
  commitmentResult,
  loadCommitmentResult,
} from "../server/lib/meeting-results.js";
import {
  COMMITMENT_PRIORITIES,
  COMMITMENT_STATUSES,
  COMMITMENT_TRANSITIONS,
  MAX_COMMITMENT_DESCRIPTION_LENGTH,
} from "../shared/domain.js";

const EDITABLE = [
  "description",
  "ownerId",
  "dueDate",
  "priority",
  "status",
] as const;

/** Looks a person up inside one project, so another project's ids never resolve. */
async function personName(projectId: string, personId: string) {
  const [person] = await getDb()
    .select({ displayName: schema.people.displayName })
    .from(schema.people)
    .where(
      and(
        eq(schema.people.id, personId),
        eq(schema.people.projectId, projectId),
      ),
    )
    .limit(1);
  return person?.displayName ?? null;
}

export default defineAction({
  description:
    "Correct a commitment: description, owner (a person of the same project, or null to unassign), due date (YYYY-MM-DD, or null), priority (or null) and status. Send only the fields to change, plus the expectedVersion from the last read; a stale version is refused with version_conflict. Never changes transcript evidence or its verification. Requires editor access.",
  schema: z
    .strictObject({
      id: z.string().min(1).describe("Commitment id"),
      expectedVersion: z
        .number()
        .int()
        .min(1)
        .describe("The commitment's version as last read"),
      description: z
        .string()
        .max(MAX_COMMITMENT_DESCRIPTION_LENGTH)
        .refine((value) => value.trim().length > 0, "Must not be blank.")
        .optional()
        .describe("New description"),
      ownerId: z
        .string()
        .min(1)
        .nullable()
        .optional()
        .describe("A person id from list-people, or null to unassign"),
      dueDate: z.iso
        .date()
        .nullable()
        .optional()
        .describe("Calendar date YYYY-MM-DD, or null to clear"),
      priority: z
        .enum(COMMITMENT_PRIORITIES)
        .nullable()
        .optional()
        .describe('"low", "medium" or "high", or null to clear'),
      status: z
        .enum(COMMITMENT_STATUSES)
        .optional()
        .describe(
          'One of "open", "in_progress", "blocked", "completed", "cancelled"',
        ),
    })
    .refine(
      (input) => EDITABLE.some((field) => input[field] !== undefined),
      "Send at least one field to change.",
    ),
  outputSchema: z.object({
    commitment: commitmentResult,
    changed: z.boolean(),
    changedFields: z.array(z.string()),
    _receipt: z.custom<WriteReceipt>(),
  }),
  run: async (input, ctx) => {
    const actor = requireActor(ctx);
    const current = await authorizeCommitment(input.id, "editor");

    if (current.reviewState === "rejected") {
      fail("This commitment was rejected. Restore it before editing.", {
        errorCode: "commitment_rejected",
        statusCode: 409,
      });
    }
    if (current.version !== input.expectedVersion) {
      return failWithConflict(current);
    }

    const patch: CommitmentPatch = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const changedFields: string[] = [];
    const record = (
      field: (typeof EDITABLE)[number],
      from: unknown,
      to: unknown,
    ) => {
      before[field] = from;
      after[field] = to;
      changedFields.push(field);
    };

    if (
      input.description !== undefined &&
      input.description.trim() !== current.description
    ) {
      patch.description = input.description.trim();
      record("description", current.description, patch.description);
    }

    if (input.ownerId !== undefined && input.ownerId !== current.ownerId) {
      const next =
        input.ownerId === null
          ? null
          : await personName(current.projectId, input.ownerId);
      if (input.ownerId !== null && next === null) {
        fail("That person is not a participant of this project.", {
          errorCode: "owner_not_in_project",
          statusCode: 422,
        });
      }
      patch.ownerId = input.ownerId;
      record("ownerId", current.ownerId, input.ownerId);
      before.ownerName = current.ownerId
        ? await personName(current.projectId, current.ownerId)
        : null;
      after.ownerName = next;
    }

    if (input.dueDate !== undefined && input.dueDate !== current.dueDate) {
      patch.dueDate = input.dueDate;
      record("dueDate", current.dueDate, input.dueDate);
    }
    if (input.priority !== undefined && input.priority !== current.priority) {
      patch.priority = input.priority;
      record("priority", current.priority, input.priority);
    }

    if (input.status !== undefined && input.status !== current.status) {
      if (!COMMITMENT_TRANSITIONS[current.status].includes(input.status)) {
        fail(
          `A ${current.status.replace("_", " ")} commitment cannot become ${input.status.replace("_", " ")}.`,
          { errorCode: "invalid_transition", statusCode: 422 },
        );
      }
      if (current.status === "completed" && actor.actorType !== "user") {
        fail("Only a person can reopen a completed commitment.", {
          errorCode: "human_required",
          statusCode: 403,
        });
      }
      patch.status = input.status;
      patch.completedAt = input.status === "completed" ? new Date() : null;
      record("status", current.status, input.status);
    }

    if (changedFields.length === 0) {
      const _receipt: WriteReceipt = {
        changed: false,
        verified: true,
        summary: "Nothing changed: the commitment already has these values.",
      };
      return {
        commitment: await loadCommitmentResult(current),
        changed: false,
        changedFields,
        _receipt,
      };
    }

    // A person's correction settles the matching flag. An agent's does not, and
    // it withdraws a confirmation the person never saw this content under.
    let flags = current.reviewFlags;
    if (actor.actorType === "user") {
      flags = flags.filter(
        (flag) =>
          !(
            (flag.code === "owner" && patch.ownerId) ||
            (flag.code === "deadline" && patch.dueDate)
          ),
      );
    } else if (current.reviewState === "confirmed") {
      patch.reviewState = "proposed";
      patch.reviewedBy = null;
      patch.reviewedAt = null;
      before.reviewState = "confirmed";
      after.reviewState = "proposed";
    }
    // An agent's date is a proposal, so it cannot count as a confirmed deadline.
    if (
      actor.actorType !== "user" &&
      patch.dueDate &&
      !flags.some((flag) => flag.code === "deadline")
    ) {
      flags = [
        ...flags,
        {
          code: "deadline",
          message: `Date ${patch.dueDate} was set by the agent. Confirm it.`,
        },
      ];
    }
    if (flags.length !== current.reviewFlags.length) {
      patch.reviewFlags = flags;
      before.reviewFlags = current.reviewFlags.map((flag) => flag.code);
      after.reviewFlags = flags.map((flag) => flag.code);
    }

    const saved = await saveCommitmentChange({
      actor,
      current,
      expectedVersion: input.expectedVersion,
      patch,
      before,
      after,
    });

    const commitment = await loadCommitmentResult(saved);
    const persisted =
      commitment.version === input.expectedVersion + 1 &&
      (patch.description === undefined ||
        commitment.description === patch.description) &&
      (patch.ownerId === undefined || commitment.ownerId === patch.ownerId) &&
      (patch.dueDate === undefined || commitment.dueDate === patch.dueDate) &&
      (patch.priority === undefined ||
        commitment.priority === patch.priority) &&
      (patch.status === undefined || commitment.status === patch.status);
    const _receipt: WriteReceipt = {
      changed: true,
      verified: persisted,
      summary: `Updated ${changedFields.join(", ")}.`,
    };
    return { commitment, changed: true, changedFields, _receipt };
  },
});
