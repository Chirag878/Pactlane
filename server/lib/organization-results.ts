import { z } from "zod";

import {
  ORGANIZATION_INVITE_ROLES,
  ORGANIZATION_ROLES,
} from "../../shared/domain.js";

export const organizationPermissionsResult = z.object({
  canInvite: z.boolean(),
  canInviteAdmins: z.boolean(),
  canRemoveMembers: z.boolean(),
  canCreateProjects: z.boolean(),
  canTransferOwnership: z.boolean(),
});

export const organizationSummaryResult = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  role: z.enum(ORGANIZATION_ROLES).describe("The signed-in user's role"),
  memberCount: z.number().int(),
});

export const invitationResult = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(ORGANIZATION_INVITE_ROLES),
  invitedBy: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  expired: z.boolean(),
  canRevoke: z.boolean(),
});
