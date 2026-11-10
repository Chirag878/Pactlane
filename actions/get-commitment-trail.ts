import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import { getDb } from "../server/db/index.js";
import {
  authorizeCommitment,
  authorizeProject,
  requireActor,
} from "../server/lib/action-context.js";
import { commitmentIsPublished } from "../server/lib/analysis-publication.js";
import { utcToday } from "../server/lib/commitment-ledger.js";
import {
  commitmentTrailResult,
  loadCommitmentTrail,
} from "../server/lib/commitment-trail.js";

export default defineAction({
  description:
    "Read one commitment's timeline across meetings: the original statement, later mentions a person confirmed, each with its verified or unverified quotations, then edits and review decisions, plus current health. Requires viewer access.",
  schema: z.strictObject({
    id: z.string().min(1).describe("Commitment id"),
    asOf: z.iso
      .date()
      .optional()
      .describe(
        "Calendar date overdue is measured against, YYYY-MM-DD; defaults to today in UTC",
      ),
  }),
  http: { method: "GET" },
  maxResultChars: 100_000,
  outputSchema: commitmentTrailResult,
  run: async ({ id, asOf }, ctx) => {
    requireActor(ctx);
    return getDb().transaction(
      async (tx) => {
        const snapshotCommitment = await authorizeCommitment(id, "viewer");
        const access = await authorizeProject(
          snapshotCommitment.projectId,
          "viewer",
        );
        const includeDraft = access.role !== "viewer";
        if (
          !includeDraft &&
          !(await commitmentIsPublished(snapshotCommitment, tx))
        ) {
          fail(
            "This project does not exist or you do not have the required access.",
            {
              errorCode: "access_denied",
              statusCode: 403,
            },
          );
        }
        return loadCommitmentTrail(
          snapshotCommitment,
          asOf ?? utcToday(),
          includeDraft,
          tx,
        );
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  },
});
