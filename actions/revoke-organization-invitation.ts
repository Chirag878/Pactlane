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
  canRevokeInvitation,
  denyOrganization,
  requireHumanActor,
  requireMembership,
} from "../server/lib/organizations.js";

export default defineAction({
  description:
    "Revoke a pending organization invitation so its link stops working. The owner can revoke any invitation; admins can revoke member invitations. Signed-in app UI only.",
  schema: z.strictObject({
    invitationId: z.string().min(1).describe("Invitation id"),
  }),
  outputSchema: z.object({
    changed: z.boolean(),
    _receipt: z.custom<WriteReceipt>(),
  }),
  uiOnly: true,
  agentTool: false,
  run: async ({ invitationId }, ctx) => {
    const actor = requireHumanActor(requireActor(ctx));
    const changed = await getDb().transaction(async (tx) => {
      const [invitation] = await tx
        .select()
        .from(schema.organizationInvitations)
        .where(eq(schema.organizationInvitations.id, invitationId))
        .for("update");
      if (!invitation) denyOrganization();
      const membership = await requireMembership(
        tx,
        invitation.organizationId,
        actor,
        "update",
      );
      if (!canRevokeInvitation(membership.role, invitation.role)) {
        fail(
          invitation.role === "admin"
            ? "Only the organization owner can revoke an admin invitation."
            : "Only an organization owner or admin can revoke invitations.",
          { errorCode: "organization_role_required", statusCode: 403 },
        );
      }
      if (invitation.status !== "pending") return false;
      const revoked = await tx
        .update(schema.organizationInvitations)
        .set({ status: "revoked", revokedBy: actor, revokedAt: new Date() })
        .where(
          and(
            eq(schema.organizationInvitations.id, invitation.id),
            eq(schema.organizationInvitations.status, "pending"),
          ),
        )
        .returning({ id: schema.organizationInvitations.id });
      return revoked.length === 1;
    });
    const _receipt: WriteReceipt = {
      changed,
      verified: true,
      summary: changed
        ? "Invitation revoked. Its link no longer works."
        : "Nothing changed: the invitation was no longer pending.",
    };
    return { changed, _receipt };
  },
});
