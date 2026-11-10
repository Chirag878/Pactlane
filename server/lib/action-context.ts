import { fail, type ActionRunContext } from "@agent-native/core/action";
import {
  getRequestOrgId,
  getRequestUserEmail,
} from "@agent-native/core/server/request-context";
import {
  accessFilter,
  assertAccess,
  ForbiddenError,
} from "@agent-native/core/sharing";
import { and, eq, exists } from "drizzle-orm";

import type { CHANGE_ACTOR_TYPES } from "../../shared/domain.js";
import { getDb, schema } from "../db/index.js";

type ActorType = (typeof CHANGE_ACTOR_TYPES)[number];
type ProjectRole = "viewer" | "editor";

export interface Actor {
  email: string;
  orgId: string | null;
  actorType: ActorType;
}

const AGENT_CALLERS = new Set(["tool", "mcp", "webmcp", "a2a"]);

/** Identity comes only from the framework's trusted context, never from input. */
export function requireActor(ctx?: ActionRunContext): Actor {
  const email = ctx?.userEmail ?? getRequestUserEmail();
  if (!email) {
    fail("Sign in to continue.", {
      errorCode: "not_authenticated",
      statusCode: 401,
    });
  }
  const caller = ctx?.caller;
  return {
    email,
    orgId: ctx?.orgId ?? getRequestOrgId() ?? null,
    actorType:
      caller === "automation"
        ? "system"
        : caller && AGENT_CALLERS.has(caller)
          ? "agent"
          : "user",
  };
}

/** One answer for "missing" and "forbidden", so ids cannot be probed. */
function denyAccess(): never {
  fail("This project does not exist or you do not have the required access.", {
    errorCode: "access_denied",
    statusCode: 403,
  });
}

export async function authorizeProject(projectId: string, role: ProjectRole) {
  try {
    return await assertAccess("project", projectId, role);
  } catch (error) {
    if (error instanceof ForbiddenError) denyAccess();
    throw error;
  }
}

/**
 * SQL guard for the mutation statement itself. Use it in addition to the
 * caller-friendly authorization check so a revoked role cannot be used by a
 * row loaded before the write began.
 */
export function projectAccessWhere(projectId: string, role: ProjectRole) {
  return and(
    eq(schema.projects.id, projectId),
    accessFilter(schema.projects, schema.projectShares, undefined, role),
  );
}

export function projectAccessExists(projectId: string, role: ProjectRole) {
  return exists(
    getDb()
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(projectAccessWhere(projectId, role)),
  );
}

/** Child rows have no owner of their own: access follows their project. */
export async function authorizeMeeting(meetingId: string, role: ProjectRole) {
  const [meeting] = await getDb()
    .select()
    .from(schema.meetings)
    .where(eq(schema.meetings.id, meetingId))
    .limit(1);
  if (!meeting) denyAccess();
  await authorizeProject(meeting.projectId, role);
  return meeting;
}

export async function authorizeCommitment(
  commitmentId: string,
  role: ProjectRole,
) {
  const [commitment] = await getDb()
    .select()
    .from(schema.commitments)
    .where(eq(schema.commitments.id, commitmentId))
    .limit(1);
  if (!commitment) denyAccess();
  await authorizeProject(commitment.projectId, role);
  return commitment;
}
