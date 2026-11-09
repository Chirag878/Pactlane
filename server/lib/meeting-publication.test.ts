import type { ActionCaller } from "@agent-native/core/action";
import { getDbExec } from "@agent-native/core/db";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import createMeeting from "../../actions/create-meeting.js";
import createProject from "../../actions/create-project.js";
import getCommitmentHistory from "../../actions/get-commitment-history.js";
import getCommitmentLedger from "../../actions/get-commitment-ledger.js";
import getCommitmentTrail from "../../actions/get-commitment-trail.js";
import getMeeting from "../../actions/get-meeting.js";
import linkCommitmentEvidence from "../../actions/link-commitment-evidence.js";
import publishMeetingAnalysis from "../../actions/publish-meeting-analysis.js";
import saveAnalysis from "../../actions/save-analysis.js";
import updateCommitment from "../../actions/update-commitment.js";
import { getDb, schema } from "../db/index.js";
import { migrations } from "../db/migrations.js";

const OWNER = "publisher@example.test";
const VIEWER = "viewer@example.test";
const TRANSCRIPT = "Priya will prepare the launch plan by November 12, 2026.";

type RunnableAction = { run: (args: never, ctx?: never) => unknown };

function call<R>(
  action: RunnableAction,
  args: unknown,
  userEmail = OWNER,
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

const analysis = (meetingId: string) => ({
  meetingId,
  summary: "Priya committed to prepare the launch plan.",
  decisions: [],
  commitments: [
    {
      description: "Prepare the launch plan",
      ownerName: "Priya",
      ownerBasis: "explicit",
      dueDate: "2026-11-12",
      dueDateText: "November 12, 2026",
      dueDateBasis: "explicit",
      priority: null,
      evidence: [{ quote: TRANSCRIPT }],
      reviewNote: null,
    },
  ],
  openQuestions: [],
  blockers: [],
  nextMeeting: null,
});

async function setUp() {
  const project = await call<{ id: string }>(createProject, {
    name: `Publication ${crypto.randomUUID()}`,
    description: null,
  });
  const meeting = await call<{ id: string }>(createMeeting, {
    projectId: project.id,
    title: "Launch review",
    meetingDate: "2026-11-10",
    transcript: TRANSCRIPT,
  });
  await call(saveAnalysis, analysis(meeting.id), OWNER, "tool");
  await getDb().insert(schema.projectShares).values({
    id: crypto.randomUUID(),
    resourceId: project.id,
    principalType: "user",
    principalId: VIEWER,
    role: "viewer",
    createdBy: OWNER,
  });
  return { projectId: project.id, meetingId: meeting.id };
}

beforeAll(async () => {
  const exec = getDbExec();
  for (const { sql } of migrations) {
    for (const statement of (sql as string).split(/;\s*\n/)) {
      if (statement.trim()) await exec.execute(statement);
    }
  }
}, 60_000);

describe("meeting analysis publication", () => {
  it("keeps a new AI analysis private to editors across read surfaces", async () => {
    const { projectId, meetingId } = await setUp();

    const editor = await call<{
      analysisPublicationState: string;
      analysisVisible: boolean;
      summary: string | null;
      commitments: { id: string }[];
      canPublish: boolean;
    }>(getMeeting, { id: meetingId });
    expect(editor).toMatchObject({
      analysisPublicationState: "draft",
      analysisVisible: true,
      summary: "Priya committed to prepare the launch plan.",
      canPublish: true,
    });
    expect(editor.commitments).toHaveLength(1);

    const viewer = await call<{
      analysisSaved: boolean;
      analysisPublicationState: string;
      analysisContentRevision: number;
      analysisVisible: boolean;
      summary: string | null;
      commitments: unknown[];
      canPublish: boolean;
    }>(getMeeting, { id: meetingId }, VIEWER);
    expect(viewer).toMatchObject({
      analysisSaved: true,
      analysisPublicationState: "draft",
      analysisContentRevision: 0,
      analysisVisible: false,
      summary: null,
      commitments: [],
      canPublish: false,
    });

    const ledger = await call<{ entries: unknown[] }>(
      getCommitmentLedger,
      { projectId, asOf: "2026-11-13" },
      VIEWER,
    );
    expect(ledger.entries).toEqual([]);
    expect(
      await rejection(
        call(getCommitmentTrail, { id: editor.commitments[0]!.id }, VIEWER),
      ),
    ).toMatchObject({ errorCode: "access_denied" });
  });

  it("requires an authenticated editor in the signed-in UI, then publishes idempotently with history", async () => {
    const { projectId, meetingId } = await setUp();
    for (const caller of [
      "tool",
      "http",
      "cli",
      "mcp",
      "webmcp",
      "a2a",
      "automation",
      "mcp-widget",
      "mcp-widget-write",
    ] satisfies ActionCaller[]) {
      expect(
        await rejection(
          call(
            publishMeetingAnalysis,
            { meetingId, expectedContentRevision: 1 },
            OWNER,
            caller,
          ),
        ),
      ).toMatchObject({ errorCode: "ui_only_action" });
    }
    expect(
      await rejection(
        call(
          publishMeetingAnalysis,
          { meetingId, expectedContentRevision: 1 },
          VIEWER,
        ),
      ),
    ).toMatchObject({ errorCode: "access_denied" });

    const first = await call<{
      changed: boolean;
      analysisPublicationState: string;
      analysisPublishedBy: string | null;
      analysisPublishedAt: string | null;
    }>(publishMeetingAnalysis, { meetingId, expectedContentRevision: 1 });
    expect(first).toMatchObject({
      changed: true,
      analysisPublicationState: "published",
      analysisPublishedBy: OWNER,
    });
    expect(first.analysisPublishedAt).not.toBeNull();

    const second = await call<{ changed: boolean }>(publishMeetingAnalysis, {
      meetingId,
      expectedContentRevision: 1,
    });
    expect(second.changed).toBe(false);

    const viewer = await call<{
      analysisVisible: boolean;
      summary: string | null;
      commitments: unknown[];
    }>(getMeeting, { id: meetingId }, VIEWER);
    expect(viewer).toMatchObject({
      analysisVisible: true,
      summary: "Priya committed to prepare the launch plan.",
    });
    expect(viewer.commitments).toHaveLength(1);
    expect(
      (
        await call<{ entries: unknown[] }>(
          getCommitmentLedger,
          { projectId, asOf: "2026-11-13" },
          VIEWER,
        )
      ).entries,
    ).toHaveLength(1);

    const history = await getDb()
      .select()
      .from(schema.changes)
      .where(
        and(
          eq(schema.changes.projectId, projectId),
          eq(schema.changes.entityId, meetingId),
          eq(schema.changes.entityType, "meeting"),
        ),
      );
    expect(
      history.filter(
        (entry) => entry.afterState?.analysisPublicationState === "published",
      ),
    ).toHaveLength(1);
    expect(history.some((entry) => entry.actorId === OWNER)).toBe(true);
  });

  it("allows one concurrent publish and retracts a published analysis after a material commitment edit", async () => {
    const { meetingId } = await setUp();
    const results = await Promise.all([
      call<{ changed: boolean }>(publishMeetingAnalysis, {
        meetingId,
        expectedContentRevision: 1,
      }),
      call<{ changed: boolean }>(publishMeetingAnalysis, {
        meetingId,
        expectedContentRevision: 1,
      }),
    ]);
    expect(results.filter((result) => result.changed)).toHaveLength(1);

    const published = await call<{
      commitments: { id: string; version: number }[];
    }>(getMeeting, { id: meetingId });
    const evidenceBefore = await getDb()
      .select()
      .from(schema.commitmentEvidence)
      .where(
        eq(
          schema.commitmentEvidence.commitmentId,
          published.commitments[0]!.id,
        ),
      );
    await call(updateCommitment, {
      id: published.commitments[0]!.id,
      expectedVersion: published.commitments[0]!.version,
      priority: "high",
    });
    const after = await call<{
      analysisPublicationState: string;
      analysisVisible: boolean;
    }>(getMeeting, { id: meetingId });
    expect(after).toMatchObject({
      analysisPublicationState: "draft",
      analysisVisible: true,
    });
    const viewerAfter = await call<{
      analysisVisible: boolean;
      commitments: unknown[];
      summary: string | null;
    }>(getMeeting, { id: meetingId }, VIEWER);
    expect(viewerAfter).toMatchObject({
      analysisVisible: false,
      commitments: [],
      summary: null,
    });
    const evidenceAfter = await getDb()
      .select()
      .from(schema.commitmentEvidence)
      .where(
        eq(
          schema.commitmentEvidence.commitmentId,
          published.commitments[0]!.id,
        ),
      );
    expect(evidenceAfter).toEqual(evidenceBefore);
  });

  it("rejects the reviewed revision after an edit and after publication is retracted", async () => {
    const { meetingId } = await setUp();
    const reviewed = await call<{
      analysisContentRevision: number;
      commitments: { id: string; version: number }[];
    }>(getMeeting, { id: meetingId });

    await call(publishMeetingAnalysis, {
      meetingId,
      expectedContentRevision: reviewed.analysisContentRevision,
    });
    await call(updateCommitment, {
      id: reviewed.commitments[0]!.id,
      expectedVersion: reviewed.commitments[0]!.version,
      priority: "high",
    });

    const stale = await rejection(
      call(publishMeetingAnalysis, {
        meetingId,
        expectedContentRevision: reviewed.analysisContentRevision,
      }),
    );
    expect(stale).toMatchObject({
      errorCode: "analysis_revision_conflict",
      details: {
        currentContentRevision: reviewed.analysisContentRevision + 1,
      },
    });

    const current = await call<{
      analysisPublicationState: string;
      analysisContentRevision: number;
      analysisPublishedRevision: number | null;
    }>(getMeeting, { id: meetingId });
    expect(current).toMatchObject({
      analysisPublicationState: "draft",
      analysisContentRevision: reviewed.analysisContentRevision + 1,
      analysisPublishedRevision: null,
    });

    const republished = await call<{
      changed: boolean;
      analysisPublishedRevision: number | null;
    }>(publishMeetingAnalysis, {
      meetingId,
      expectedContentRevision: current.analysisContentRevision,
    });
    expect(republished).toMatchObject({
      changed: true,
      analysisPublishedRevision: current.analysisContentRevision,
    });
  });

  it("rejects an old reviewed revision when the edit commits before publication", async () => {
    const { meetingId } = await setUp();
    const reviewed = await call<{
      analysisContentRevision: number;
      commitments: { id: string; version: number }[];
    }>(getMeeting, { id: meetingId });
    await call(updateCommitment, {
      id: reviewed.commitments[0]!.id,
      expectedVersion: reviewed.commitments[0]!.version,
      dueDate: "2026-11-13",
    });

    expect(
      await rejection(
        call(publishMeetingAnalysis, {
          meetingId,
          expectedContentRevision: reviewed.analysisContentRevision,
        }),
      ),
    ).toMatchObject({ errorCode: "analysis_revision_conflict" });
  });

  it("hides evidence and audit activity linked from a draft meeting", async () => {
    const { projectId, meetingId } = await setUp();
    const published = await call<{
      analysisContentRevision: number;
      commitments: { id: string }[];
    }>(getMeeting, { id: meetingId });
    await call(publishMeetingAnalysis, {
      meetingId,
      expectedContentRevision: published.analysisContentRevision,
    });

    const followUpTranscript = "Priya said the launch plan is almost ready.";
    const followUp = await call<{ id: string }>(createMeeting, {
      projectId,
      title: "Private follow-up",
      meetingDate: "2026-11-11",
      transcript: followUpTranscript,
    });
    await call(
      saveAnalysis,
      {
        meetingId: followUp.id,
        summary: "Priya reported progress on the launch plan.",
        decisions: [],
        commitments: [],
        openQuestions: [],
        blockers: [],
        nextMeeting: null,
      },
      OWNER,
      "tool",
    );
    await call(linkCommitmentEvidence, {
      commitmentId: published.commitments[0]!.id,
      meetingId: followUp.id,
      quote: followUpTranscript,
      start: 0,
      end: followUpTranscript.length,
      asOf: "2026-11-13",
    });

    const revisedFollowUp = await call<{ analysisContentRevision: number }>(
      getMeeting,
      { id: followUp.id },
    );
    expect(revisedFollowUp.analysisContentRevision).toBe(2);
    expect(
      await rejection(
        call(publishMeetingAnalysis, {
          meetingId: followUp.id,
          expectedContentRevision: 1,
        }),
      ),
    ).toMatchObject({ errorCode: "analysis_revision_conflict" });

    const ledger = await call<{
      entries: { evidence: { total: number }; meetings: { id: string }[] }[];
    }>(getCommitmentLedger, { projectId, asOf: "2026-11-13" }, VIEWER);
    expect(ledger.entries[0]!.evidence.total).toBe(1);
    expect(ledger.entries[0]!.meetings.map((meeting) => meeting.id)).toEqual([
      meetingId,
    ]);

    const trail = await call<{
      events: { kind: string; meeting: { id: string } | null }[];
    }>(
      getCommitmentTrail,
      { id: published.commitments[0]!.id, asOf: "2026-11-13" },
      VIEWER,
    );
    expect(
      trail.events.some((event) => event.meeting?.id === followUp.id),
    ).toBe(false);

    const history = await call<{
      entries: { fields: { field: string }[] }[];
    }>(getCommitmentHistory, { id: published.commitments[0]!.id }, VIEWER);
    expect(
      history.entries.some((entry) =>
        entry.fields.some((field) => field.field === "link"),
      ),
    ).toBe(false);
  });
});
