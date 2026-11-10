import { fail } from "@agent-native/core/action";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { ASSIGNMENT_STATUSES } from "../../shared/domain.js";
import { getDb, schema } from "../db/index.js";
import { normalizeEmail } from "./organization-access.js";

type Db = ReturnType<typeof getDb>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Stable Better Auth user id for a verified email, or null. Reads only the
 * columns every deployment has, so lightweight test fixtures work too.
 */
export async function verifiedUserId(
  db: Db | Tx,
  rawEmail: string,
): Promise<string | null> {
  const email = normalizeEmail(rawEmail);
  const result = (await db.execute(sql`
    SELECT id FROM "user" WHERE lower(email) = ${email} AND email_verified = true LIMIT 1
  `)) as unknown as { rows: { id: string }[] };
  return result.rows[0]?.id ?? null;
}

export const assignmentResult = z.object({
  id: z.string(),
  commitmentId: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  organizationId: z.string(),
  organizationName: z.string(),
  recipientEmail: z.string(),
  description: z.string(),
  dueDate: z.string().nullable(),
  status: z.enum(ASSIGNMENT_STATUSES),
  assignedBy: z.string(),
  assignedAt: z.string(),
  updatedAt: z.string(),
  note: z.string().nullable(),
  version: z.number().int(),
  sourceMeetingId: z.string().nullable(),
  sourceMeetingTitle: z.string().nullable(),
});

export type AssignmentResult = z.infer<typeof assignmentResult>;

function denyProject(): never {
  fail("This project does not exist or you do not have the required access.", {
    errorCode: "access_denied",
    statusCode: 403,
  });
}

/**
 * Lock every row whose change could revoke project access. A concurrent
 * membership removal, share deletion or ownership transfer must wait until the
 * sensitive assignment transaction commits or rolls back.
 */
export async function lockOrganizationProjectAccess(
  tx: Tx,
  projectId: string,
  rawEmail: string,
  role: "viewer" | "editor",
) {
  const email = normalizeEmail(rawEmail);
  const [project] = await tx
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, projectId))
    .limit(1)
    .for("share");
  if (!project?.organizationId) denyProject();

  const [membership] = await tx
    .select()
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(
          schema.organizationMemberships.organizationId,
          project.organizationId,
        ),
        eq(schema.organizationMemberships.email, email),
        eq(schema.organizationMemberships.status, "active"),
      ),
    )
    .limit(1)
    .for("share");
  if (!membership) denyProject();

  if (project.ownerEmail.toLowerCase() === email) return project;
  const [share] = await tx
    .select({ role: schema.projectShares.role })
    .from(schema.projectShares)
    .where(
      and(
        eq(schema.projectShares.resourceId, project.id),
        eq(schema.projectShares.principalType, "user"),
        sql`lower(${schema.projectShares.principalId}) = ${email}`,
      ),
    )
    .limit(1)
    .for("share");
  const allowed =
    role === "viewer"
      ? ["viewer", "commenter", "editor", "admin"]
      : ["editor", "admin"];
  if (!share || !allowed.includes(share.role)) denyProject();
  return project;
}

export async function loadAssignmentResult(
  db: Db | Tx,
  assignmentId: string,
): Promise<AssignmentResult> {
  const [row] = await db
    .select({
      id: schema.commitmentAssignments.id,
      commitmentId: schema.commitmentAssignments.commitmentId,
      projectId: schema.commitmentAssignments.projectId,
      projectName: schema.projects.name,
      organizationId: schema.commitmentAssignments.organizationId,
      organizationName: schema.pactlaneOrganizations.name,
      recipientEmail: schema.commitmentAssignments.recipientEmail,
      description: schema.commitments.description,
      dueDate: schema.commitments.dueDate,
      status: schema.commitmentAssignments.status,
      assignedBy: schema.commitmentAssignments.assignedBy,
      assignedAt: schema.commitmentAssignments.assignedAt,
      updatedAt: schema.commitmentAssignments.updatedAt,
      note: schema.commitmentAssignments.note,
      version: schema.commitmentAssignments.version,
      sourceMeetingId: schema.meetings.id,
      sourceMeetingTitle: schema.meetings.title,
    })
    .from(schema.commitmentAssignments)
    .innerJoin(
      schema.commitments,
      eq(
        schema.commitments.id,
        schema.commitmentAssignments.commitmentId,
      ),
    )
    .innerJoin(
      schema.projects,
      eq(schema.projects.id, schema.commitmentAssignments.projectId),
    )
    .innerJoin(
      schema.pactlaneOrganizations,
      eq(
        schema.pactlaneOrganizations.id,
        schema.commitmentAssignments.organizationId,
      ),
    )
    .leftJoin(
      schema.meetings,
      eq(schema.meetings.id, schema.commitments.originMeetingId),
    )
    .where(eq(schema.commitmentAssignments.id, assignmentId))
    .limit(1);
  if (!row) {
    fail("This assignment is not available.", {
      errorCode: "assignment_not_found",
      statusCode: 404,
    });
  }
  return {
    ...row,
    assignedAt: row.assignedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
