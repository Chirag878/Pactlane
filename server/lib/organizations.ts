import { fail } from "@agent-native/core/action";
import { getDbExec, type DbExec } from "@agent-native/core/db";
import { getRequestUserEmail } from "@agent-native/core/server/request-context";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";

import {
  ORGANIZATION_INVITATION_TTL_DAYS,
  type OrganizationRole,
} from "../../shared/domain.js";
import { getDb, schema } from "../db/index.js";
import type { Actor } from "./action-context.js";

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Membership = typeof schema.organizationMemberships.$inferSelect;

export {
  normalizeEmail,
  resolveOrganizationProjectAccess,
} from "./organization-access.js";
import { normalizeEmail } from "./organization-access.js";

/** One answer for "missing" and "not a member", so ids cannot be probed. */
export function denyOrganization(): never {
  fail(
    "This organization does not exist or you are not an active member of it.",
    { errorCode: "organization_access_denied", statusCode: 403 },
  );
}

function denyRole(message: string): never {
  fail(message, { errorCode: "organization_role_required", statusCode: 403 });
}

/** Organization administration is a person's decision, never the agent's. */
export function requireHumanActor(actor: Actor) {
  if (actor.actorType !== "user") {
    fail("Only a signed-in person can change an organization.", {
      errorCode: "human_action_required",
      statusCode: 403,
    });
  }
  return normalizeEmail(actor.email);
}

/**
 * The caller's active membership, read inside the caller's transaction. With
 * `lock`, the row stays locked until the transaction ends, so a concurrent
 * removal or role change waits instead of racing the decision made here.
 */
export async function requireMembership(
  db: Db | Tx,
  organizationId: string,
  email: string,
  lock: "update" | "share" | null = null,
): Promise<Membership> {
  const query = db
    .select()
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.email, normalizeEmail(email)),
        eq(schema.organizationMemberships.status, "active"),
      ),
    )
    .limit(1);
  const [membership] = await (lock ? query.for(lock) : query);
  if (!membership) denyOrganization();
  return membership;
}

export function requireRole(
  membership: Membership,
  roles: OrganizationRole[],
  message: string,
) {
  if (!roles.includes(membership.role)) denyRole(message);
}

/** What the caller's role allows. The server re-checks every action. */
export function organizationPermissions(role: OrganizationRole) {
  const admin = role === "owner" || role === "admin";
  return {
    canInvite: admin,
    canInviteAdmins: role === "owner",
    canRemoveMembers: admin,
    canCreateProjects: admin,
    canTransferOwnership: role === "owner",
  };
}

/** Owners manage anyone but the owner; admins manage plain members only. */
export function canRemove(
  actor: { email: string; role: OrganizationRole },
  target: { email: string; role: OrganizationRole },
) {
  if (target.role === "owner") return false;
  if (target.email === actor.email) return true;
  if (actor.role === "owner") return true;
  return actor.role === "admin" && target.role === "member";
}

export function canRevokeInvitation(
  role: OrganizationRole,
  invitationRole: "admin" | "member",
) {
  return role === "owner" || (role === "admin" && invitationRole === "member");
}

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export async function hashInvitationToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return toHex(new Uint8Array(digest));
}

/** 256 random bits. The caller shows the token once; only its hash is kept. */
export async function createInvitationToken() {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, tokenHash: await hashInvitationToken(token) };
}

export function invitationExpiry(now: Date) {
  return new Date(
    now.getTime() + ORGANIZATION_INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
  );
}

export type EmailVerification = "verified" | "unverified" | "unknown";

/**
 * Whether Better Auth has verified this address. Read before any transaction
 * opens: it uses the base connection. Anything unreadable is "unknown", which
 * callers must treat as not verified.
 */
export async function emailVerificationStatus(
  email: string,
  exec: DbExec = getDbExec(),
): Promise<EmailVerification> {
  try {
    const { rows } = await exec.execute({
      sql: 'SELECT email_verified FROM "user" WHERE LOWER(email) = LOWER(?) LIMIT 1',
      args: [normalizeEmail(email)],
    });
    if (rows.length === 0) return "unknown";
    const value = (rows[0] as Record<string, unknown>).email_verified;
    if (value === true || value === 1 || value === "1" || value === "t") {
      return "verified";
    }
    if (value === false || value === 0 || value === "0" || value === "f") {
      return "unverified";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

const SHARE_ROLES_AT_LEAST = {
  viewer: ["viewer", "commenter", "editor", "admin"],
  editor: ["editor", "admin"],
} as const;

/**
 * The organization half of project access, as SQL on `projects`. A personal
 * project passes unchanged. An organization project additionally needs an
 * active membership AND either ownership or a direct per-user share with the
 * required role. Organization roles, organization-wide visibility and group or
 * organization share principals never grant access to one.
 */
export function organizationProjectAccess(
  minRole: "viewer" | "editor",
  rawEmail: string | null | undefined = getRequestUserEmail(),
): SQL {
  const email = rawEmail ? normalizeEmail(rawEmail) : null;
  if (!email) return isNull(schema.projects.organizationId);
  const roles = SHARE_ROLES_AT_LEAST[minRole];
  return or(
    isNull(schema.projects.organizationId),
    and(
      sql`exists (select 1 from organization_memberships m
        where m.organization_id = ${schema.projects.organizationId}
          and m.email = ${email} and m.status = 'active')`,
      or(
        sql`lower(${schema.projects.ownerEmail}) = ${email}`,
        sql`exists (select 1 from project_shares s
          where s.resource_id = ${schema.projects.id}
            and s.principal_type = 'user'
            and lower(s.principal_id) = ${email}
            and s.role in (${sql.join(
              roles.map((role) => sql`${role}`),
              sql`, `,
            )}))`,
      ),
    ),
  )!;
}

/** Organizations the caller actively belongs to, with their role. */
export async function listActiveMemberships(db: Db | Tx, email: string) {
  return db
    .select({
      id: schema.pactlaneOrganizations.id,
      name: schema.pactlaneOrganizations.name,
      description: schema.pactlaneOrganizations.description,
      role: schema.organizationMemberships.role,
      memberCount: sql<number>`(select count(*)::int from organization_memberships c
        where c.organization_id = ${schema.pactlaneOrganizations.id}
          and c.status = 'active')`,
    })
    .from(schema.organizationMemberships)
    .innerJoin(
      schema.pactlaneOrganizations,
      eq(
        schema.pactlaneOrganizations.id,
        schema.organizationMemberships.organizationId,
      ),
    )
    .where(
      and(
        eq(schema.organizationMemberships.email, normalizeEmail(email)),
        eq(schema.organizationMemberships.status, "active"),
      ),
    )
    .orderBy(schema.pactlaneOrganizations.name);
}

export async function countActiveMembers(db: Db | Tx, organizationId: string) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.status, "active"),
      ),
    );
  return row?.count ?? 0;
}
