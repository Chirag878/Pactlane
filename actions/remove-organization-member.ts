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
  canRemove,
  normalizeEmail,
  requireHumanActor,
  requireMembership,
} from "../server/lib/organizations.js";

export default defineAction({
  description:
    "Remove a member from an organization, or leave it yourself. Their organization-project access ends at once, even where project shares remain; meetings, commitments and history are kept. The owner cannot be removed: transfer ownership first. Admins can remove members only. Signed-in app UI only.",
  schema: z.strictObject({
    organizationId: z.string().min(1).describe("Organization id"),
    email: z.string().trim().min(1).max(320).describe("Member's email"),
  }),
  outputSchema: z.object({
    changed: z.boolean(),
    _receipt: z.custom<WriteReceipt>(),
  }),
  uiOnly: true,
  agentTool: false,
  run: async ({ organizationId, email: rawEmail }, ctx) => {
    const actor = requireHumanActor(requireActor(ctx));
    const email = normalizeEmail(rawEmail);
    await getDb().transaction(async (tx) => {
      const you = await requireMembership(tx, organizationId, actor, "update");
      const [target] = await tx
        .select()
        .from(schema.organizationMemberships)
        .where(
          and(
            eq(schema.organizationMemberships.organizationId, organizationId),
            eq(schema.organizationMemberships.email, email),
            eq(schema.organizationMemberships.status, "active"),
          ),
        )
        .for("update");
      if (!target) {
        fail("That person is not an active member of this organization.", {
          errorCode: "member_not_found",
          statusCode: 404,
        });
      }
      if (target.role === "owner") {
        fail(
          "The owner cannot be removed. Transfer ownership to another member first.",
          { errorCode: "final_owner", statusCode: 409 },
        );
      }
      if (!canRemove(you, target)) {
        fail(
          "Only the owner can remove an admin, and only an owner or admin can remove members.",
          { errorCode: "organization_role_required", statusCode: 403 },
        );
      }
      const removed = await tx
        .update(schema.organizationMemberships)
        .set({ status: "removed", removedBy: actor, removedAt: new Date() })
        .where(
          and(
            eq(schema.organizationMemberships.id, target.id),
            eq(schema.organizationMemberships.status, "active"),
          ),
        )
        .returning({ id: schema.organizationMemberships.id });
      if (removed.length !== 1) {
        fail("The membership changed while removing it. Try again.", {
          errorCode: "membership_conflict",
          statusCode: 409,
        });
      }
    });
    const _receipt: WriteReceipt = {
      changed: true,
      verified: true,
      summary:
        email === actor
          ? "You left the organization."
          : `Removed ${email} from the organization.`,
    };
    return { changed: true, _receipt };
  },
});
