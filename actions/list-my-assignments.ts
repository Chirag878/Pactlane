import { defineAction } from "@agent-native/core/action";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { getDb } from "../server/db/index.js";
import { requireActor } from "../server/lib/action-context.js";
import { assignmentResult, verifiedUserId } from "../server/lib/assignments.js";
import { normalizeEmail } from "../server/lib/organization-access.js";

export default defineAction({
  description:
    "List the signed-in person's assignments. Protected details appear only while the person remains an active organization member with project access.",
  schema: z.strictObject({}),
  http: { method: "GET" },
  agentTool: false,
  outputSchema: z.object({ assignments: z.array(assignmentResult) }),
  run: async (_input, ctx) => {
    const email = normalizeEmail(requireActor(ctx).email);
    const db = getDb();
    const userId = await verifiedUserId(db, email);
    if (!userId) return { assignments: [] };
    type AssignmentRow = {
      id: string;
      commitment_id: string;
      project_id: string;
      project_name: string;
      organization_id: string;
      organization_name: string;
      recipient_email: string;
      description: string;
      due_date: string | null;
      status: "pending" | "accepted" | "disputed" | "in_progress" | "completed";
      assigned_by: string;
      assigned_at: Date | string;
      updated_at: Date | string;
      note: string | null;
      version: number;
      source_meeting_id: string | null;
      source_meeting_title: string | null;
    };
    const result = (await getDb().execute(sql`
      SELECT a.id, a.commitment_id, a.project_id, p.name AS project_name,
        a.organization_id, o.name AS organization_name,
        a.recipient_email, c.description, c.due_date, a.status,
        a.assigned_by, a.assigned_at, a.updated_at, a.note, a.version,
        m.id AS source_meeting_id, m.title AS source_meeting_title
      FROM commitment_assignments a
      JOIN commitments c ON c.id = a.commitment_id AND c.project_id = a.project_id
      JOIN projects p ON p.id = a.project_id
      JOIN pactlane_organizations o ON o.id = a.organization_id
      LEFT JOIN meetings m ON m.id = c.origin_meeting_id
      WHERE a.recipient_account_id = ${userId}
        AND EXISTS (
          SELECT 1 FROM organization_memberships om
          WHERE om.organization_id = a.organization_id
            AND om.email = ${email} AND om.status = 'active'
        )
        AND (
          lower(p.owner_email) = ${email}
          OR EXISTS (
            SELECT 1 FROM project_shares ps
            WHERE ps.resource_id = p.id AND ps.principal_type = 'user'
              AND lower(ps.principal_id) = ${email}
              AND ps.role IN ('viewer', 'commenter', 'editor', 'admin')
          )
        )
      ORDER BY CASE a.status
        WHEN 'pending' THEN 0 WHEN 'accepted' THEN 1 WHEN 'in_progress' THEN 2
        WHEN 'disputed' THEN 3 ELSE 4 END,
        a.updated_at DESC
      LIMIT 100
    `)) as unknown as { rows: AssignmentRow[] };
    return {
      assignments: result.rows.map((row) => ({
        id: row.id,
        commitmentId: row.commitment_id,
        projectId: row.project_id,
        projectName: row.project_name,
        organizationId: row.organization_id,
        organizationName: row.organization_name,
        recipientEmail: row.recipient_email,
        description: row.description,
        dueDate: row.due_date,
        status: row.status,
        assignedBy: row.assigned_by,
        assignedAt: new Date(row.assigned_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        note: row.note,
        version: Number(row.version),
        sourceMeetingId: row.source_meeting_id,
        sourceMeetingTitle: row.source_meeting_title,
      })),
    };
  },
});
