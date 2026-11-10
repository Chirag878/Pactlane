import { defineAction } from "@agent-native/core/action";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import { invitationResult } from "../server/lib/organization-results.js";
import {
  canRemove,
  canRevokeInvitation,
  requireMembership,
} from "../server/lib/organizations.js";
import { ORGANIZATION_ROLES } from "../shared/domain.js";

export default defineAction({
  description:
    "List an organization's active members and roles. Owners and admins also see pending invitations, never their links. Requires active membership.",
  schema: z.strictObject({
    organizationId: z.string().min(1).describe("Organization id"),
  }),
  http: { method: "GET" },
  outputSchema: z.object({
    you: z.object({ email: z.string(), role: z.enum(ORGANIZATION_ROLES) }),
    members: z.array(
      z.object({
        email: z.string(),
        role: z.enum(ORGANIZATION_ROLES),
        joinedAt: z.string(),
        isYou: z.boolean(),
        canRemove: z.boolean(),
      }),
    ),
    invitations: z.array(invitationResult),
  }),
  run: async ({ organizationId }, ctx) => {
    const actor = requireActor(ctx);
    return getDb().transaction(
      async (tx) => {
        const you = await requireMembership(tx, organizationId, actor.email);
        const members = await tx
          .select()
          .from(schema.organizationMemberships)
          .where(
            and(
              eq(schema.organizationMemberships.organizationId, organizationId),
              eq(schema.organizationMemberships.status, "active"),
            ),
          )
          .orderBy(
            asc(schema.organizationMemberships.joinedAt),
            asc(schema.organizationMemberships.email),
          );
        const administers = you.role === "owner" || you.role === "admin";
        const invitations = administers
          ? await tx
              .select()
              .from(schema.organizationInvitations)
              .where(
                and(
                  eq(
                    schema.organizationInvitations.organizationId,
                    organizationId,
                  ),
                  eq(schema.organizationInvitations.status, "pending"),
                ),
              )
              .orderBy(asc(schema.organizationInvitations.createdAt))
          : [];
        const now = Date.now();
        return {
          you: { email: you.email, role: you.role },
          members: members.map((member) => ({
            email: member.email,
            role: member.role,
            joinedAt: member.joinedAt.toISOString(),
            isYou: member.email === you.email,
            canRemove: canRemove(you, member),
          })),
          invitations: invitations.map((invitation) => ({
            id: invitation.id,
            email: invitation.email,
            role: invitation.role,
            invitedBy: invitation.invitedBy,
            createdAt: invitation.createdAt.toISOString(),
            expiresAt: invitation.expiresAt.toISOString(),
            expired: invitation.expiresAt.getTime() <= now,
            canRevoke: canRevokeInvitation(you.role, invitation.role),
          })),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  },
});
