import { defineAction } from "@agent-native/core/action";
import { accessFilter } from "@agent-native/core/sharing";
import { desc } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";

export default defineAction({
  description: "List the projects the signed-in user can access, newest first.",
  schema: z.strictObject({}),
  http: { method: "GET" },
  outputSchema: z.object({
    projects: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable(),
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
      })
      .from(schema.projects)
      .where(accessFilter(schema.projects, schema.projectShares))
      .orderBy(desc(schema.projects.createdAt));
    return { projects };
  },
});
