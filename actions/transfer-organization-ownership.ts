import {
  defineAction,
  fail,
  type WriteReceipt,
} from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import {
  normalizeEmail,
  requireHumanActor,
  requireMembership,
  requireRole,
} from "../server/lib/organizations.js";

export default defineAction({
  description:
    "Make another active member the organization's owner. The current owner becomes an admin in the same transaction, so there is always exactly one owner. Owner only. Signed-in app UI only.",
  schema: z.strictObject({
    organizationId: z.string().min(1).describe("Organization id"),
    newOwnerEmail: z
      .string()
      .trim()
      .min(1)
      .max(320)
      .describe("Email of the active member who becomes owner"),
  }),
  outputSchema: z.object({
    changed: z.boolean(),
    _receipt: z.custom<WriteReceipt>(),
  }),
  uiOnly: true,
  agentTool: false,
  run: async ({ organizationId, newOwnerEmail }, ctx) => {
    const actor = requireHumanActor(requireActor(ctx));
    const target = normalizeEmail(newOwnerEmail);
    if (target === actor) {
      fail("You already own this organization.", {
        errorCode: "already_owner",
        statusCode: 409,
      });
    }
    await getDb().transaction(async (tx) => {
      const you = await requireMembership(tx, organizationId, actor, "update");
      requireRole(you, ["owner"], "Only the owner can transfer ownership.");
      const [next] = await tx
        .select()
        .from(schema.organizationMemberships)
        .where(
          and(
            eq(schema.organizationMemberships.organizationId, organizationId),
            eq(schema.organizationMemberships.email, target),
            eq(schema.organizationMemberships.status, "active"),
          ),
        )
        .for("update");
      if (!next) {
        fail("The new owner must be an active member of this organization.", {
          errorCode: "member_not_found",
          statusCode: 404,
        });
      }
      // Demote first: the one-owner index is checked per statement.
      await tx
        .update(schema.organizationMemberships)
        .set({ role: "admin" })
        .where(eq(schema.organizationMemberships.id, you.id));
      await tx
        .update(schema.organizationMemberships)
        .set({ role: "owner" })
        .where(eq(schema.organizationMemberships.id, next.id));
    });
    const _receipt: WriteReceipt = {
      changed: true,
      verified: true,
      summary: `${target} now owns the organization. You are an admin.`,
    };
    return { changed: true, _receipt };
  },
});
