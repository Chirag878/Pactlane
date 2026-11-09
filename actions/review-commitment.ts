import {
  defineAction,
  fail,
  type WriteReceipt,
} from "@agent-native/core/action";
import { z } from "zod";

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
import { REVIEW_FLAG_CODES } from "../shared/domain.js";

export default defineAction({
  description:
    "A person's review of an AI-proposed commitment: confirm it (naming each review flag being accepted), reject it as wrongly extracted, or restore a rejected one. Records the person's judgement only; transcript evidence and its verification status are never changed. Only a signed-in person can use it, never the agent. Requires editor access and the expectedVersion from the last read.",
  schema: z.strictObject({
    id: z.string().min(1).describe("Commitment id"),
    expectedVersion: z
      .number()
      .int()
      .min(1)
      .describe("The commitment's version as last read"),
    outcome: z
      .enum(["confirm", "reject", "restore"])
      .describe(
        '"confirm" accepts the flags in resolveFlags; "reject" marks the commitment as wrongly extracted and keeps its history; "restore" brings a rejected commitment back for review',
      ),
    resolveFlags: z
      .array(z.enum(REVIEW_FLAG_CODES))
      .default([])
      .describe(
        "For confirm: the codes of the open review flags being accepted. Flags not listed stay open.",
      ),
  }),
  outputSchema: z.object({
    commitment: commitmentResult,
    changed: z.boolean(),
    _receipt: z.custom<WriteReceipt>(),
  }),
  // Approval is a deliberate action in this app's signed-in UI. Hiding the
  // tool alone would still leave other action transports able to call it.
  uiOnly: true,
  agentTool: false,
  run: async (input, ctx) => {
    const actor = requireActor(ctx);
    if (actor.actorType !== "user") {
      fail("Only a person can review a commitment.", {
        errorCode: "human_review_required",
        statusCode: 403,
      });
    }
    const current = await authorizeCommitment(input.id, "editor");
    if (current.version !== input.expectedVersion) {
      return failWithConflict(current);
    }

    const patch: CommitmentPatch = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (input.outcome === "confirm") {
      if (current.reviewState === "rejected") {
        fail("This commitment was rejected. Restore it before confirming.", {
          errorCode: "commitment_rejected",
          statusCode: 409,
        });
      }
      const open = new Set(current.reviewFlags.map((flag) => flag.code));
      if (open.size > 0 && input.resolveFlags.length === 0) {
        fail(
          `List the flags you are accepting: ${[...open].join(", ")}. None are cleared automatically.`,
          { errorCode: "flags_not_listed", statusCode: 422 },
        );
      }
      const unknown = input.resolveFlags.filter((code) => !open.has(code));
      if (unknown.length > 0) {
        fail(
          `These flags are not open on this commitment: ${unknown.join(", ")}.`,
          { errorCode: "flag_not_open", statusCode: 422 },
        );
      }
      const resolved = new Set(input.resolveFlags);
      const remaining = current.reviewFlags.filter(
        (flag) => !resolved.has(flag.code),
      );
      if (resolved.size > 0) {
        patch.reviewFlags = remaining;
        before.reviewFlags = current.reviewFlags.map((flag) => flag.code);
        after.reviewFlags = remaining.map((flag) => flag.code);
      }
      if (remaining.length === 0 && current.reviewState !== "confirmed") {
        patch.reviewState = "confirmed";
      }
    } else if (input.outcome === "reject") {
      if (current.reviewState !== "rejected") patch.reviewState = "rejected";
    } else {
      if (current.reviewState !== "rejected") {
        fail("Only a rejected commitment can be restored.", {
          errorCode: "not_rejected",
          statusCode: 409,
        });
      }
      patch.reviewState = "proposed";
    }

    if (patch.reviewState !== undefined) {
      before.reviewState = current.reviewState;
      after.reviewState = patch.reviewState;
      const decided = patch.reviewState !== "proposed";
      patch.reviewedBy = decided ? actor.email : null;
      patch.reviewedAt = decided ? new Date() : null;
    }

    if (Object.keys(after).length === 0) {
      const _receipt: WriteReceipt = {
        changed: false,
        verified: true,
        summary: "Nothing changed: the commitment is already in that state.",
      };
      return {
        commitment: await loadCommitmentResult(current),
        changed: false,
        _receipt,
      };
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
    const _receipt: WriteReceipt = {
      changed: true,
      verified: commitment.version === input.expectedVersion + 1,
      summary: `Review recorded: ${input.outcome}.`,
    };
    return { commitment, changed: true, _receipt };
  },
});
