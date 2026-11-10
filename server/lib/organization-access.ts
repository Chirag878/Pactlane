import { getDbExec, type DbExec } from "@agent-native/core/db";

/**
 * Kept free of `server/db/index.ts` imports: that module registers this
 * resolver, so importing it back would be circular.
 */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * The same rule for the framework's per-resource access check. Returning
 * `null` denies outright, before the owner and share rules run; `undefined`
 * lets them decide. Registered for the `project` resource type.
 */
export async function resolveOrganizationProjectAccess(
  resource: { id?: string },
  ctx: { userEmail?: string; transaction?: DbExec },
): Promise<"viewer" | "commenter" | "editor" | "admin" | null | undefined> {
  const email = ctx.userEmail ? normalizeEmail(ctx.userEmail) : null;
  if (!email || !resource?.id) return undefined;
  const exec = ctx.transaction ?? getDbExec();
  const { rows } = await exec.execute({
    sql: `SELECT p.organization_id AS organization_id,
        lower(p.owner_email) AS owner_email,
        EXISTS (
          SELECT 1 FROM organization_memberships m
          WHERE m.organization_id = p.organization_id
            AND m.email = ? AND m.status = 'active'
        ) AS is_member,
        (
          SELECT s.role FROM project_shares s
          WHERE s.resource_id = p.id AND s.principal_type = 'user'
            AND lower(s.principal_id) = ?
          ORDER BY CASE s.role WHEN 'admin' THEN 4 WHEN 'editor' THEN 3
            WHEN 'commenter' THEN 2 ELSE 1 END DESC
          LIMIT 1
        ) AS share_role
      FROM projects p WHERE p.id = ?`,
    args: [email, email, resource.id],
  });
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row || row.organization_id == null) return undefined;
  const member = row.is_member;
  if (!(member === true || member === 1 || member === "t")) return null;
  if (row.owner_email === email) return undefined;
  const role = row.share_role;
  return role === "viewer" ||
    role === "commenter" ||
    role === "editor" ||
    role === "admin"
    ? role
    : null;
}
