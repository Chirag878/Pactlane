import { defineAction } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import {
  organizationPermissionsResult,
  organizationSummaryResult,
} from "../server/lib/organization-results.js";
import {
  countActiveMembers,
  denyOrganization,
  normalizeEmail,
  organizationPermissions,
  organizationProjectAccess,
  requireMembership,
} from "../server/lib/organizations.js";

export default defineAction({
  description:
    "Read an organization the signed-in user belongs to: details, their role and permissions, member count, and only the organization projects they can access. Owners and admins do not see projects that were not shared with them.",
  schema: z.strictObject({
    organizationId: z.string().min(1).describe("Organization id"),
  }),
  http: { method: "GET" },
  outputSchema: z.object({
    organization: organizationSummaryResult.extend({
      createdAt: z.string(),
      permissions: organizationPermissionsResult,
    }),
    projects: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        isOwner: z.boolean(),
      }),
    ),
  }),
  run: async ({ organizationId }, ctx) => {
    const actor = requireActor(ctx);
    return getDb().transaction(
      async (tx) => {
        const membership = await requireMembership(
          tx,
          organizationId,
          actor.email,
        );
        const [organization] = await tx
          .select()
          .from(schema.pactlaneOrganizations)
          .where(eq(schema.pactlaneOrganizations.id, organizationId))
          .limit(1);
        if (!organization) denyOrganization();
        const projects = await tx
          .select({
            id: schema.projects.id,
            name: schema.projects.name,
            description: schema.projects.description,
            ownerEmail: schema.projects.ownerEmail,
          })
          .from(schema.projects)
          .where(
            and(
              eq(schema.projects.organizationId, organizationId),
              accessFilter(schema.projects, schema.projectShares),
              organizationProjectAccess("viewer"),
            ),
          )
          .orderBy(desc(schema.projects.createdAt));
        return {
          organization: {
            id: organization.id,
            name: organization.name,
            description: organization.description,
            role: membership.role,
            memberCount: await countActiveMembers(tx, organizationId),
            createdAt: organization.createdAt.toISOString(),
            permissions: organizationPermissions(membership.role),
          },
          projects: projects.map(({ ownerEmail, ...project }) => ({
            ...project,
            isOwner: normalizeEmail(ownerEmail) === membership.email,
          })),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  },
});
