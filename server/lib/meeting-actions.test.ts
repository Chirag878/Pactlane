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
