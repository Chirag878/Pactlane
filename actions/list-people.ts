import { defineAction } from "@agent-native/core/action";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeProject,
  requireActor,
} from "../server/lib/action-context.js";
import { personResult } from "../server/lib/people.js";

export default defineAction({
  description:
    "List the participants of a project, who may or may not have Pactlane accounts. Use the id as a commitment's ownerId. Requires viewer access.",
  schema: z.strictObject({
    projectId: z.string().min(1).describe("Project id"),
  }),
  http: { method: "GET" },
  outputSchema: z.array(personResult),
  run: async ({ projectId }, ctx) => {
    requireActor(ctx);
    await authorizeProject(projectId, "viewer");
    return getDb()
      .select({
        id: schema.people.id,
        projectId: schema.people.projectId,
        displayName: schema.people.displayName,
        aliases: schema.people.aliases,
        email: schema.people.email,
      })
      .from(schema.people)
      .where(eq(schema.people.projectId, projectId))
      .orderBy(asc(sql`lower(${schema.people.displayName})`));
  },
});
