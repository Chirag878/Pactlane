import { defineAction, fail } from "@agent-native/core/action";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import {
  normalizeEmail,
  requireMembership,
  requireRole,
} from "../server/lib/organizations.js";

const nonBlank = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, "Must not be blank.");

export default defineAction({
  description:
    "Create a project owned by the signed-in user. Meetings and commitments belong to a project. Leave organizationId null for a personal project. An organization project can only be created by a person from the app as an organization owner or admin; it stays private to its creator until shared. Returns the new project's id.",
  schema: z.strictObject({
    name: nonBlank(200).describe("Project name"),
    description: z
      .string()
      .max(2_000)
      .nullable()
      .describe("What the project is about, or null when not given"),
    organizationId: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe(
        "Organization to create the project in, or null (the default) for a personal project",
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    organizationId: z.string().nullable(),
  }),
  run: async ({ name, description, organizationId }, ctx) => {
    const actor = requireActor(ctx);
    if (organizationId !== null && actor.actorType !== "user") {
      fail("Only a signed-in person can create an organization project.", {
        errorCode: "human_action_required",
        statusCode: 403,
      });
    }
    const id = crypto.randomUUID();
    const project = { name: name.trim(), description };

    await getDb().transaction(async (tx) => {
      if (organizationId !== null) {
        // Locked until commit, so a concurrent removal or demotion waits.
        const membership = await requireMembership(
          tx,
          organizationId,
          actor.email,
          "share",
        );
        requireRole(
          membership,
          ["owner", "admin"],
          "Only an organization owner or admin can create organization projects.",
        );
      }
      await tx.insert(schema.projects).values({
        id,
        ...project,
        ownerEmail: organizationId ? normalizeEmail(actor.email) : actor.email,
        // An organization project never joins a framework organization, so
        // framework organization visibility can never widen access to it.
        orgId: organizationId ? null : actor.orgId,
        organizationId,
      });
      await tx.insert(schema.changes).values({
        projectId: id,
        entityType: "project",
        entityId: id,
        actorType: actor.actorType,
        actorId: actor.email,
        operation: "create",
        afterState: organizationId ? { ...project, organizationId } : project,
      });
    });

    return { id, ...project, organizationId };
  },
});
