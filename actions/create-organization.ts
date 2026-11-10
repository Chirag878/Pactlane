import { defineAction, type WriteReceipt } from "@agent-native/core/action";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import { organizationSummaryResult } from "../server/lib/organization-results.js";
import { requireHumanActor } from "../server/lib/organizations.js";

const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, "Must not be blank.");

export default defineAction({
  description:
    "Create an organization. The signed-in person becomes its only owner. Membership never grants project access by itself. Signed-in app UI only.",
  schema: z.strictObject({
    name: nonBlank(200).describe("Organization name"),
    description: z
      .string()
      .max(2_000)
      .nullable()
      .default(null)
      .describe("Optional description, or null"),
  }),
  outputSchema: z.object({
    organization: organizationSummaryResult,
    _receipt: z.custom<WriteReceipt>(),
  }),
  uiOnly: true,
  agentTool: false,
  run: async ({ name, description }, ctx) => {
    const email = requireHumanActor(requireActor(ctx));
    const id = crypto.randomUUID();
    const values = {
      name: name.trim(),
      description: description?.trim() || null,
    };
    await getDb().transaction(async (tx) => {
      await tx
        .insert(schema.pactlaneOrganizations)
        .values({ id, ...values, createdBy: email });
      await tx.insert(schema.organizationMemberships).values({
        organizationId: id,
        email,
        role: "owner",
        addedBy: email,
      });
    });
    const _receipt: WriteReceipt = {
      changed: true,
      verified: true,
      summary: `Created organization "${values.name}".`,
    };
    return {
      organization: { id, ...values, role: "owner" as const, memberCount: 1 },
      _receipt,
    };
  },
});
