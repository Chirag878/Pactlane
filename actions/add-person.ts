import {
  defineAction,
  fail,
  type WriteReceipt,
} from "@agent-native/core/action";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeProject,
  requireActor,
} from "../server/lib/action-context.js";
import { personResult } from "../server/lib/people.js";
import { MAX_PERSON_NAME_LENGTH } from "../shared/domain.js";

const name = z
  .string()
  .max(MAX_PERSON_NAME_LENGTH)
  .refine((value) => value.trim().length > 0, "Must not be blank.");

const key = (value: string) => value.trim().toLowerCase();

export default defineAction({
  description:
    "Add a participant to a project. No Pactlane account is needed. If the name or an alias already belongs to a participant, nothing is created and person_exists lists the matches so one can be selected instead. Requires editor access.",
  schema: z.strictObject({
    projectId: z.string().min(1).describe("Project id"),
    displayName: name.describe("How the person is named in meetings"),
    aliases: z
      .array(name)
      .max(10)
      .default([])
      .describe("Other names or spellings the person goes by"),
    email: z
      .email()
      .nullable()
      .default(null)
      .describe("Optional contact address; null if unknown"),
  }),
  outputSchema: z.object({
    person: personResult,
    _receipt: z.custom<WriteReceipt>(),
  }),
  run: async ({ projectId, displayName, aliases, email }, ctx) => {
    const actor = requireActor(ctx);
    await authorizeProject(projectId, "editor");

    const names = [displayName, ...aliases].map(key);
    const existing = await getDb()
      .select()
      .from(schema.people)
      .where(eq(schema.people.projectId, projectId));
    const matches = existing.filter((person) =>
      [person.displayName, ...person.aliases].some((n) =>
        names.includes(key(n)),
      ),
    );
    if (matches.length > 0) {
      fail(
        `${matches.map((m) => m.displayName).join(", ")} already ${matches.length === 1 ? "matches" : "match"} this name. Select the existing participant instead.`,
        {
          errorCode: "person_exists",
          statusCode: 409,
          details: {
            matches: matches.map((m) => ({
              id: m.id,
              displayName: m.displayName,
            })),
          },
        },
      );
    }

    const person = {
      id: crypto.randomUUID(),
      projectId,
      displayName: displayName.trim(),
      aliases: [...new Set(aliases.map((a) => a.trim()))],
      email,
    };
    await getDb().transaction(async (tx) => {
      await tx.insert(schema.people).values(person);
      await tx.insert(schema.changes).values({
        projectId,
        entityType: "person",
        entityId: person.id,
        actorType: actor.actorType,
        actorId: actor.email,
        operation: "create",
        afterState: {
          displayName: person.displayName,
          aliases: person.aliases,
          email,
        },
      });
    });

    const [saved] = await getDb()
      .select()
      .from(schema.people)
      .where(eq(schema.people.id, person.id))
      .limit(1);
    const _receipt: WriteReceipt = {
      changed: true,
      verified: saved?.projectId === projectId,
      summary: `Added ${person.displayName}.`,
    };
    return { person, _receipt };
  },
});
