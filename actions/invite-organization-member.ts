import {
  defineAction,
  fail,
  type WriteReceipt,
} from "@agent-native/core/action";
import { isUniqueViolation } from "@agent-native/core/db";
import { and, eq, lte } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import {
  createInvitationToken,
  invitationExpiry,
  normalizeEmail,
  requireHumanActor,
  requireMembership,
  requireRole,
} from "../server/lib/organizations.js";
import { ORGANIZATION_INVITE_ROLES } from "../shared/domain.js";

const invitationPending = (): never =>
  fail(
    "This address already has a pending invitation. Revoke it first to issue a new link.",
    { errorCode: "invitation_pending", statusCode: 409 },
  );

export default defineAction({
  description:
    "Invite someone to an organization by email. Owners may invite admins or members; admins may invite members. Returns a one-time link that only the invited address can accept after signing in with a verified email. The link is shown once and only its hash is stored. Signed-in app UI only; no email is sent.",
  schema: z.strictObject({
    organizationId: z.string().min(1).describe("Organization id"),
    email: z
      .string()
      .trim()
      .max(320)
      .pipe(z.email())
      .describe("Recipient's email address"),
    role: z
      .enum(ORGANIZATION_INVITE_ROLES)
      .default("member")
      .describe(
        '"member" (default) or "admin"; admins can be invited by the owner only',
      ),
  }),
  outputSchema: z.object({
    invitation: z.object({
      id: z.string(),
      email: z.string(),
      role: z.enum(ORGANIZATION_INVITE_ROLES),
      expiresAt: z.string(),
    }),
    acceptPath: z
      .string()
      .describe("Relative link containing the one-time token. Shown once."),
    _receipt: z.custom<WriteReceipt>(),
  }),
  uiOnly: true,
  agentTool: false,
  run: async ({ organizationId, email: rawEmail, role }, ctx) => {
    const inviter = requireHumanActor(requireActor(ctx));
    const email = normalizeEmail(rawEmail);
    const { token, tokenHash } = await createInvitationToken();
    const now = new Date();
    const expiresAt = invitationExpiry(now);
    const id = crypto.randomUUID();

    try {
      await getDb().transaction(async (tx) => {
        const membership = await requireMembership(
          tx,
          organizationId,
          inviter,
          "update",
        );
        requireRole(
          membership,
          role === "admin" ? ["owner"] : ["owner", "admin"],
          role === "admin"
            ? "Only the organization owner can invite admins."
            : "Only an organization owner or admin can invite members.",
        );

        const [existing] = await tx
          .select({ status: schema.organizationMemberships.status })
          .from(schema.organizationMemberships)
          .where(
            and(
              eq(schema.organizationMemberships.organizationId, organizationId),
              eq(schema.organizationMemberships.email, email),
              eq(schema.organizationMemberships.status, "active"),
            ),
          )
          .limit(1);
        if (existing) {
          fail("This person is already an active member.", {
            errorCode: "already_member",
            statusCode: 409,
          });
        }

        // A lapsed invitation no longer blocks a new one.
        await tx
          .update(schema.organizationInvitations)
          .set({ status: "expired" })
          .where(
            and(
              eq(schema.organizationInvitations.organizationId, organizationId),
              eq(schema.organizationInvitations.email, email),
              eq(schema.organizationInvitations.status, "pending"),
              lte(schema.organizationInvitations.expiresAt, now),
            ),
          );
        const [pending] = await tx
          .select({ id: schema.organizationInvitations.id })
          .from(schema.organizationInvitations)
          .where(
            and(
              eq(schema.organizationInvitations.organizationId, organizationId),
              eq(schema.organizationInvitations.email, email),
              eq(schema.organizationInvitations.status, "pending"),
            ),
          )
          .limit(1);
        if (pending) invitationPending();

        await tx.insert(schema.organizationInvitations).values({
          id,
          organizationId,
          email,
          role,
          tokenHash,
          invitedBy: inviter,
          createdAt: now,
          expiresAt,
        });
      });
    } catch (error) {
      // Two concurrent invitations for one address: the second one loses.
      if (isUniqueViolation(error)) invitationPending();
      throw error;
    }

    const _receipt: WriteReceipt = {
      changed: true,
      verified: true,
      summary: `Invitation created for ${email} as ${role}. Copy the link now; it is shown once.`,
    };
    return {
      invitation: { id, email, role, expiresAt: expiresAt.toISOString() },
      // A URL fragment is never sent to the server in requests or referrers.
      acceptPath: `/invitations/accept#token=${token}`,
      _receipt,
    };
  },
});
