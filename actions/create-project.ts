import { defineAction } from "@agent-native/core/action";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";

const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, "Must not be blank.");

export default defineAction({
  description:
    "Create a project owned by the signed-in user. Meetings and commitments belong to a project. Returns the new project's id.",
  schema: z.strictObject({
    name: nonBlank(200).describe("Project name"),
    description: z
      .string()
      .max(2_000)
      .nullable()
      .describe("What the project is about, or null when not given"),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
  }),
  run: async ({ name, description }, ctx) => {
    const actor = requireActor(ctx);
    const id = crypto.randomUUID();
    const project = { name: name.trim(), description };

    await getDb().transaction(async (tx) => {
      await tx.insert(schema.projects).values({
        id,
        ...project,
        ownerEmail: actor.email,
        orgId: actor.orgId,
      });
      await tx.insert(schema.changes).values({
        projectId: id,
        entityType: "project",
        entityId: id,
        actorType: actor.actorType,
        actorId: actor.email,
        operation: "create",
        afterState: project,
      });
    });

    return { id, ...project };
  },
});
