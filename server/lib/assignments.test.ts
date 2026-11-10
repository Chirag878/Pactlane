import type { ActionCaller } from "@agent-native/core/action";
import { getDbExec } from "@agent-native/core/db";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { beforeAll, describe, expect, it } from "vitest";

import acceptInvitation from "../../actions/accept-organization-invitation.js";
import createMeeting from "../../actions/create-meeting.js";
import createOrganization from "../../actions/create-organization.js";
import createProject from "../../actions/create-project.js";
import inviteMember from "../../actions/invite-organization-member.js";
import getAssignmentOptions from "../../actions/get-assignment-options.js";
import listMyAssignments from "../../actions/list-my-assignments.js";
import publishMeetingAnalysis from "../../actions/publish-meeting-analysis.js";
import removeOrgMember from "../../actions/remove-organization-member.js";
import reviewCommitment from "../../actions/review-commitment.js";
import saveAnalysis from "../../actions/save-analysis.js";
import sendAssignment from "../../actions/send-assignment.js";
import updateAssignment from "../../actions/update-assignment.js";
import { eq } from "drizzle-orm";
import { getDb, schema } from "../db/index.js";
import { migrations } from "../db/migrations.js";

type RunnableAction = { run: (args: never, ctx?: never) => unknown };

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
const person = (name: string) => `${name}-${++counter}@example.test`;

async function addUser(email: string, verified = true) {
  await getDbExec().execute({
    sql: 'INSERT INTO "user" (id, email, email_verified) VALUES (?, ?, ?)',
    args: [crypto.randomUUID(), email, verified],
  });
}

async function newOrganization(owner: string) {
  const result = await call<{ organization: { id: string } }>(
    createOrganization,
    { name: "Acme", description: null },
    owner,
  );
  return result.organization.id;
}

async function join(organizationId: string, by: string, email: string) {
  await addUser(email);
  const invited = await call<{ acceptPath: string }>(
    inviteMember,
    { organizationId, email, role: "member" },
    by,
  );
  const token = invited.acceptPath.split("#token=")[1]!;
  await call(acceptInvitation, { token }, email);
}

async function share(
  projectId: string,
  email: string,
  role: "viewer" | "editor",
) {
  await getDb().insert(schema.projectShares).values({
    id: crypto.randomUUID(),
    resourceId: projectId,
    principalType: "user",
    principalId: email,
    role,
    createdBy: "test",
  });
}

const TRANSCRIPT = "Yara will prepare the dashboard interface by Friday.";

async function analysis(meetingId: string) {
  return {
    meetingId,
    summary: "Yara committed to the dashboard interface.",
    decisions: [],
    commitments: [
      {
        description: "Prepare the dashboard interface",
        ownerName: "Yara",
        ownerBasis: "explicit" as const,
        dueDate: null,
        dueDateText: null,
        dueDateBasis: null,
        priority: null,
        evidence: [{ quote: TRANSCRIPT }],
        reviewNote: null,
      },
    ],
    openQuestions: [],
    blockers: [],
    nextMeeting: null,
  };
}

beforeAll(async () => {
  const exec = getDbExec();
  for (const { sql } of migrations) {
    for (const statement of (sql as string).split(/;\s*\n/)) {
      if (statement.trim()) await exec.execute(statement);
    }
  }
  await exec.execute(
    'CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, email_verified BOOLEAN NOT NULL DEFAULT false)',
  );
}, 60_000);

describe("assignment handoff", () => {
  it("runs the secure end-to-end lifecycle", async () => {
    const owner = person("owner");
    const recipient = person("teammate");
    await addUser(owner);
    const orgId = await newOrganization(owner);
    await join(orgId, owner, recipient);
    const project = await call<{ id: string }>(
      createProject,
      { name: "Org project", description: null, organizationId: orgId },
      owner,
    );
    await share(project.id, recipient, "viewer");

    const meeting = await call<{ id: string }>(
      createMeeting,
      {
        projectId: project.id,
        title: "Planning",
        meetingDate: "2026-11-10",
        transcript: TRANSCRIPT,
      },
      owner,
    );
    const saved = await call<{ commitments: { id: string; reviewFlags: { code: string }[] }[] }>(
      saveAnalysis,
      await analysis(meeting.id),
      owner,
      "tool",
    );
    const commitmentId = saved.commitments[0]!.id;
    const flags = saved.commitments[0]!.reviewFlags.map((flag) => flag.code);
    await call(
      reviewCommitment,
      {
        id: commitmentId,
        expectedVersion: 1,
        outcome: "confirm",
        resolveFlags: flags,
      },
      owner,
    );
    const [row] = await getDb()
      .select({ revision: schema.meetings.analysisContentRevision })
      .from(schema.meetings)
      .where(eq(schema.meetings.id, meeting.id));
    await call(publishMeetingAnalysis, { meetingId: meeting.id, expectedContentRevision: row!.revision }, owner);
    const options = await call<{
      members: { email: string; hasAccount: boolean; hasProjectAccess: boolean }[];
      activeAssignment: null;
    }>(getAssignmentOptions, { commitmentId }, owner);
    expect(options.members.find((member) => member.email === recipient)).toMatchObject({
      hasAccount: true,
      hasProjectAccess: true,
    });
    const sent = await call<{ assignment: { id: string; status: string; version: number } }>(
      sendAssignment,
      { commitmentId, recipientEmail: recipient },
      owner,
    );
    expect(sent.assignment.status).toBe("pending");
    await expect(
      rejection(call(sendAssignment, { commitmentId, recipientEmail: recipient }, owner)),
    ).resolves.toMatchObject({ errorCode: "assignment_already_active" });

    const mine = await call<{ assignments: { id: string; status: string }[] }>(
      listMyAssignments,
      {},
      recipient,
    );
    expect(mine.assignments.map((assignment) => assignment.id)).toContain(sent.assignment.id);

    const accepted = await call<{ assignment: { status: string; version: number } }>(
      updateAssignment,
      { assignmentId: sent.assignment.id, expectedVersion: 1, status: "accepted", note: null },
      recipient,
    );
    expect(accepted.assignment.status).toBe("accepted");
    const progressed = await call<{ assignment: { status: string } }>(
      updateAssignment,
      { assignmentId: sent.assignment.id, expectedVersion: 2, status: "in_progress", note: null },
      recipient,
    );
    expect(progressed.assignment.status).toBe("in_progress");
    const done = await call<{ assignment: { status: string } }>(
      updateAssignment,
      { assignmentId: sent.assignment.id, expectedVersion: 3, status: "completed", note: null },
      recipient,
    );
    expect(done.assignment.status).toBe("completed");
  });
  it("requires a confirmed commitment and a published meeting", async () => {
    const owner = person("owner");
    const recipient = person("teammate");
    await addUser(owner);
    const orgId = await newOrganization(owner);
    await join(orgId, owner, recipient);
    const project = await call<{ id: string }>(
      createProject,
      { name: "Org project", description: null, organizationId: orgId },
      owner,
    );
    await share(project.id, recipient, "viewer");
    const meeting = await call<{ id: string }>(
      createMeeting,
      { projectId: project.id, title: "Planning", meetingDate: "2026-11-10", transcript: TRANSCRIPT },
      owner,
    );
    const saved = await call<{ commitments: { id: string; reviewFlags: { code: string }[] }[] }>(
      saveAnalysis,
      await analysis(meeting.id),
      owner,
      "tool",
    );
    const commitmentId = saved.commitments[0]!.id;
    await expect(
      rejection(call(sendAssignment, { commitmentId, recipientEmail: recipient }, owner)),
    ).resolves.toMatchObject({ errorCode: "commitment_confirmation_required" });
    const flags = saved.commitments[0]!.reviewFlags.map((flag) => flag.code);
    await call(reviewCommitment, { id: commitmentId, expectedVersion: 1, outcome: "confirm", resolveFlags: flags }, owner);
    await expect(
      rejection(call(sendAssignment, { commitmentId, recipientEmail: recipient }, owner)),
    ).resolves.toMatchObject({ errorCode: "published_meeting_required" });
  });
  it("requires recipient project access and a verified account", async () => {
    const owner = person("owner");
    const outsider = person("outsider");
    const unverified = person("unverified");
    await addUser(owner);
    const orgId = await newOrganization(owner);
    await join(orgId, owner, outsider);
    await join(orgId, owner, unverified);
    await getDbExec().execute({
      sql: 'UPDATE "user" SET email_verified = false WHERE email = ?',
      args: [unverified],
    });
    const project = await call<{ id: string }>(
      createProject,
      { name: "Org project", description: null, organizationId: orgId },
      owner,
    );
    const meeting = await call<{ id: string }>(
      createMeeting,
      { projectId: project.id, title: "Planning", meetingDate: "2026-11-10", transcript: TRANSCRIPT },
      owner,
    );
    const saved = await call<{ commitments: { id: string; reviewFlags: { code: string }[] }[] }>(
      saveAnalysis,
      await analysis(meeting.id),
      owner,
      "tool",
    );
    const commitmentId = saved.commitments[0]!.id;
    await call(reviewCommitment, { id: commitmentId, expectedVersion: 1, outcome: "confirm", resolveFlags: saved.commitments[0]!.reviewFlags.map((flag) => flag.code) }, owner);
    const [row] = await getDb().select({ revision: schema.meetings.analysisContentRevision }).from(schema.meetings).where(eq(schema.meetings.id, meeting.id));
    await call(publishMeetingAnalysis, { meetingId: meeting.id, expectedContentRevision: row!.revision }, owner);
    await expect(
      rejection(call(sendAssignment, { commitmentId, recipientEmail: outsider }, owner)),
    ).resolves.toMatchObject({ errorCode: "recipient_project_access_required" });
    await share(project.id, unverified, "viewer");
    await expect(
      rejection(call(sendAssignment, { commitmentId, recipientEmail: unverified }, owner)),
    ).resolves.toMatchObject({ errorCode: "recipient_account_required" });
  });
  it("refuses personal projects and agent callers", async () => {
    const owner = person("owner");
    await addUser(owner);
    const project = await call<{ id: string }>(createProject, { name: "Personal", description: null }, owner);
    const meeting = await call<{ id: string }>(
      createMeeting,
      { projectId: project.id, title: "Planning", meetingDate: "2026-11-10", transcript: TRANSCRIPT },
      owner,
    );
    const saved = await call<{ commitments: { id: string }[] }>(saveAnalysis, await analysis(meeting.id), owner, "tool");
    await expect(
      rejection(call(sendAssignment, { commitmentId: saved.commitments[0]!.id, recipientEmail: owner }, owner)),
    ).resolves.toMatchObject({ errorCode: "organization_project_required" });
    expect(sendAssignment as unknown as { uiOnly?: boolean; agentTool?: boolean }).toMatchObject({ uiOnly: true, agentTool: false });
    expect(updateAssignment as unknown as { uiOnly?: boolean; agentTool?: boolean }).toMatchObject({ uiOnly: true, agentTool: false });
    await expect(rejection(call(sendAssignment, { commitmentId: "x", recipientEmail: owner }, owner, "tool"))).resolves.toMatchObject({ errorCode: expect.stringMatching(/human_action_required|ui_only_action/) });
    await expect(rejection(call(updateAssignment, { assignmentId: "x", expectedVersion: 1, status: "accepted", note: null }, owner, "tool"))).resolves.toMatchObject({ errorCode: expect.stringMatching(/human_action_required|ui_only_action/) });
  });
  it("enforces recipient acknowledgement and version safety", async () => {
    const owner = person("owner");
    const recipient = person("teammate");
    await addUser(owner);
    const orgId = await newOrganization(owner);
    await join(orgId, owner, recipient);
    const project = await call<{ id: string }>(
      createProject,
      { name: "Org project", description: null, organizationId: orgId },
      owner,
    );
    await share(project.id, recipient, "viewer");
    const meeting = await call<{ id: string }>(
      createMeeting,
      { projectId: project.id, title: "Planning", meetingDate: "2026-11-10", transcript: TRANSCRIPT },
      owner,
    );
    const saved = await call<{ commitments: { id: string; reviewFlags: { code: string }[] }[] }>(
      saveAnalysis,
      await analysis(meeting.id),
      owner,
      "tool",
    );
    const commitmentId = saved.commitments[0]!.id;
    await call(reviewCommitment, { id: commitmentId, expectedVersion: 1, outcome: "confirm", resolveFlags: saved.commitments[0]!.reviewFlags.map((flag) => flag.code) }, owner);
    const [row] = await getDb().select({ revision: schema.meetings.analysisContentRevision }).from(schema.meetings).where(eq(schema.meetings.id, meeting.id));
    await call(publishMeetingAnalysis, { meetingId: meeting.id, expectedContentRevision: row!.revision }, owner);
    const sent = await call<{ assignment: { id: string; version: number } }>(sendAssignment, { commitmentId, recipientEmail: recipient }, owner);
    await expect(
      rejection(call(updateAssignment, { assignmentId: sent.assignment.id, expectedVersion: 1, status: "accepted", note: null }, owner)),
    ).resolves.toMatchObject({ errorCode: "recipient_acknowledgement_required" });
    await expect(
      rejection(call(updateAssignment, { assignmentId: sent.assignment.id, expectedVersion: 1, status: "disputed", note: null }, recipient)),
    ).resolves.toMatchObject({ errorCode: "dispute_reason_required" });
    await expect(
      rejection(call(updateAssignment, { assignmentId: sent.assignment.id, expectedVersion: 1, status: "completed", note: null }, recipient)),
    ).resolves.toMatchObject({ errorCode: "assignment_transition_invalid" });
    await call(updateAssignment, { assignmentId: sent.assignment.id, expectedVersion: 1, status: "accepted", note: null }, recipient);
    await expect(
      rejection(call(updateAssignment, { assignmentId: sent.assignment.id, expectedVersion: 1, status: "completed", note: null }, recipient)),
    ).resolves.toMatchObject({ errorCode: "assignment_version_conflict" });
  });
  it("prevents concurrent duplicate deliveries", async () => {
    const owner = person("owner");
    const recipient = person("teammate");
    await addUser(owner);
    const orgId = await newOrganization(owner);
    await join(orgId, owner, recipient);
    const project = await call<{ id: string }>(
      createProject,
      { name: "Org project", description: null, organizationId: orgId },
      owner,
    );
    await share(project.id, recipient, "viewer");
    const meeting = await call<{ id: string }>(
      createMeeting,
      { projectId: project.id, title: "Planning", meetingDate: "2026-11-10", transcript: TRANSCRIPT },
      owner,
    );
    const saved = await call<{ commitments: { id: string; reviewFlags: { code: string }[] }[] }>(
      saveAnalysis,
      await analysis(meeting.id),
      owner,
      "tool",
    );
    const commitmentId = saved.commitments[0]!.id;
    await call(reviewCommitment, { id: commitmentId, expectedVersion: 1, outcome: "confirm", resolveFlags: saved.commitments[0]!.reviewFlags.map((flag) => flag.code) }, owner);
    const [row] = await getDb().select({ revision: schema.meetings.analysisContentRevision }).from(schema.meetings).where(eq(schema.meetings.id, meeting.id));
    await call(publishMeetingAnalysis, { meetingId: meeting.id, expectedContentRevision: row!.revision }, owner);
    const attempts = await Promise.allSettled([
      call(sendAssignment, { commitmentId, recipientEmail: recipient }, owner),
      call(sendAssignment, { commitmentId, recipientEmail: recipient }, owner),
    ]);
    const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
    const rejected = attempts.filter((attempt) => attempt.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ errorCode: "assignment_already_active" });
  });
  it("isolates organizations and revokes access on removal", async () => {
    const ownerA = person("ownerA");
    const memberA = person("memberA");
    const ownerB = person("ownerB");
    await addUser(ownerA);
    await addUser(ownerB);
    const orgA = await newOrganization(ownerA);
    await join(orgA, ownerA, memberA);
    await newOrganization(ownerB);
    const projectA = await call<{ id: string }>(
      createProject,
      { name: "Org A project", description: null, organizationId: orgA },
      ownerA,
    );
    await share(projectA.id, memberA, "viewer");
    const meeting = await call<{ id: string }>(
      createMeeting,
      { projectId: projectA.id, title: "Planning", meetingDate: "2026-11-10", transcript: TRANSCRIPT },
      ownerA,
    );
    const saved = await call<{ commitments: { id: string; reviewFlags: { code: string }[] }[] }>(
      saveAnalysis,
      await analysis(meeting.id),
      ownerA,
      "tool",
    );
    const commitmentId = saved.commitments[0]!.id;
    await call(reviewCommitment, { id: commitmentId, expectedVersion: 1, outcome: "confirm", resolveFlags: saved.commitments[0]!.reviewFlags.map((flag) => flag.code) }, ownerA);
    const [row] = await getDb().select({ revision: schema.meetings.analysisContentRevision }).from(schema.meetings).where(eq(schema.meetings.id, meeting.id));
    await call(publishMeetingAnalysis, { meetingId: meeting.id, expectedContentRevision: row!.revision }, ownerA);
    const sent = await call<{ assignment: { id: string } }>(sendAssignment, { commitmentId, recipientEmail: memberA }, ownerA);
    const stranger = await call<{ assignments: unknown[] }>(listMyAssignments, {}, ownerB);
    expect(stranger.assignments).toEqual([]);
    await expect(
      rejection(call(updateAssignment, { assignmentId: sent.assignment.id, expectedVersion: 1, status: "accepted", note: null }, ownerB)),
    ).resolves.toMatchObject({ errorCode: "access_denied" });
    await call(removeOrgMember, { organizationId: orgA, email: memberA }, ownerA);
    const afterRemoval = await call<{ assignments: unknown[] }>(listMyAssignments, {}, memberA);
    expect(afterRemoval.assignments).toEqual([]);
    // Removal revokes access but never deletes the project or its history.
    const [keptProject] = await getDb().select().from(schema.projects).where(eq(schema.projects.id, projectA.id));
    expect(keptProject).toBeDefined();
    const keptShares = await getDb().select().from(schema.projectShares).where(eq(schema.projectShares.resourceId, projectA.id));
    expect(keptShares.length).toBeGreaterThan(0);
    await expect(
      rejection(call(updateAssignment, { assignmentId: sent.assignment.id, expectedVersion: 1, status: "accepted", note: null }, memberA)),
    ).resolves.toMatchObject({ errorCode: "access_denied" });
  });
});
