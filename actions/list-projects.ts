import { defineAction } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import { organizationProjectAccess } from "../server/lib/organizations.js";

export default defineAction({
  description:
    "List the projects the signed-in user can access, newest first. Each has organizationId and organizationName, or null for a personal project. Organization projects appear only when the user is an active member and owns the project or was given access to it.",
  schema: z.strictObject({}),
  http: { method: "GET" },
  outputSchema: z.object({
    projects: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        organizationId: z.string().nullable(),
        organizationName: z.string().nullable(),
      }),
    ),
  }),
  run: async (_args, ctx) => {
    requireActor(ctx);
    const projects = await getDb()
      .select({
        id: schema.projects.id,
        name: schema.projects.name,
        description: schema.projects.description,
        organizationId: schema.projects.organizationId,
        organizationName: schema.pactlaneOrganizations.name,
      })
      .from(schema.projects)
      .leftJoin(
        schema.pactlaneOrganizations,
        eq(schema.pactlaneOrganizations.id, schema.projects.organizationId),
      )
      .where(
        and(
          accessFilter(schema.projects, schema.projectShares),
          organizationProjectAccess("viewer"),
        ),
      )
      .orderBy(desc(schema.projects.createdAt));
    return { projects };
  },
});
