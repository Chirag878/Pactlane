import { createHash } from "node:crypto";

import type { ActionCaller } from "@agent-native/core/action";
import { getDbExec } from "@agent-native/core/db";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { assertAccess } from "@agent-native/core/sharing";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import acceptInvitation from "../../actions/accept-organization-invitation.js";
import createMeeting from "../../actions/create-meeting.js";
import createOrganization from "../../actions/create-organization.js";
import createProject from "../../actions/create-project.js";
import getMeeting from "../../actions/get-meeting.js";
import getOrganization from "../../actions/get-organization.js";
import inviteMember from "../../actions/invite-organization-member.js";
import listMeetings from "../../actions/list-meetings.js";
import listMyOrganizations from "../../actions/list-my-organizations.js";
import listMembers from "../../actions/list-organization-members.js";
import listProjects from "../../actions/list-projects.js";
import publishMeetingAnalysis from "../../actions/publish-meeting-analysis.js";
import removeMember from "../../actions/remove-organization-member.js";
import revokeInvitation from "../../actions/revoke-organization-invitation.js";
import saveAnalysis from "../../actions/save-analysis.js";
import transferOwnership from "../../actions/transfer-organization-ownership.js";
import { getDb, schema } from "../db/index.js";
import { migrations } from "../db/migrations.js";

type RunnableAction = { run: (args: never, ctx?: never) => unknown };

/** Each identity is a separate signed-in request, as the dispatcher runs it. */
function call<R>(
  action: RunnableAction,
  args: unknown,
  userEmail: string,
  caller: ActionCaller = "frontend",
): Promise<R> {
  const ctx = { userEmail, orgId: null, caller };
  return Promise.resolve(
    runWithRequestContext({ userEmail }, () =>
      action.run(args as never, ctx as never),
    ),
  ) as Promise<R>;
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("Expected the action to fail.");
    },
    (error: { errorCode?: string; message: string }) => error,
  );

let counter = 0;
/** A fresh, unique identity per test so tests never share memberships. */
const person = (name: string) => `${name}-${++counter}@example.test`;

async function addUser(email: string, verified = true) {
  await getDbExec().execute({
    sql: 'INSERT INTO "user" (id, email, email_verified) VALUES (?, ?, ?)',
    args: [crypto.randomUUID(), email, verified],
  });
}

interface OrgResult {
  organization: { id: string; role: string; memberCount: number };
}

async function newOrganization(owner: string) {
  const { organization } = await call<OrgResult>(
    createOrganization,
    { name: "Acme", description: null },
    owner,
  );
  return organization.id;
}

async function invite(
  organizationId: string,
  by: string,
  email: string,
  role: "admin" | "member" = "member",
) {
  const result = await call<{ acceptPath: string; invitation: { id: string } }>(
    inviteMember,
    { organizationId, email, role },
    by,
  );
  const token = result.acceptPath.split("#token=")[1]!;
  return { token, invitationId: result.invitation.id };
}

/** Invites, then accepts as the recipient with a verified email. */
async function join(
  organizationId: string,
  by: string,
  email: string,
  role: "admin" | "member" = "member",
) {
  await addUser(email);
  const { token } = await invite(organizationId, by, email, role);
  await call(acceptInvitation, { token }, email);
}

async function orgProject(organizationId: string, owner: string) {
  const project = await call<{ id: string }>(
    createProject,
    { name: "Org project", description: null, organizationId },
    owner,
  );
  return project.id;
}

async function share(
  projectId: string,
  email: string,
  role: "viewer" | "editor",
  principalType: "user" | "org" = "user",
) {
  await getDb().insert(schema.projectShares).values({
    id: crypto.randomUUID(),
    resourceId: projectId,
    principalType,
    principalId: email,
    role,
    createdBy: "test",
  });
}

const TRANSCRIPT = "Priya will prepare the launch plan by November 12, 2026.";

async function meetingWithDraft(projectId: string, owner: string) {
  const meeting = await call<{ id: string }>(
    createMeeting,
    {
      projectId,
      title: "Launch review",
      meetingDate: "2026-11-10",
      transcript: TRANSCRIPT,
    },
    owner,
  );
  await call(
    saveAnalysis,
    {
      meetingId: meeting.id,
      summary: "Confidential draft summary.",
      decisions: [],
      commitments: [],
    },
    owner,
    "tool",
  );
  return meeting.id;
}

beforeAll(async () => {
  const exec = getDbExec();
  for (const { sql } of migrations) {
    for (const statement of (sql as string).split(/;\s*\n/)) {
      if (statement.trim()) await exec.execute(statement);
    }
  }
  // Better Auth's user table is not part of Pactlane's migrations. Only the
  // two columns the invitation check reads are needed here.
  await exec.execute(
    'CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, email_verified BOOLEAN NOT NULL DEFAULT false)',
  );
}, 60_000);

describe("organization creation", () => {
  it("makes the creator the only owner and lists the organization", async () => {
    const owner = person("owner");
    const id = await newOrganization(owner);
    const mine = await call<{ organizations: { id: string; role: string }[] }>(
      listMyOrganizations,
      {},
      owner,
    );
    expect(mine.organizations).toContainEqual(
      expect.objectContaining({ id, role: "owner", memberCount: 1 }),
    );
    const outsider = await call<{ organizations: unknown[] }>(
      listMyOrganizations,
      {},
      person("outsider"),
    );
    expect(outsider.organizations).toEqual([]);
  });

  it("refuses an agent caller for every administrative action", async () => {
    const owner = person("owner");
    const id = await newOrganization(owner);
    for (const [action, args] of [
      [createOrganization, { name: "Agent org", description: null }],
      [inviteMember, { organizationId: id, email: person("x") }],
      [removeMember, { organizationId: id, email: owner }],
      [transferOwnership, { organizationId: id, newOwnerEmail: person("y") }],
      [acceptInvitation, { token: "x".repeat(43) }],
      [revokeInvitation, { invitationId: "none" }],
      [createProject, { name: "P", description: null, organizationId: id }],
    ] as const) {
      // uiOnly actions are refused by the framework before they run; the
      // action's own human check is the second layer (and the only one for
      // create-project, which stays agent-callable for personal projects).
      const error = await rejection(
        call(action as RunnableAction, args, owner, "tool"),
      );
      expect(["ui_only_action", "human_action_required"]).toContain(
        error.errorCode,
      );
    }
  });
});

describe("membership integrity", () => {
  it("rejects a duplicate membership and a second owner at the database", async () => {
    const owner = person("owner");
    const id = await newOrganization(owner);
    const db = getDb();
    await expect(
      db.insert(schema.organizationMemberships).values({
        organizationId: id,
        email: owner,
        role: "member",
        addedBy: owner,
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(schema.organizationMemberships).values({
        organizationId: id,
        email: person("second"),
        role: "owner",
        addedBy: owner,
      }),
    ).rejects.toThrow();
  });

  it("does not let a duplicate invitation or an existing member be invited", async () => {
    const owner = person("owner");
    const member = person("member");
    const id = await newOrganization(owner);
    await join(id, owner, member);
    expect(
      await rejection(
        call(inviteMember, { organizationId: id, email: member }, owner),
      ),
    ).toMatchObject({ errorCode: "already_member" });
    const invitee = person("invitee");
    await invite(id, owner, invitee);
    expect(
      await rejection(
        call(inviteMember, { organizationId: id, email: invitee }, owner),
      ),
    ).toMatchObject({ errorCode: "invitation_pending" });
  });
});

describe("roles", () => {
  it("enforces owner, admin and member rights", async () => {
    const owner = person("owner");
    const admin = person("admin");
    const member = person("member");
    const id = await newOrganization(owner);
    await join(id, owner, admin, "admin");
    await join(id, owner, member);

    expect(
      await rejection(
        call(inviteMember, { organizationId: id, email: person("a") }, member),
      ),
    ).toMatchObject({ errorCode: "organization_role_required" });
    expect(
      await rejection(
        call(
          inviteMember,
          { organizationId: id, email: person("b"), role: "admin" },
          admin,
        ),
      ),
    ).toMatchObject({ errorCode: "organization_role_required" });
    await invite(id, admin, person("c"));

    const otherAdmin = person("admin2");
    await join(id, owner, otherAdmin, "admin");
    expect(
      await rejection(
        call(removeMember, { organizationId: id, email: otherAdmin }, admin),
      ),
    ).toMatchObject({ errorCode: "organization_role_required" });
    expect(
      await rejection(
        call(removeMember, { organizationId: id, email: admin }, member),
      ),
    ).toMatchObject({ errorCode: "organization_role_required" });
    expect(
      await rejection(
        call(
          createProject,
          { name: "P", description: null, organizationId: id },
          member,
        ),
      ),
    ).toMatchObject({ errorCode: "organization_role_required" });
    await orgProject(id, admin);

    const members = await call<{
      members: { email: string; canRemove: boolean }[];
      invitations: unknown[];
    }>(listMembers, { organizationId: id }, member);
    expect(members.invitations).toEqual([]);
    expect(
      members.members.filter((row) => row.canRemove).map((row) => row.email),
    ).toEqual([member]);

    await call(removeMember, { organizationId: id, email: member }, admin);
    await call(removeMember, { organizationId: id, email: otherAdmin }, owner);
  });

  it("refuses a non-member and a different organization's owner", async () => {
    const owner = person("owner");
    const otherOwner = person("other");
    const id = await newOrganization(owner);
    const otherId = await newOrganization(otherOwner);
    const { invitationId } = await invite(id, owner, person("invitee"));

    for (const attempt of [
      () =>
        call(
          inviteMember,
          { organizationId: id, email: person("z") },
          otherOwner,
        ),
      () => call(getOrganization, { organizationId: id }, otherOwner),
      () => call(listMembers, { organizationId: id }, otherOwner),
      () => call(revokeInvitation, { invitationId }, otherOwner),
      () =>
        call(removeMember, { organizationId: id, email: owner }, otherOwner),
      () =>
        call(
          createProject,
          { name: "P", description: null, organizationId: id },
          otherOwner,
        ),
      () => call(getOrganization, { organizationId: "missing" }, otherOwner),
    ]) {
      expect(await rejection(attempt())).toMatchObject({
        errorCode: "organization_access_denied",
      });
    }
    // Each organization's own owner is unaffected.
    await call(getOrganization, { organizationId: otherId }, otherOwner);
  });
});

describe("invitations", () => {
  it("stores only a hash of the token and binds it to the recipient", async () => {
    const owner = person("owner");
    const recipient = person("recipient");
    const intruder = person("intruder");
    const id = await newOrganization(owner);
    await addUser(recipient);
    await addUser(intruder);
    const { token, invitationId } = await invite(id, owner, recipient);

    const [row] = await getDb()
      .select()
      .from(schema.organizationInvitations)
      .where(eq(schema.organizationInvitations.id, invitationId));
    expect(row!.tokenHash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(JSON.stringify(row)).not.toContain(token);
    expect(token.length).toBeGreaterThanOrEqual(43);

    // The link alone is not enough: another signed-in account is refused.
    expect(
      await rejection(call(acceptInvitation, { token }, intruder)),
    ).toMatchObject({ errorCode: "invitation_recipient_mismatch" });
    expect(
      await rejection(call(getOrganization, { organizationId: id }, intruder)),
    ).toMatchObject({ errorCode: "organization_access_denied" });

    const accepted = await call<OrgResult>(
      acceptInvitation,
      { token },
      recipient.toUpperCase(),
    );
    expect(accepted.organization).toMatchObject({ id, role: "member" });
  });

  it("refuses an unverified or unknown email identity", async () => {
    const owner = person("owner");
    const unverified = person("unverified");
    const unknown = person("unknown");
    const id = await newOrganization(owner);
    await addUser(unverified, false);
    const first = await invite(id, owner, unverified);
    const second = await invite(id, owner, unknown);
    for (const [token, email] of [
      [first.token, unverified],
      [second.token, unknown],
    ]) {
      expect(
        await rejection(call(acceptInvitation, { token }, email!)),
      ).toMatchObject({ errorCode: "email_not_verified" });
    }
  });

  it("is single-use, expires, and stops working when revoked", async () => {
    const owner = person("owner");
    const id = await newOrganization(owner);

    const used = person("used");
    await addUser(used);
    const once = await invite(id, owner, used);
    await call(acceptInvitation, { token: once.token }, used);
    expect(
      await rejection(call(acceptInvitation, { token: once.token }, used)),
    ).toMatchObject({ errorCode: "invitation_unavailable" });

    const late = person("late");
    await addUser(late);
    const expiring = await invite(id, owner, late);
    await getDb()
      .update(schema.organizationInvitations)
      .set({
        createdAt: new Date(Date.now() - 9 * 86_400_000),
        expiresAt: new Date(Date.now() - 2 * 86_400_000),
      })
      .where(eq(schema.organizationInvitations.id, expiring.invitationId));
    expect(
      await rejection(call(acceptInvitation, { token: expiring.token }, late)),
    ).toMatchObject({ errorCode: "invitation_unavailable" });
    // An expired invitation does not block a fresh one.
    await invite(id, owner, late);

    const revoked = person("revoked");
    await addUser(revoked);
    const pending = await invite(id, owner, revoked);
    const result = await call<{ changed: boolean }>(
      revokeInvitation,
      { invitationId: pending.invitationId },
      owner,
    );
    expect(result.changed).toBe(true);
    expect(
      await rejection(
        call(acceptInvitation, { token: pending.token }, revoked),
      ),
    ).toMatchObject({ errorCode: "invitation_unavailable" });
    expect(
      await rejection(
        call(
          acceptInvitation,
          { token: "not-a-real-token-at-all-000" },
          revoked,
        ),
      ),
    ).toMatchObject({ errorCode: "invitation_invalid" });
  });

  it("lets only one of two concurrent acceptances succeed", async () => {
    const owner = person("owner");
    const recipient = person("racer");
    const id = await newOrganization(owner);
    await addUser(recipient);
    const { token } = await invite(id, owner, recipient);
    const results = await Promise.allSettled([
      call(acceptInvitation, { token }, recipient),
      call(acceptInvitation, { token }, recipient),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rows = await getDb()
      .select()
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, id),
          eq(schema.organizationMemberships.email, recipient),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("invalidates an invitation whose sender lost the right to invite", async () => {
    const owner = person("owner");
    const admin = person("admin");
    const recipient = person("recipient");
    const id = await newOrganization(owner);
    await join(id, owner, admin, "admin");
    await addUser(recipient);
    const { token } = await invite(id, admin, recipient);
    await call(removeMember, { organizationId: id, email: admin }, owner);
    expect(
      await rejection(call(acceptInvitation, { token }, recipient)),
    ).toMatchObject({ errorCode: "invitation_unavailable" });
  });
});

describe("removal and ownership", () => {
  it("protects the only owner and transfers ownership explicitly", async () => {
    const owner = person("owner");
    const admin = person("admin");
    const id = await newOrganization(owner);
    await join(id, owner, admin, "admin");

    for (const by of [owner, admin]) {
      expect(
        await rejection(
          call(removeMember, { organizationId: id, email: owner }, by),
        ),
      ).toMatchObject({ errorCode: "final_owner" });
    }
    expect(
      await rejection(
        call(
          transferOwnership,
          { organizationId: id, newOwnerEmail: owner },
          admin,
        ),
      ),
    ).toMatchObject({ errorCode: "organization_role_required" });

    await call(
      transferOwnership,
      { organizationId: id, newOwnerEmail: admin },
      owner,
    );
    const owners = await getDb()
      .select({ email: schema.organizationMemberships.email })
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, id),
          eq(schema.organizationMemberships.role, "owner"),
        ),
      );
    expect(owners).toEqual([{ email: admin }]);
    // The former owner, now an admin, may leave.
    await call(removeMember, { organizationId: id, email: owner }, owner);
  });

  it("revokes organization-project access on removal while keeping history and shares", async () => {
    const owner = person("owner");
    const member = person("member");
    const id = await newOrganization(owner);
    await join(id, owner, member);
    const projectId = await orgProject(id, owner);
    await share(projectId, member, "editor");
    const meetingId = await meetingWithDraft(projectId, owner);

    await call(getMeeting, { id: meetingId }, member);
    await call(removeMember, { organizationId: id, email: member }, owner);

    for (const attempt of [
      () => call(getMeeting, { id: meetingId }, member),
      () => call(listMeetings, { projectId }, member),
      () =>
        call(
          createMeeting,
          {
            projectId,
            title: "After removal",
            meetingDate: "2026-11-11",
            transcript: TRANSCRIPT,
          },
          member,
        ),
    ]) {
      expect(await rejection(attempt())).toMatchObject({
        errorCode: "access_denied",
      });
    }
    const listed = await call<{ projects: { id: string }[] }>(
      listProjects,
      {},
      member,
    );
    expect(listed.projects.map((p) => p.id)).not.toContain(projectId);
    // The framework's own access check agrees.
    await expect(
      runWithRequestContext({ userEmail: member }, () =>
        assertAccess("project", projectId, "viewer"),
      ),
    ).rejects.toThrow();

    const shares = await getDb()
      .select()
      .from(schema.projectShares)
      .where(eq(schema.projectShares.resourceId, projectId));
    expect(shares).toHaveLength(1);
    const meetings = await getDb()
      .select()
      .from(schema.meetings)
      .where(eq(schema.meetings.projectId, projectId));
    expect(meetings).toHaveLength(1);
  });
});

describe("project access inside an organization", () => {
  it("shows organization projects only to their owner and explicit shares", async () => {
    const owner = person("owner");
    const admin = person("admin");
    const member = person("member");
    const id = await newOrganization(owner);
    await join(id, owner, admin, "admin");
    await join(id, owner, member);
    const adminProject = await orgProject(id, admin);

    // Organization roles never open a private project, owner included.
    for (const email of [owner, member]) {
      const org = await call<{ projects: { id: string }[] }>(
        getOrganization,
        { organizationId: id },
        email,
      );
      expect(org.projects.map((p) => p.id)).not.toContain(adminProject);
      expect(
        await rejection(call(listMeetings, { projectId: adminProject }, email)),
      ).toMatchObject({ errorCode: "access_denied" });
    }

    await share(adminProject, member, "viewer");
    const visible = await call<{ projects: { id: string }[] }>(
      getOrganization,
      { organizationId: id },
      member,
    );
    expect(visible.projects.map((p) => p.id)).toEqual([adminProject]);
    const listed = await call<{
      projects: { id: string; organizationId: string | null }[];
    }>(listProjects, {}, member);
    expect(listed.projects).toContainEqual(
      expect.objectContaining({ id: adminProject, organizationId: id }),
    );
  });

  it("ignores shares to non-members, organization principals and wider visibility", async () => {
    const owner = person("owner");
    const member = person("member");
    const outsider = person("outsider");
    const id = await newOrganization(owner);
    await join(id, owner, member);
    const projectId = await orgProject(id, owner);

    await share(projectId, outsider, "editor");
    await share(projectId, "framework-org-id", "viewer", "org");
    await getDb()
      .update(schema.projects)
      .set({ visibility: "org", orgId: "framework-org-id" })
      .where(eq(schema.projects.id, projectId));

    for (const email of [outsider, member]) {
      expect(
        await rejection(call(listMeetings, { projectId }, email)),
      ).toMatchObject({ errorCode: "access_denied" });
    }
    const listed = await call<{ projects: { id: string }[] }>(
      listProjects,
      {},
      outsider,
    );
    expect(listed.projects.map((p) => p.id)).not.toContain(projectId);
  });

  it("keeps personal projects working without any organization", async () => {
    const owner = person("solo");
    const viewer = person("viewer");
    const project = await call<{ id: string; organizationId: string | null }>(
      createProject,
      { name: "Personal", description: null },
      owner,
    );
    expect(project.organizationId).toBeNull();
    await share(project.id, viewer, "viewer");
    await call(listMeetings, { projectId: project.id }, viewer);
    const listed = await call<{
      projects: { id: string; organizationId: string | null }[];
    }>(listProjects, {}, owner);
    expect(listed.projects).toContainEqual(
      expect.objectContaining({ id: project.id, organizationId: null }),
    );
  });
});

describe("drafts and publication inside an organization", () => {
  it("hides a draft from a viewer and lets only an editor share publish", async () => {
    const owner = person("owner");
    const admin = person("admin");
    const viewer = person("viewer");
    const editor = person("editor");
    const id = await newOrganization(owner);
    await join(id, owner, admin, "admin");
    await join(id, owner, viewer);
    await join(id, owner, editor);
    const projectId = await orgProject(id, owner);
    await share(projectId, viewer, "viewer");
    await share(projectId, editor, "editor");
    const meetingId = await meetingWithDraft(projectId, owner);

    const seen = await call<{
      analysisVisible: boolean;
      summary: string | null;
    }>(getMeeting, { id: meetingId }, viewer);
    expect(seen).toMatchObject({ analysisVisible: false, summary: null });
    const { analysisContentRevision: revision } = await call<{
      analysisContentRevision: number;
    }>(getMeeting, { id: meetingId }, editor);

    // An organization admin with no project share cannot publish.
    for (const email of [viewer, admin]) {
      expect(
        await rejection(
          call(
            publishMeetingAnalysis,
            { meetingId, expectedContentRevision: revision },
            email,
          ),
        ),
      ).toMatchObject({ errorCode: "access_denied" });
    }
    const published = await call<{ analysisPublicationState: string }>(
      publishMeetingAnalysis,
      { meetingId, expectedContentRevision: revision },
      editor,
    );
    expect(published.analysisPublicationState).toBe("published");
    const after = await call<{ summary: string | null }>(
      getMeeting,
      { id: meetingId },
      viewer,
    );
    expect(after.summary).toBe("Confidential draft summary.");
  });
});

describe("authorization changes during concurrent operations", () => {
  it("never lets a write land after the member was removed", async () => {
    const owner = person("owner");
    const member = person("member");
    const id = await newOrganization(owner);
    await join(id, owner, member);
    const projectId = await orgProject(id, owner);
    await share(projectId, member, "editor");

    const [removal, write] = await Promise.allSettled([
      call(removeMember, { organizationId: id, email: member }, owner),
      call<{ id: string }>(
        createMeeting,
        {
          projectId,
          title: "Racing write",
          meetingDate: "2026-11-11",
          transcript: TRANSCRIPT,
        },
        member,
      ),
    ]);
    expect(removal.status).toBe("fulfilled");
    const [membership] = await getDb()
      .select()
      .from(schema.organizationMemberships)
      .where(
        and(
          eq(schema.organizationMemberships.organizationId, id),
          eq(schema.organizationMemberships.email, member),
        ),
      );
    const meetings = await getDb()
      .select()
      .from(schema.meetings)
      .where(eq(schema.meetings.projectId, projectId));
    if (write.status === "fulfilled") {
      // Allowed only if it committed while the membership was still active.
      expect(meetings[0]!.createdAt.getTime()).toBeLessThanOrEqual(
        membership!.removedAt!.getTime(),
      );
    } else {
      expect(meetings).toHaveLength(0);
    }
    // Afterwards nothing more can be written.
    expect(
      await rejection(
        call(
          createMeeting,
          {
            projectId,
            title: "Later",
            meetingDate: "2026-11-12",
            transcript: TRANSCRIPT,
          },
          member,
        ),
      ),
    ).toMatchObject({ errorCode: "access_denied" });
  });

  it("serializes a demotion against an invitation the demoted admin sends", async () => {
    const owner = person("owner");
    const admin = person("admin");
    const id = await newOrganization(owner);
    await join(id, owner, admin, "admin");
    const recipient = person("late");
    const [removal, invited] = await Promise.allSettled([
      call(removeMember, { organizationId: id, email: admin }, owner),
      call(inviteMember, { organizationId: id, email: recipient }, admin),
    ]);
    expect(removal.status).toBe("fulfilled");
    if (invited.status === "fulfilled") {
      // The invitation committed first; it cannot be accepted any more.
      await addUser(recipient);
      const token = (invited.value as { acceptPath: string }).acceptPath.split(
        "#token=",
      )[1]!;
      expect(
        await rejection(call(acceptInvitation, { token }, recipient)),
      ).toMatchObject({ errorCode: "invitation_unavailable" });
    } else {
      expect(invited.reason).toMatchObject({
        errorCode: "organization_access_denied",
      });
    }
  });
});
