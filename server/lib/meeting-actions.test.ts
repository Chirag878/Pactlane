import { createHash } from "node:crypto";

import type { ActionCaller } from "@agent-native/core/action";
import { getDbExec } from "@agent-native/core/db";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import createMeeting from "../../actions/create-meeting.js";
import createProject from "../../actions/create-project.js";
import getMeeting from "../../actions/get-meeting.js";
import listMeetings from "../../actions/list-meetings.js";
import listProjects from "../../actions/list-projects.js";
import saveAnalysis from "../../actions/save-analysis.js";
import { getDb, schema } from "../db/index.js";
import { migrations } from "../db/migrations.js";

const OWNER = "owner@example.test";
const OTHER = "other@example.test";

const TRANSCRIPT =
  "Priya will finish the landing page by Friday. Aarav will prepare the presentation. We agreed to demonstrate the product next week, but we haven't decided who will lead the demo.";

type RunnableAction = {
  run: (args: never, ctx?: never) => unknown;
};

/** Calls an action the way the dispatcher does: inside a request identity. */
function call<R>(
  action: RunnableAction,
  args: unknown,
  userEmail: string | undefined = OWNER,
  caller: ActionCaller = "frontend",
): Promise<R> {
  const ctx = { userEmail, orgId: null, caller };
  return Promise.resolve(
    runWithRequestContext({ userEmail }, () =>
      action.run(args as never, ctx as never),
    ),
  ) as Promise<R>;
}

interface Row {
  id: string;
}
interface Evidence {
  sourceQuote: string;
  sourceStart: number | null;
  sourceEnd: number | null;
  verificationStatus: string;
}
interface MeetingOutput {
  id: string;
  summary: string | null;
  processingStatus: string;
  analysisSaved: boolean;
  replayed?: boolean;
  transcript: string;
  decisions: {
    description: string;
    needsReview: boolean;
    reviewReason: string | null;
    evidence: Evidence[];
  }[];
  commitments: {
    description: string;
    ownerId: string | null;
    ownerDisplayName: string | null;
    statedOwnerName: string | null;
    dueDate: string | null;
    statedDueText: string | null;
    needsReview: boolean;
    reviewReason: string | null;
    evidence: Evidence[];
  }[];
  openQuestions: FindingOutput[];
  blockers: FindingOutput[];
  nextMeeting: {
    id: string;
    proposedDate: string | null;
    statedDateText: string | null;
    dateBasis: string | null;
    proposedTime: string | null;
    statedTimeText: string | null;
    participants: string[];
    purpose: string | null;
    unknowns: string[];
    needsReview: boolean;
    reviewReason: string | null;
    evidence: Evidence[];
  } | null;
}

interface FindingOutput {
  id: string;
  kind: "open_question" | "blocker";
  description: string;
  needsReview: boolean;
  reviewReason: string | null;
  evidence: Evidence[];
}

const newProject = (userEmail = OWNER) =>
  call<Row>(createProject, { name: "Launch", description: null }, userEmail);

const newMeeting = (projectId: string, transcript = TRANSCRIPT) =>
  call<Row>(createMeeting, {
    projectId,
    title: "Weekly sync",
    meetingDate: "2026-11-02",
    transcript,
  });

const commitment = (overrides: Record<string, unknown> = {}) => ({
  description: "Prepare the presentation",
  ownerName: "Aarav",
  ownerBasis: "explicit",
  dueDate: null,
  dueDateText: null,
  dueDateBasis: null,
  priority: null,
  evidence: [{ quote: "Aarav will prepare the presentation." }],
  reviewNote: null,
  ...overrides,
});

const productTestAnalysis = (meetingId: string) => ({
  meetingId,
  summary: "Landing page and presentation are assigned; demo lead is open.",
  decisions: [
    {
      description: "Demonstrate the product next week",
      evidence: [{ quote: "We agreed to demonstrate the product next week" }],
      reviewNote: null,
    },
  ],
  commitments: [
    commitment({
      description: "Finish the landing page",
      ownerName: "Priya",
      dueDate: "2026-11-06",
      dueDateText: "by Friday",
      dueDateBasis: "inferred",
      evidence: [{ quote: "Priya will finish the landing page by Friday." }],
    }),
    commitment(),
    commitment({
      description: "Lead the demo",
      ownerName: null,
      ownerBasis: null,
      evidence: [{ quote: "we haven't decided who will lead the demo" }],
    }),
  ],
});

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("Expected the action to fail.");
    },
    (error: { errorCode?: string; statusCode?: number; message: string }) =>
      error,
  );

const countFor = async (table: "commitments" | "decisions", id: string) => {
  const db = getDb();
  if (table === "commitments") {
    return (
      await db
        .select()
        .from(schema.commitments)
        .where(eq(schema.commitments.originMeetingId, id))
    ).length;
  }
  return (
    await db
      .select()
      .from(schema.decisions)
      .where(eq(schema.decisions.meetingId, id))
  ).length;
};

beforeAll(async () => {
  const exec = getDbExec();
  for (const { sql } of migrations) {
    for (const statement of (sql as string).split(/;\s*\n/)) {
      if (statement.trim()) await exec.execute(statement);
    }
  }
}, 60_000);

describe("create-project", () => {
  it("creates a project owned by the signed-in user", async () => {
    const project = await newProject();
    const [row] = await getDb()
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.id, project.id));
    expect(row).toMatchObject({ ownerEmail: OWNER, visibility: "private" });
  });

  it("records who created it, from trusted context", async () => {
    const project = await call<Row>(
      createProject,
      { name: "Via agent", description: null },
      OWNER,
      "tool",
    );
    const [change] = await getDb()
      .select()
      .from(schema.changes)
      .where(eq(schema.changes.entityId, project.id));
    expect(change).toMatchObject({ actorType: "agent", actorId: OWNER });
  });

  it("refuses a client-supplied owner", async () => {
    await expect(
      call(createProject, {
        name: "Spoof",
        description: null,
        ownerEmail: OTHER,
      }),
    ).rejects.toThrow();
  });

  it.each([
    [{ name: "   ", description: null }],
    [{ description: null }],
    [{ name: 42, description: null }],
  ])("rejects malformed input %j", async (input) => {
    await expect(call(createProject, input)).rejects.toThrow();
  });

  it("requires a signed-in user", async () => {
    const error = await rejection(
      runWithRequestContext({}, () =>
        createProject.run(
          { name: "Nobody", description: null },
          { orgId: null, caller: "frontend" },
        ),
      ) as Promise<unknown>,
    );
    expect(error).toMatchObject({
      errorCode: "not_authenticated",
      statusCode: 401,
    });
  });
});

describe("create-meeting", () => {
  it("stores the transcript exactly as given", async () => {
    const project = await newProject();
    const raw = "  Line one.\r\n\tLine two.  ";
    const meeting = await newMeeting(project.id, raw);
    const read = await call<MeetingOutput>(getMeeting, { id: meeting.id });
    expect(read.transcript).toBe(raw);
    expect(read.processingStatus).toBe("pending");
  });

  it.each([
    [{ title: "T", meetingDate: "2026-11-02", transcript: "   " }],
    [{ title: "", meetingDate: "2026-11-02", transcript: "text" }],
    [{ title: "T", meetingDate: "2026-13-45", transcript: "text" }],
    [{ title: "T", meetingDate: "next Friday", transcript: "text" }],
    [{ title: "T", meetingDate: "2026-11-02" }],
  ])("rejects malformed input %j", async (input) => {
    const project = await newProject();
    await expect(
      call(createMeeting, { projectId: project.id, ...input }),
    ).rejects.toThrow();
  });
});

describe("project access", () => {
  it("does not let another user create a meeting in the project", async () => {
    const project = await newProject();
    const error = await rejection(
      call(
        createMeeting,
        {
          projectId: project.id,
          title: "Intrusion",
          meetingDate: "2026-11-02",
          transcript: "text",
        },
        OTHER,
      ),
    );
    expect(error).toMatchObject({
      errorCode: "access_denied",
      statusCode: 403,
    });
  });

  it("does not let another user read a meeting or its project", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id);
    for (const attempt of [
      call(getMeeting, { id: meeting.id }, OTHER),
      call(listMeetings, { projectId: project.id }, OTHER),
    ]) {
      expect(await rejection(attempt)).toMatchObject({
        errorCode: "access_denied",
      });
    }
  });

  it("gives the same answer for a missing id and a forbidden one", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id);
    const forbidden = await rejection(
      call(getMeeting, { id: meeting.id }, OTHER),
    );
    const missing = await rejection(call(getMeeting, { id: "nope" }, OTHER));
    expect(missing.message).toBe(forbidden.message);
    expect(missing.statusCode).toBe(forbidden.statusCode);
  });

  it("lists only the caller's projects", async () => {
    const mine = await newProject(OWNER);
    const theirs = await newProject(OTHER);
    const { projects } = await call<{ projects: Row[] }>(
      listProjects,
      {},
      OTHER,
    );
    const ids = projects.map((p) => p.id);
    expect(ids).toContain(theirs.id);
    expect(ids).not.toContain(mine.id);
  });

  it("does not let another user save analysis", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id);
    const error = await rejection(
      call(saveAnalysis, productTestAnalysis(meeting.id), OTHER),
    );
    expect(error).toMatchObject({ errorCode: "access_denied" });
    expect(await countFor("commitments", meeting.id)).toBe(0);
  });

  it("does not let a viewer write", async () => {
    const project = await newProject();
    await getDb().insert(schema.projectShares).values({
      id: crypto.randomUUID(),
      resourceId: project.id,
      principalType: "user",
      principalId: OTHER,
      role: "viewer",
      createdBy: OWNER,
    });
    const meeting = await newMeeting(project.id);
    await expect(
      call(getMeeting, { id: meeting.id }, OTHER),
    ).resolves.toBeDefined();
    const error = await rejection(
      call(saveAnalysis, productTestAnalysis(meeting.id), OTHER),
    );
    expect(error).toMatchObject({ errorCode: "access_denied" });
  });

  it("keeps a meeting in the project it was created in", async () => {
    const first = await newProject();
    const second = await newProject();
    const meetingA = await newMeeting(first.id);
    const meetingB = await newMeeting(second.id);
    const listed = await call<{ meetings: Row[] }>(listMeetings, {
      projectId: first.id,
    });
    const ids = listed.meetings.map((m) => m.id);
    expect(ids).toContain(meetingA.id);
    expect(ids).not.toContain(meetingB.id);
  });

  it("blocks a commitment owned by another project's person", async () => {
    const first = await newProject();
    const second = await newProject();
    const meeting = await newMeeting(first.id);
    const [foreign] = await getDb()
      .insert(schema.people)
      .values({ projectId: second.id, displayName: "Aarav" })
      .returning();
    const saved = await call<MeetingOutput>(
      saveAnalysis,
      productTestAnalysis(meeting.id),
    );
    expect(saved.commitments.map((c) => c.ownerId)).not.toContain(foreign!.id);
  });
});

describe("save-analysis: the product test", () => {
  it("saves commitments and decisions without inventing anything", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id);
    await call(saveAnalysis, productTestAnalysis(meeting.id), OWNER, "tool");
    const read = await call<MeetingOutput>(getMeeting, { id: meeting.id });

    expect(read.processingStatus).toBe("processed");
    expect(read.analysisSaved).toBe(true);
    expect(read.summary).toContain("demo lead is open");
    expect(read.decisions.map((d) => d.description)).toEqual([
      "Demonstrate the product next week",
    ]);
    expect(read.commitments.map((c) => c.description)).toEqual([
      "Finish the landing page",
      "Prepare the presentation",
      "Lead the demo",
    ]);

    const [priya, aarav, lead] = read.commitments;
    expect(priya).toMatchObject({
      statedOwnerName: "Priya",
      statedDueText: "by Friday",
      dueDate: "2026-11-06",
      needsReview: true,
    });
    expect(priya!.reviewReason).toContain('interpreted from "by Friday"');

    expect(aarav).toMatchObject({
      statedOwnerName: "Aarav",
      dueDate: null,
      statedDueText: null,
      needsReview: false,
      reviewReason: null,
    });

    expect(lead).toMatchObject({
      ownerId: null,
      statedOwnerName: null,
      dueDate: null,
      needsReview: true,
    });
    expect(lead!.reviewReason).toContain("No owner was stated");
  });

  it("stores only offsets that point at the original words", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id);
    const saved = await call<MeetingOutput>(
      saveAnalysis,
      productTestAnalysis(meeting.id),
    );
    const evidence = [...saved.commitments, ...saved.decisions].flatMap(
      (item) => item.evidence,
    );
    expect(evidence.length).toBeGreaterThan(0);
    for (const e of evidence) {
      expect(e.verificationStatus).toBe("verified");
      expect(TRANSCRIPT.slice(e.sourceStart!, e.sourceEnd!)).toBe(
        e.sourceQuote,
      );
    }
  });

  it("records every created record against the agent", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id);
    const saved = await call<MeetingOutput & { commitments: Row[] }>(
      saveAnalysis,
      productTestAnalysis(meeting.id),
      OWNER,
      "tool",
    );
    const changes = await getDb()
      .select()
      .from(schema.changes)
      .where(eq(schema.changes.projectId, project.id));
    const forCommitment = changes.find(
      (c) => c.entityId === saved.commitments[0]!.id,
    );
    expect(forCommitment).toMatchObject({
      entityType: "commitment",
      operation: "create",
      actorType: "agent",
      actorId: OWNER,
    });
    expect(changes.some((c) => c.entityType === "decision")).toBe(true);
    expect(changes.some((c) => c.entityType === "evidence")).toBe(true);
  });
});

describe("save-analysis: evidence verification", () => {
  const saveOne = async (
    overrides: Record<string, unknown>,
    transcript = TRANSCRIPT,
  ) => {
    const project = await newProject();
    const meeting = await newMeeting(project.id, transcript);
    const saved = await call<MeetingOutput>(saveAnalysis, {
      meetingId: meeting.id,
      summary: "Summary.",
      decisions: [],
      commitments: [commitment(overrides)],
    });
    return saved.commitments[0]!;
  };

  it("never accepts a fabricated quotation as verified", async () => {
    const saved = await saveOne({
      description: "Own the deployment",
      ownerName: "Meera",
      evidence: [{ quote: "Meera owns the deployment" }],
    });
    expect(saved.evidence[0]).toMatchObject({
      sourceQuote: "Meera owns the deployment",
      verificationStatus: "missing",
      sourceStart: null,
    });
    expect(saved).toMatchObject({
      ownerId: null,
      statedOwnerName: null,
      needsReview: true,
    });
    expect(saved.reviewReason).toContain("not found in the transcript");
    expect(saved.reviewReason).toContain('Proposed owner "Meera"');
  });

  it("treats a tidied quote as missing", async () => {
    const saved = await saveOne({
      evidence: [{ quote: "aarav will prepare the presentation." }],
    });
    expect(saved.evidence[0]!.verificationStatus).toBe("missing");
  });

  it("marks a repeated quote ambiguous until offsets resolve it", async () => {
    const transcript = "Aarav will ship it. Later, Aarav will ship it.";
    const quote = "Aarav will ship it.";
    const ambiguous = await saveOne({ evidence: [{ quote }] }, transcript);
    expect(ambiguous.evidence[0]!.verificationStatus).toBe("ambiguous");
    expect(ambiguous.needsReview).toBe(true);

    const start = transcript.lastIndexOf(quote);
    const resolved = await saveOne(
      { evidence: [{ quote, start, end: start + quote.length }] },
      transcript,
    );
    expect(resolved.evidence[0]).toMatchObject({
      verificationStatus: "verified",
      sourceStart: start,
    });
  });

  it("rejects offsets that point at different text", async () => {
    const saved = await saveOne({
      evidence: [
        {
          quote: "Aarav will prepare the presentation.",
          start: 0,
          end: 36,
        },
      ],
    });
    expect(saved.evidence[0]!.verificationStatus).toBe("missing");
  });

  it("does not take a status from the caller", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id);
    await expect(
      call(saveAnalysis, {
        meetingId: meeting.id,
        summary: "Summary.",
        decisions: [],
        commitments: [
          commitment({
            evidence: [
              { quote: "Made up words", verificationStatus: "verified" },
            ],
          }),
        ],
      }),
    ).rejects.toThrow();
  });

  it("flags a commitment with no quotation", async () => {
    const saved = await saveOne({ evidence: [] });
    expect(saved.needsReview).toBe(true);
    expect(saved.statedOwnerName).toBeNull();
    expect(saved.reviewReason).toContain("No supporting quotation");
  });
});

describe("save-analysis: summary-first meeting intelligence", () => {
  const intelligenceTranscript =
    "Priya: We still need to decide who leads the demo. Meera: Deployment is blocked until security review. Team: Let's meet again on November 14, 2026 at 10:30 with Priya and Aarav to rehearse the demo.";

  it("persists verified questions, blockers, and a reviewable next meeting", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id, intelligenceTranscript);
    const saved = await call<MeetingOutput>(saveAnalysis, {
      meetingId: meeting.id,
      summary: "The demo lead is unresolved and deployment awaits review.",
      decisions: [],
      commitments: [],
      openQuestions: [
        {
          description: "Who will lead the demo?",
          evidence: [{ quote: "We still need to decide who leads the demo." }],
          reviewNote: null,
        },
      ],
      blockers: [
        {
          description: "Deployment is waiting for security review",
          evidence: [{ quote: "Deployment is blocked until security review." }],
          reviewNote: null,
        },
      ],
      nextMeeting: {
        proposedDate: "2026-11-14",
        dateText: "November 14, 2026",
        dateBasis: "explicit",
        proposedTime: "10:30",
        timeText: "10:30",
        participants: ["Priya", "Aarav"],
        purpose: "Rehearse the demo",
        unknowns: [],
        evidence: [
          {
            quote:
              "Let's meet again on November 14, 2026 at 10:30 with Priya and Aarav to rehearse the demo.",
          },
        ],
        reviewNote: null,
      },
    });

    expect(saved.openQuestions).toHaveLength(1);
    expect(saved.blockers).toHaveLength(1);
    expect(saved.openQuestions[0]).toMatchObject({
      kind: "open_question",
      needsReview: false,
    });
    expect(saved.blockers[0]).toMatchObject({
      kind: "blocker",
      needsReview: false,
    });
    expect(saved.nextMeeting).toMatchObject({
      proposedDate: "2026-11-14",
      statedDateText: "November 14, 2026",
      proposedTime: "10:30",
      statedTimeText: "10:30",
      participants: ["Priya", "Aarav"],
      purpose: "Rehearse the demo",
      needsReview: false,
    });

    const evidence = [
      ...saved.openQuestions[0]!.evidence,
      ...saved.blockers[0]!.evidence,
      ...saved.nextMeeting!.evidence,
    ];
    expect(
      evidence.every((item) => item.verificationStatus === "verified"),
    ).toBe(true);

    const changes = await getDb()
      .select()
      .from(schema.changes)
      .where(eq(schema.changes.projectId, project.id));
    expect(changes.some((change) => change.entityType === "finding")).toBe(
      true,
    );
    expect(changes.some((change) => change.entityType === "next_meeting")).toBe(
      true,
    );
  });

  it("drops unsupported scheduling claims and flags unresolved dates", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id, intelligenceTranscript);
    const saved = await call<MeetingOutput>(saveAnalysis, {
      meetingId: meeting.id,
      summary: "A follow-up was discussed.",
      decisions: [],
      commitments: [],
      nextMeeting: {
        proposedDate: "2026-11-15",
        dateText: "November 15, 2026",
        dateBasis: "explicit",
        proposedTime: null,
        timeText: null,
        participants: ["Jordan"],
        purpose: "Rehearse the demo",
        unknowns: ["Final room"],
        evidence: [
          {
            quote:
              "Let's meet again on November 14, 2026 at 10:30 with Priya and Aarav to rehearse the demo.",
          },
        ],
        reviewNote: null,
      },
    });

    expect(saved.nextMeeting).toMatchObject({
      proposedDate: null,
      statedDateText: null,
      participants: [],
      needsReview: true,
    });
    expect(saved.nextMeeting!.reviewReason).toContain("not supported");
    expect(saved.nextMeeting!.reviewReason).toContain("Jordan");
  });

  it("keeps a stated but unresolved next-meeting date unknown", async () => {
    const transcript = "Team: Let's meet again next week.";
    const project = await newProject();
    const meeting = await newMeeting(project.id, transcript);
    const saved = await call<MeetingOutput>(saveAnalysis, {
      meetingId: meeting.id,
      summary: "A follow-up was proposed for next week.",
      decisions: [],
      commitments: [],
      nextMeeting: {
        proposedDate: null,
        dateText: "next week",
        dateBasis: null,
        proposedTime: null,
        timeText: null,
        participants: [],
        purpose: null,
        unknowns: ["Calendar date", "Time", "Participants"],
        evidence: [{ quote: "Let's meet again next week." }],
        reviewNote: null,
      },
    });

    expect(saved.nextMeeting).toMatchObject({
      proposedDate: null,
      statedDateText: "next week",
      dateBasis: null,
      needsReview: true,
    });
    expect(saved.nextMeeting!.reviewReason).toContain("no calendar date");
  });

  it("rejects scheduling values that disagree with the quoted wording", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id, intelligenceTranscript);
    const saved = await call<MeetingOutput>(saveAnalysis, {
      meetingId: meeting.id,
      summary: "A follow-up was proposed.",
      decisions: [],
      commitments: [],
      nextMeeting: {
        proposedDate: "2026-11-15",
        dateText: "November 14, 2026",
        dateBasis: "explicit",
        proposedTime: "11:30",
        timeText: "10:30",
        participants: [],
        purpose: "Rehearse the demo",
        unknowns: [],
        evidence: [
          {
            quote:
              "Let's meet again on November 14, 2026 at 10:30 with Priya and Aarav to rehearse the demo.",
          },
        ],
        reviewNote: null,
      },
    });

    expect(saved.nextMeeting).toMatchObject({
      proposedDate: null,
      statedDateText: "November 14, 2026",
      dateBasis: null,
      proposedTime: null,
      statedTimeText: "10:30",
      needsReview: true,
    });
    expect(saved.nextMeeting!.reviewReason).toContain("does not match");
  });

  it("leaves a relative suggested date unresolved", async () => {
    const transcript = "Team: Let's meet again next week.";
    const project = await newProject();
    const meeting = await newMeeting(project.id, transcript);
    const saved = await call<MeetingOutput>(saveAnalysis, {
      meetingId: meeting.id,
      summary: "A follow-up was proposed for next week.",
      decisions: [],
      commitments: [],
      nextMeeting: {
        proposedDate: "2026-11-16",
        dateText: "next week",
        dateBasis: "inferred",
        proposedTime: null,
        timeText: null,
        participants: [],
        purpose: null,
        unknowns: ["Calendar date", "Time", "Participants"],
        evidence: [{ quote: "Let's meet again next week." }],
        reviewNote: null,
      },
    });

    expect(saved.nextMeeting).toMatchObject({
      proposedDate: null,
      statedDateText: "next week",
      dateBasis: null,
      needsReview: true,
    });
    expect(saved.nextMeeting!.reviewReason).toContain("remains unresolved");
  });

  it("keeps older analyzed meetings with no summary compatible", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id);
    await getDb()
      .update(schema.meetings)
      .set({
        analysisHash: "legacy-analysis-hash",
        processingStatus: "processed",
        summary: null,
      })
      .where(eq(schema.meetings.id, meeting.id));

    const read = await call<MeetingOutput>(getMeeting, { id: meeting.id });
    expect(read).toMatchObject({
      analysisSaved: true,
      summary: null,
      openQuestions: [],
      blockers: [],
      nextMeeting: null,
    });
  });

  it("does not duplicate new structured results on an identical retry", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id, intelligenceTranscript);
    const analysis = {
      meetingId: meeting.id,
      summary: "The demo lead remains open.",
      decisions: [],
      commitments: [],
      openQuestions: [
        {
          description: "Who will lead the demo?",
          evidence: [{ quote: "We still need to decide who leads the demo." }],
          reviewNote: null,
        },
      ],
      blockers: [],
      nextMeeting: null,
    };

    await call<MeetingOutput>(saveAnalysis, analysis);
    const replay = await call<MeetingOutput>(saveAnalysis, analysis);
    const findings = await getDb()
      .select()
      .from(schema.meetingFindings)
      .where(eq(schema.meetingFindings.meetingId, meeting.id));
    const suggestions = await getDb()
      .select()
      .from(schema.nextMeetingSuggestions)
      .where(eq(schema.nextMeetingSuggestions.meetingId, meeting.id));

    expect(replay.replayed).toBe(true);
    expect(findings).toHaveLength(1);
    expect(suggestions).toHaveLength(0);
  });

  it("keeps the pre-upgrade hash so an already-saved meeting still replays", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id, intelligenceTranscript);
    // The exact serialization older versions hashed: no new fields.
    const legacyHash = createHash("sha256")
      .update(
        JSON.stringify({
          meetingId: meeting.id,
          summary: "Older analysis.",
          decisions: [],
          commitments: [],
        }),
      )
      .digest("hex");

    // An older caller omits every new field and gets that same hash.
    const legacyInput = {
      meetingId: meeting.id,
      summary: "Older analysis.",
      decisions: [],
      commitments: [],
    };
    const first = await call<MeetingOutput>(saveAnalysis, legacyInput);
    const [stored] = await getDb()
      .select({ hash: schema.meetings.analysisHash })
      .from(schema.meetings)
      .where(eq(schema.meetings.id, meeting.id));
    expect(first.replayed).toBe(false);
    expect(stored!.hash).toBe(legacyHash);

    // A meeting saved before the upgrade has only the old hash on record.
    const preUpgrade = await newMeeting(project.id, intelligenceTranscript);
    const preUpgradeHash = createHash("sha256")
      .update(
        JSON.stringify({
          meetingId: preUpgrade.id,
          summary: "Older analysis.",
          decisions: [],
          commitments: [],
        }),
      )
      .digest("hex");
    await getDb()
      .update(schema.meetings)
      .set({
        analysisHash: preUpgradeHash,
        processingStatus: "processed",
        summary: "Older analysis.",
      })
      .where(eq(schema.meetings.id, preUpgrade.id));

    const same = await call<MeetingOutput>(saveAnalysis, {
      ...legacyInput,
      meetingId: preUpgrade.id,
    });
    const explicitEmpty = await call<MeetingOutput>(saveAnalysis, {
      ...legacyInput,
      meetingId: preUpgrade.id,
      openQuestions: [],
      blockers: [],
      nextMeeting: null,
    });
    expect(same.replayed).toBe(true);
    expect(explicitEmpty.replayed).toBe(true);

    // Adding new findings is a different analysis and must not be merged in.
    const error = await rejection(
      call(saveAnalysis, {
        ...legacyInput,
        meetingId: preUpgrade.id,
        blockers: [
          {
            description: "Deployment is waiting for security review",
            evidence: [
              { quote: "Deployment is blocked until security review." },
            ],
            reviewNote: null,
          },
        ],
      }),
    );
    expect(error).toMatchObject({
      errorCode: "analysis_already_saved",
      statusCode: 409,
    });
    const read = await call<MeetingOutput>(getMeeting, { id: preUpgrade.id });
    expect(read).toMatchObject({
      summary: "Older analysis.",
      blockers: [],
      openQuestions: [],
      nextMeeting: null,
    });
  });

  it("flags findings and suggestions whose evidence is missing or absent", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id, intelligenceTranscript);
    const saved = await call<MeetingOutput>(saveAnalysis, {
      meetingId: meeting.id,
      summary: "Questions were raised.",
      decisions: [],
      commitments: [],
      openQuestions: [
        {
          description: "Who owns the budget?",
          evidence: [{ quote: "Who owns the budget for the demo?" }],
          reviewNote: null,
        },
      ],
      blockers: [
        {
          description: "A vendor delay",
          evidence: [],
          reviewNote: null,
        },
      ],
      nextMeeting: {
        proposedDate: "2026-11-14",
        dateText: "November 14, 2026",
        dateBasis: "explicit",
        proposedTime: null,
        timeText: null,
        participants: [],
        purpose: null,
        unknowns: [],
        evidence: [],
        reviewNote: null,
      },
    });

    expect(saved.openQuestions[0]).toMatchObject({ needsReview: true });
    expect(saved.openQuestions[0]!.evidence[0]!.verificationStatus).toBe(
      "missing",
    );
    expect(saved.openQuestions[0]!.reviewReason).toContain(
      "not found in the transcript",
    );
    expect(saved.blockers[0]).toMatchObject({
      needsReview: true,
      evidence: [],
    });
    expect(saved.blockers[0]!.reviewReason).toContain(
      "No supporting quotation",
    );
    // A date that no verified quotation contains is not kept.
    expect(saved.nextMeeting).toMatchObject({
      proposedDate: null,
      statedDateText: null,
      needsReview: true,
    });
    expect(saved.nextMeeting!.reviewReason).toContain(
      "No supporting quotation",
    );
  });

  it("does not expose a summary or findings to a user without access", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id, intelligenceTranscript);
    const analysis = {
      meetingId: meeting.id,
      summary: "Confidential summary text.",
      decisions: [],
      commitments: [],
      openQuestions: [
        {
          description: "Who will lead the demo?",
          evidence: [{ quote: "We still need to decide who leads the demo." }],
          reviewNote: null,
        },
      ],
      blockers: [],
      nextMeeting: null,
    };
    await call(saveAnalysis, analysis);

    const denied = await rejection(call(getMeeting, { id: meeting.id }, OTHER));
    expect(denied).toMatchObject({ errorCode: "access_denied" });
    expect(JSON.stringify(denied)).not.toContain("Confidential");

    // Replaying the identical analysis as another user must not reveal it either.
    const deniedReplay = await rejection(call(saveAnalysis, analysis, OTHER));
    expect(deniedReplay).toMatchObject({ errorCode: "access_denied" });
    expect(JSON.stringify(deniedReplay)).not.toContain("Confidential");
  });
});

describe("save-analysis: owners and deadlines", () => {
  const saveWith = async (
    overrides: Record<string, unknown>,
    people: { displayName: string; aliases?: string[] }[] = [],
    transcript = TRANSCRIPT,
  ) => {
    const project = await newProject();
    if (people.length > 0) {
      await getDb()
        .insert(schema.people)
        .values(people.map((p) => ({ ...p, projectId: project.id })));
    }
    const meeting = await newMeeting(project.id, transcript);
    const saved = await call<MeetingOutput>(saveAnalysis, {
      meetingId: meeting.id,
      summary: "Summary.",
      decisions: [],
      commitments: [commitment(overrides)],
    });
    return saved.commitments[0]!;
  };

  it("keeps a missing owner and deadline empty", async () => {
    const saved = await saveWith({
      ownerName: null,
      ownerBasis: null,
    });
    expect(saved).toMatchObject({
      ownerId: null,
      statedOwnerName: null,
      dueDate: null,
      statedDueText: null,
    });
  });

  it("links an explicit owner to an existing person", async () => {
    const saved = await saveWith({}, [
      { displayName: "Aarav Shah", aliases: ["Aarav"] },
    ]);
    expect(saved.ownerId).not.toBeNull();
    expect(saved.ownerDisplayName).toBe("Aarav Shah");
    expect(saved.needsReview).toBe(false);
  });

  it("does not create a person for a name it cannot link", async () => {
    const before = await getDb().select().from(schema.people);
    const saved = await saveWith({});
    expect(saved).toMatchObject({ ownerId: null, statedOwnerName: "Aarav" });
    expect(await getDb().select().from(schema.people)).toHaveLength(
      before.length,
    );
  });

  it("leaves an alias shared by two people unassigned", async () => {
    const saved = await saveWith({}, [
      { displayName: "Aarav Shah", aliases: ["Aarav"] },
      { displayName: "Aarav Rao", aliases: ["Aarav"] },
    ]);
    expect(saved.ownerId).toBeNull();
    expect(saved.needsReview).toBe(true);
    expect(saved.reviewReason).toContain("more than one person");
  });

  it("does not assign an inferred owner", async () => {
    const saved = await saveWith({ ownerBasis: "inferred" }, [
      { displayName: "Aarav" },
    ]);
    expect(saved).toMatchObject({
      ownerId: null,
      statedOwnerName: null,
      needsReview: true,
    });
    expect(saved.reviewReason).toContain("inferred");
  });

  it("drops a deadline the evidence does not contain", async () => {
    const saved = await saveWith({
      dueDate: "2026-11-20",
      dueDateText: "by November 20",
      dueDateBasis: "explicit",
    });
    expect(saved).toMatchObject({
      dueDate: null,
      statedDueText: null,
      needsReview: true,
    });
  });

  it("flags a relative date even when labelled explicit", async () => {
    const saved = await saveWith({
      ownerName: "Priya",
      description: "Finish the landing page",
      dueDate: "2026-11-06",
      dueDateText: "by Friday",
      dueDateBasis: "explicit",
      evidence: [{ quote: "Priya will finish the landing page by Friday." }],
    });
    expect(saved.needsReview).toBe(true);
    expect(saved.reviewReason).toContain("interpreted");
  });

  it("accepts a stated calendar date without review", async () => {
    const saved = await saveWith(
      {
        ownerName: "Priya",
        description: "Ship",
        dueDate: "2026-11-20",
        dueDateText: "on 20 November 2026",
        dueDateBasis: "explicit",
        evidence: [{ quote: "Priya will ship on 20 November 2026." }],
      },
      [],
      "Priya will ship on 20 November 2026.",
    );
    expect(saved).toMatchObject({ dueDate: "2026-11-20", needsReview: false });
  });

  it.each([
    [{ ownerName: "Aarav", ownerBasis: null }],
    [{ ownerName: null, ownerBasis: "explicit" }],
    [{ dueDate: "2026-11-06", dueDateText: null, dueDateBasis: "inferred" }],
    [{ dueDate: "not-a-date", dueDateText: "x", dueDateBasis: "inferred" }],
    [{ priority: "urgent" }],
    [{ evidence: [{ quote: "x", start: 3 }] }],
    [{ evidence: [{ quote: "x", start: 5, end: 2 }] }],
    [{ evidence: [{ quote: "   " }] }],
  ])("rejects malformed commitment %j", async (overrides) => {
    const project = await newProject();
    const meeting = await newMeeting(project.id);
    await expect(
      call(saveAnalysis, {
        meetingId: meeting.id,
        summary: "Summary.",
        decisions: [],
        commitments: [commitment(overrides)],
      }),
    ).rejects.toThrow();
    expect(await countFor("commitments", meeting.id)).toBe(0);
  });
});

describe("save-analysis: retries", () => {
  it("does not duplicate results when the same analysis is retried", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id);
    const analysis = productTestAnalysis(meeting.id);

    const first = await call<MeetingOutput>(saveAnalysis, analysis);
    const second = await call<MeetingOutput>(saveAnalysis, analysis);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.commitments.map((c) => c.description)).toEqual(
      first.commitments.map((c) => c.description),
    );
    expect(await countFor("commitments", meeting.id)).toBe(3);
    expect(await countFor("decisions", meeting.id)).toBe(1);
  });

  it("does not duplicate results when two saves race", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id);
    const analysis = productTestAnalysis(meeting.id);
    const results = await Promise.all([
      call<MeetingOutput>(saveAnalysis, analysis),
      call<MeetingOutput>(saveAnalysis, analysis),
    ]);
    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(await countFor("commitments", meeting.id)).toBe(3);
  });

  it("refuses to replace a saved analysis with a different one", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id);
    await call(saveAnalysis, productTestAnalysis(meeting.id));
    const error = await rejection(
      call(saveAnalysis, {
        ...productTestAnalysis(meeting.id),
        summary: "A different summary.",
      }),
    );
    expect(error).toMatchObject({
      errorCode: "analysis_already_saved",
      statusCode: 409,
    });
    const read = await call<MeetingOutput>(getMeeting, { id: meeting.id });
    expect(read.summary).toContain("demo lead is open");
    expect(read.commitments).toHaveLength(3);
  });

  it("rolls everything back when one record cannot be written", async () => {
    const project = await newProject();
    const meeting = await newMeeting(project.id);
    await expect(
      call(saveAnalysis, {
        meetingId: meeting.id,
        summary: "Summary.",
        decisions: [],
        commitments: [
          commitment(),
          commitment({ description: `Bad\u0000byte` }),
        ],
      }),
    ).rejects.toThrow();
    const read = await call<MeetingOutput>(getMeeting, { id: meeting.id });
    expect(read).toMatchObject({
      analysisSaved: false,
      processingStatus: "pending",
      commitments: [],
    });
  });
});
