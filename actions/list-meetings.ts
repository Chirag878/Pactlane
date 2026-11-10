import { defineAction } from "@agent-native/core/action";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeProject,
  requireActor,
} from "../server/lib/action-context.js";
import { MEETING_PROCESSING_STATUSES } from "../shared/domain.js";
import { ANALYSIS_PUBLICATION_STATES } from "../shared/domain.js";

export default defineAction({
  description:
    "List a project's meetings without transcripts, most recent first. Requires viewer access.",
  schema: z.strictObject({
    projectId: z.string().min(1).describe("Project to list meetings for"),
  }),
  http: { method: "GET" },
  outputSchema: z.object({
    project: z.object({
      id: z.string(),
      name: z.string(),
      organizationId: z
        .string()
        .nullable()
        .describe("Organization the project belongs to, or null if personal"),
      organizationName: z.string().nullable(),
      canManageAccess: z
        .boolean()
        .describe("Whether the caller may grant or remove project access"),
    }),
    meetings: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        meetingDate: z.string(),
        processingStatus: z.enum(MEETING_PROCESSING_STATUSES),
        analysisPublicationState: z.enum(ANALYSIS_PUBLICATION_STATES),
      }),
    ),
  }),
  run: async ({ projectId }, ctx) => {
    requireActor(ctx);
    return getDb().transaction(
      async (tx) => {
        const { resource, role } = await authorizeProject(projectId, "viewer");
        const organizationId =
          (resource.organizationId as string | null) ?? null;
        const [organization] = organizationId
          ? await tx
              .select({ name: schema.pactlaneOrganizations.name })
              .from(schema.pactlaneOrganizations)
              .where(eq(schema.pactlaneOrganizations.id, organizationId))
          : [];
        const meetings = await tx
          .select({
            id: schema.meetings.id,
            title: schema.meetings.title,
            meetingDate: schema.meetings.meetingDate,
            processingStatus: schema.meetings.processingStatus,
            analysisPublicationState: schema.meetings.analysisPublicationState,
          })
          .from(schema.meetings)
          .where(eq(schema.meetings.projectId, projectId))
          .orderBy(
            desc(schema.meetings.meetingDate),
            desc(schema.meetings.createdAt),
          );
        return {
          project: {
            id: projectId,
            name: resource.name as string,
            organizationId,
            organizationName: organization?.name ?? null,
            canManageAccess: role === "owner" || role === "admin",
          },
          meetings,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  },
});
