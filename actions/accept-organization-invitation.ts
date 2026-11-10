import {
  defineAction,
  fail,
  type WriteReceipt,
} from "@agent-native/core/action";
import { and, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import { organizationSummaryResult } from "../server/lib/organization-results.js";
import {
  countActiveMembers,
  emailVerificationStatus,
  hashInvitationToken,
  requireHumanActor,
} from "../server/lib/organizations.js";

function unavailable(message: string): never {
  fail(message, { errorCode: "invitation_unavailable", statusCode: 410 });
}

export default defineAction({
  description:
    "Accept an organization invitation with the one-time token from its link. Only the signed-in account whose verified email matches the invitation can accept, once, before it expires. Signed-in app UI only.",
  schema: z.strictObject({
    token: z
      .string()
      .min(20)
      .max(200)
      .describe("Token from the invitation link"),
  }),
  outputSchema: z.object({
    organization: organizationSummaryResult,
    alreadyMember: z.boolean(),
    _receipt: z.custom<WriteReceipt>(),
  }),
  uiOnly: true,
  agentTool: false,
  run: async ({ token }, ctx) => {
    const email = requireHumanActor(requireActor(ctx));
    const tokenHash = await hashInvitationToken(token);

    const [invitation] = await getDb()
      .select()
      .from(schema.organizationInvitations)
      .where(eq(schema.organizationInvitations.tokenHash, tokenHash))
      .limit(1);
    if (!invitation) {
      fail("This invitation link is not valid.", {
        errorCode: "invitation_invalid",
        statusCode: 404,
      });
    }
    if (invitation.email !== email) {
      fail(
        "This invitation was sent to a different email address. Sign in with that address to accept it.",
        { errorCode: "invitation_recipient_mismatch", statusCode: 403 },
      );
    }
    // Checked before the transaction: it reads the auth tables directly.
    const verification = await emailVerificationStatus(email);
    if (verification !== "verified") {
      fail(
        verification === "unverified"
          ? "Verify your email address before accepting this invitation."
          : "Your email address could not be confirmed as verified, so this invitation cannot be accepted.",
        { errorCode: "email_not_verified", statusCode: 403 },
      );
    }

    const now = new Date();
    const result = await getDb().transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(schema.organizationInvitations)
        .where(eq(schema.organizationInvitations.id, invitation.id))
        .for("update");
      if (!current || current.status === "revoked") {
        unavailable("This invitation was revoked.");
      }
      if (current.status === "accepted") {
        unavailable("This invitation has already been used.");
      }
      if (current.status === "expired" || current.expiresAt <= now) {
        unavailable("This invitation has expired. Ask for a new one.");
      }

      // An invitation is only as good as its issuer's authority today.
      const [issuer] = await tx
        .select({ role: schema.organizationMemberships.role })
        .from(schema.organizationMemberships)
        .where(
          and(
            eq(
              schema.organizationMemberships.organizationId,
              current.organizationId,
            ),
            eq(schema.organizationMemberships.email, current.invitedBy),
            eq(schema.organizationMemberships.status, "active"),
          ),
        )
        .for("share");
      const issuerAllowed =
        issuer &&
        (issuer.role === "owner" ||
          (issuer.role === "admin" && current.role === "member"));
      if (!issuerAllowed) {
        unavailable(
          "This invitation is no longer valid because the person who sent it can no longer invite.",
        );
      }

      const claimed = await tx
        .update(schema.organizationInvitations)
        .set({ status: "accepted", acceptedBy: email, acceptedAt: now })
        .where(
          and(
            eq(schema.organizationInvitations.id, current.id),
            eq(schema.organizationInvitations.status, "pending"),
            gt(schema.organizationInvitations.expiresAt, now),
          ),
        )
        .returning({ id: schema.organizationInvitations.id });
      if (claimed.length !== 1)
        unavailable("This invitation has already been used.");

      // A returning member is reactivated; an active one keeps their role.
      const joined = await tx
        .insert(schema.organizationMemberships)
        .values({
          organizationId: current.organizationId,
          email,
          role: current.role,
          addedBy: current.invitedBy,
        })
        .onConflictDoUpdate({
          target: [
            schema.organizationMemberships.organizationId,
            schema.organizationMemberships.email,
          ],
          set: {
            role: current.role,
            status: "active",
            addedBy: current.invitedBy,
            joinedAt: now,
            removedBy: null,
            removedAt: null,
          },
          setWhere: sql`${schema.organizationMemberships.status} = 'removed'`,
        })
        .returning({ id: schema.organizationMemberships.id });

      const [membership] = await tx
        .select({ role: schema.organizationMemberships.role })
        .from(schema.organizationMemberships)
        .where(
          and(
            eq(
              schema.organizationMemberships.organizationId,
              current.organizationId,
            ),
            eq(schema.organizationMemberships.email, email),
            eq(schema.organizationMemberships.status, "active"),
          ),
        );
      const [organization] = await tx
        .select()
        .from(schema.pactlaneOrganizations)
        .where(eq(schema.pactlaneOrganizations.id, current.organizationId));
      return {
        organization: {
          id: organization!.id,
          name: organization!.name,
          description: organization!.description,
          role: membership!.role,
          memberCount: await countActiveMembers(tx, organization!.id),
        },
        alreadyMember: joined.length === 0,
      };
    });

    const _receipt: WriteReceipt = {
      changed: true,
      verified: true,
      summary: result.alreadyMember
        ? `Invitation used; you were already a member of ${result.organization.name}.`
        : `Joined ${result.organization.name} as ${result.organization.role}.`,
    };
    return { ...result, _receipt };
  },
});
