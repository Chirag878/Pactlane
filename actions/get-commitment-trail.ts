import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import {
  authorizeCommitment,
  requireActor,
} from "../server/lib/action-context.js";
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
    const commitment = await authorizeCommitment(id, "viewer");
    return loadCommitmentTrail(commitment, asOf ?? utcToday());
  },
});
