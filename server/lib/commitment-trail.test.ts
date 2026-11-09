import type { ActionCaller } from "@agent-native/core/action";
import { getDbExec } from "@agent-native/core/db";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import createMeeting from "../../actions/create-meeting.js";
import createProject from "../../actions/create-project.js";
import dismissLink from "../../actions/dismiss-commitment-link.js";
import findCandidates from "../../actions/find-commitment-candidates.js";
import getLedger from "../../actions/get-commitment-ledger.js";
import getTrail from "../../actions/get-commitment-trail.js";
import getMeeting from "../../actions/get-meeting.js";
import linkEvidence from "../../actions/link-commitment-evidence.js";
import reviewCommitment from "../../actions/review-commitment.js";
import saveAnalysis from "../../actions/save-analysis.js";
import updateCommitment from "../../actions/update-commitment.js";
import { getDb, schema } from "../db/index.js";
import { migrations } from "../db/migrations.js";
import { commitmentHealth, type HealthInput } from "./commitment-health.js";
import { splitStatements } from "./commitment-matching.js";
import { sortTrailEvents } from "./commitment-trail.js";

const OWNER = "owner@example.test";
const OTHER = "other@example.test";
const AS_OF = "2026-11-09";

const M1 = "Priya will complete the landing page by November 6, 2026.";
const M2 = "Priya said the landing page is still unfinished.";
const M3 = "The landing page has not been delivered yet.";

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
    (error: { errorCode?: string; statusCode?: number; message: string }) =>
      error,
  );

interface Health {
  overdue: boolean;
  daysOverdue: number | null;
  dueDateConfirmed: boolean;
  revisited: boolean;
  needsReview: boolean;
  meetingCount: number;
  verifiedMeetingCount: number;
  firstMeetingDate: string | null;
  latestMeetingDate: string | null;
  facts: string[];
  status: string;
}
interface Entry {
  id: string;
  description: string;
  ownerDisplayName: string | null;
  statedOwnerName: string | null;
  dueDate: string | null;
  status: string;
  reviewState: string;
  originMeeting: { id: string } | null;
  evidence: { total: number; verified: number; notVerified: number };
  meetings: { id: string; verified: boolean }[];
  lastUpdatedAt: string;
  health: Health;
}
interface Ledger {
  project: { id: string; name: string };
  entries: Entry[];
}
interface TrailEvidence {
  sourceQuote: string;
  sourceStart: number | null;
  verificationStatus: string;
  linkedBy: string | null;
}
interface TrailEvent {
  id: string;
  kind: string;
  occurredAt: string;
  actorType: string | null;
  actorId: string | null;
  meeting: { id: string; title: string } | null;
  evidence: TrailEvidence[];
  fields: { field: string; before: unknown; after: unknown }[];
}
interface Trail {
  commitment: Entry;
  original: { dueDate: string | null; statedOwnerName: string | null } | null;
  events: TrailEvent[];
}
interface Linked {
  trail: Trail;
  replayed: boolean;
  verificationStatus: string;
  duplicateRejected: boolean;
}
interface Candidates {
  statements: {
    quote: string;
    start: number | null;
    end: number | null;
    occurrences: number;
    savedFromThisMeeting: { id: string } | null;
    candidates: { commitmentId: string; reasons: string[] }[];
  }[];
}
interface Meeting {
  id: string;
  transcript: string;
  commitments: {
    id: string;
    version: number;
    description: string;
    reviewFlags: { code: string }[];
  }[];
  linkedCommitments: { id: string; evidence: { sourceQuote: string }[] }[];
}

const commitmentInput = (overrides: Record<string, unknown> = {}) => ({
  description: "Complete the landing page",
  ownerName: "Priya",
  ownerBasis: "explicit",
  dueDate: "2026-11-06",
  dueDateText: "by November 6, 2026",
  dueDateBasis: "explicit",
  priority: null,
  evidence: [{ quote: M1 }],
  reviewNote: null,
  ...overrides,
});

const newProject = (userEmail = OWNER) =>
  call<{ id: string }>(
    createProject,
    { name: "Launch", description: null },
    userEmail,
  );

const newMeeting = (
  projectId: string,
  meetingDate: string,
  transcript: string,
  userEmail = OWNER,
  title = `Meeting ${meetingDate}`,
) =>
  call<{ id: string }>(
    createMeeting,
    { projectId, title, meetingDate, transcript },
    userEmail,
  );

const analyze = (
  meetingId: string,
  commitments: unknown[],
  userEmail = OWNER,
) =>
  call(
    saveAnalysis,
    { meetingId, summary: "Saved.", decisions: [], commitments },
    userEmail,
    "tool",
  );

/** The acceptance project: one commitment and two later, unanalyzed meetings. */
async function setUp(userEmail = OWNER) {
  const { id: projectId } = await newProject(userEmail);
  const first = await newMeeting(projectId, "2026-11-02", M1, userEmail);
  const second = await newMeeting(projectId, "2026-11-06", M2, userEmail);
  const third = await newMeeting(projectId, "2026-11-09", M3, userEmail);
  await analyze(first.id, [commitmentInput()], userEmail);
  const saved = await call<Meeting>(getMeeting, { id: first.id }, userEmail);
  return {
    projectId,
    first: first.id,
    second: second.id,
    third: third.id,
    commitment: saved.commitments[0]!,
  };
}

const link = (
  commitmentId: string,
  meetingId: string,
  quote: string,
  extra: Record<string, unknown> = {},
  userEmail = OWNER,
  caller: ActionCaller = "frontend",
) =>
  call<Linked>(
    linkEvidence,
    { commitmentId, meetingId, quote, asOf: AS_OF, ...extra },
    userEmail,
    caller,
  );

const ledger = (projectId: string, userEmail = OWNER, asOf = AS_OF) =>
  call<Ledger>(getLedger, { projectId, asOf }, userEmail);

const trail = (id: string, userEmail = OWNER, asOf = AS_OF) =>
  call<Trail>(getTrail, { id, asOf }, userEmail);

const candidates = (meetingId: string, userEmail = OWNER) =>
  call<Candidates>(findCandidates, { meetingId }, userEmail);

const shareAs = (projectId: string, principalId: string, role: "viewer") =>
  getDb().insert(schema.projectShares).values({
    id: crypto.randomUUID(),
    resourceId: projectId,
    principalType: "user",
    principalId,
    role,
    createdBy: OWNER,
  });

const evidenceFor = (commitmentId: string) =>
  getDb()
    .select()
    .from(schema.commitmentEvidence)
    .where(eq(schema.commitmentEvidence.commitmentId, commitmentId));

const commitmentRow = async (id: string) =>
  (
    await getDb()
      .select()
      .from(schema.commitments)
      .where(eq(schema.commitments.id, id))
  )[0]!;

const changesFor = (id: string) =>
  getDb().select().from(schema.changes).where(eq(schema.changes.entityId, id));

const countCommitments = async (projectId: string) =>
  (
    await getDb()
      .select()
      .from(schema.commitments)
      .where(eq(schema.commitments.projectId, projectId))
  ).length;

beforeAll(async () => {
  const exec = getDbExec();
  for (const { sql } of migrations) {
    for (const statement of (sql as string).split(/;\s*\n/)) {
      if (statement.trim()) await exec.execute(statement);
    }
  }
}, 60_000);

describe("get-commitment-ledger", () => {
  it("returns the project's commitments with their related meetings", async () => {
    const { projectId, first, commitment } = await setUp();
    const result = await ledger(projectId);
    expect(result.project.id).toBe(projectId);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      id: commitment.id,
      description: "Complete the landing page",
      statedOwnerName: "Priya",
      dueDate: "2026-11-06",
      status: "open",
      reviewState: "proposed",
      originMeeting: { id: first },
      evidence: { total: 1, verified: 1, notVerified: 0 },
      meetings: [{ id: first, verified: true }],
    });
    expect(Date.parse(result.entries[0]!.lastUpdatedAt)).not.toBeNaN();
  });

  it("is readable by a viewer and denied to anyone else", async () => {
    const { projectId } = await setUp();
    await shareAs(projectId, OTHER, "viewer");
    await expect(ledger(projectId, OTHER)).resolves.toMatchObject({
      project: { id: projectId },
    });
    expect(
      await rejection(ledger(projectId, "stranger@example.test")),
    ).toMatchObject({ errorCode: "access_denied", statusCode: 403 });
  });

  it("never includes another project's commitments", async () => {
    const mine = await setUp();
    const theirs = await setUp(OTHER);
    const result = await ledger(mine.projectId);
    expect(result.entries.map((e) => e.id)).toEqual([mine.commitment.id]);
    expect(result.entries.map((e) => e.id)).not.toContain(theirs.commitment.id);
  });

  it("requires a signed-in user", async () => {
    const { projectId } = await setUp();
    expect(await rejection(ledger(projectId, ""))).toMatchObject({
      errorCode: "not_authenticated",
    });
  });
});

describe("find-commitment-candidates", () => {
  it("suggests the earlier commitment for a later mention, with reasons", async () => {
    const { second, commitment } = await setUp();
    const result = await candidates(second);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0]).toMatchObject({
      quote: M2,
      start: 0,
      end: M2.length,
      occurrences: 1,
    });
    const [candidate] = result.statements[0]!.candidates;
    expect(candidate!.commitmentId).toBe(commitment.id);
    expect(candidate!.reasons.join(" ")).toContain('"landing", "page"');
    expect(candidate!.reasons.join(" ")).toContain("Names its owner, Priya.");
    expect(candidate!.reasons.join(" ")).toContain("still");
  });

  it("gives reasons and never a score", async () => {
    const { second } = await setUp();
    const text = JSON.stringify(await candidates(second));
    expect(text).not.toMatch(/\d\s*%|confidence|score/i);
  });

  it("writes nothing", async () => {
    const { second, commitment } = await setUp();
    const before = (await changesFor(commitment.id)).length;
    await candidates(second);
    expect((await changesFor(commitment.id)).length).toBe(before);
    expect(await evidenceFor(commitment.id)).toHaveLength(1);
  });

  it("is available to an agent caller", async () => {
    const { second } = await setUp();
    const result = await call<Candidates>(
      findCandidates,
      { meetingId: second },
      OWNER,
      "tool",
    );
    expect(result.statements).toHaveLength(1);
  });

  it("shows every commitment that could match and picks none", async () => {
    const { projectId, second } = await setUp();
    const other = await newMeeting(
      projectId,
      "2026-11-03",
      "Aarav will redesign the landing page.",
    );
    await analyze(other.id, [
      commitmentInput({
        description: "Redesign the landing page",
        ownerName: "Aarav",
        dueDate: null,
        dueDateText: null,
        dueDateBasis: null,
        evidence: [{ quote: "Aarav will redesign the landing page." }],
      }),
    ]);
    const result = await candidates(second);
    expect(result.statements[0]!.candidates).toHaveLength(2);
    expect(await countCommitments(projectId)).toBe(2);
  });

  it("does not suggest from unrelated talk or filler words", async () => {
    const { projectId } = await setUp();
    const meeting = await newMeeting(
      projectId,
      "2026-11-07",
      "We will complete the budget by Friday. The weather is nice.",
    );
    expect((await candidates(meeting.id)).statements).toEqual([]);
  });

  it("leaves offsets out when the words repeat, so a link stays ambiguous", async () => {
    const { projectId } = await setUp();
    const repeated = `${M3} Then some discussion. ${M3}`;
    const meeting = await newMeeting(projectId, "2026-11-08", repeated);
    const result = await candidates(meeting.id);
    expect(result.statements).toHaveLength(1);
    expect(result.statements[0]).toMatchObject({
      start: null,
      end: null,
      occurrences: 2,
    });
  });

  it("ignores meetings before the commitment, and rejected commitments", async () => {
    const { projectId, commitment } = await setUp();
    const earlier = await newMeeting(projectId, "2026-10-20", M2);
    expect((await candidates(earlier.id)).statements).toEqual([]);

    await call(reviewCommitment, {
      id: commitment.id,
      expectedVersion: commitment.version,
      outcome: "reject",
    });
    const later = await newMeeting(projectId, "2026-11-20", M2);
    expect((await candidates(later.id)).statements).toEqual([]);
  });

  it("stops suggesting what a person linked or ruled out", async () => {
    const { second, third, commitment } = await setUp();
    await link(commitment.id, second, M2);
    expect((await candidates(second)).statements).toEqual([]);

    await call(dismissLink, {
      commitmentId: commitment.id,
      meetingId: third,
      quote: M3,
    });
    expect((await candidates(third)).statements).toEqual([]);
  });

  it("is denied to someone without project access", async () => {
    const { second } = await setUp();
    expect(await rejection(candidates(second, OTHER))).toMatchObject({
      errorCode: "access_denied",
    });
  });
});

describe("link-commitment-evidence", () => {
  it("attaches verified evidence to the same commitment", async () => {
    const { projectId, second, commitment } = await setUp();
    const before = await commitmentRow(commitment.id);

    const result = await link(commitment.id, second, M2);

    expect(result).toMatchObject({
      replayed: false,
      verificationStatus: "verified",
    });
    expect(await countCommitments(projectId)).toBe(1);

    const stored = await evidenceFor(commitment.id);
    expect(stored).toHaveLength(2);
    const added = stored.find((e) => e.meetingId === second)!;
    expect(added).toMatchObject({
      sourceQuote: M2,
      sourceStart: 0,
      sourceEnd: M2.length,
      verificationStatus: "verified",
      linkedBy: OWNER,
    });
    expect(added.linkedAt).not.toBeNull();

    const after = await commitmentRow(commitment.id);
    expect(after).toMatchObject({
      id: before.id,
      ownerId: before.ownerId,
      statedOwnerName: before.statedOwnerName,
      dueDate: before.dueDate,
      status: before.status,
      priority: before.priority,
      description: before.description,
      version: before.version,
    });
  });

  it("records who confirmed the link, from trusted context", async () => {
    const { second, commitment } = await setUp();
    await link(commitment.id, second, M2);
    const [change] = (await changesFor(commitment.id)).filter(
      (c) => c.operation === "update",
    );
    expect(change).toMatchObject({ actorType: "user", actorId: OWNER });
    expect(change!.afterState).toMatchObject({
      evidenceLink: { meetingId: second, quote: M2 },
    });
  });

  it("never takes an actor from the client", async () => {
    const parsed = (
      linkEvidence as unknown as {
        schema: { safeParse: (v: unknown) => { success: boolean } };
      }
    ).schema.safeParse({
      commitmentId: "c",
      meetingId: "m",
      quote: "q",
      linkedBy: "someone@else.test",
    });
    expect(parsed.success).toBe(false);
  });

  it("leaves every transcript unchanged", async () => {
    const { first, second, commitment } = await setUp();
    await link(commitment.id, second, M2);
    await link(commitment.id, second, "Words nobody said.");
    const rows = await getDb().select().from(schema.meetings);
    const text = new Map(rows.map((m) => [m.id, m.transcript]));
    expect(text.get(first)).toBe(M1);
    expect(text.get(second)).toBe(M2);
  });

  it("refuses a meeting from another project", async () => {
    const mine = await setUp();
    const other = await setUp();
    expect(
      await rejection(link(mine.commitment.id, other.second, M2)),
    ).toMatchObject({ errorCode: "cross_project_link", statusCode: 422 });
    expect(await evidenceFor(mine.commitment.id)).toHaveLength(1);
  });

  it("refuses a user without access, and a viewer", async () => {
    const { projectId, second, commitment } = await setUp();
    expect(
      await rejection(link(commitment.id, second, M2, {}, OTHER)),
    ).toMatchObject({ errorCode: "access_denied" });
    await shareAs(projectId, OTHER, "viewer");
    expect(
      await rejection(link(commitment.id, second, M2, {}, OTHER)),
    ).toMatchObject({ errorCode: "access_denied" });
    expect(await evidenceFor(commitment.id)).toHaveLength(1);
  });

  it("keeps a missing quotation unverified and asks for review", async () => {
    const { second, commitment } = await setUp();
    const result = await link(commitment.id, second, "Priya finished it.");

    expect(result.verificationStatus).toBe("missing");
    const added = (await evidenceFor(commitment.id)).find(
      (e) => e.meetingId === second,
    )!;
    expect(added).toMatchObject({
      verificationStatus: "missing",
      sourceStart: null,
      sourceEnd: null,
      linkedBy: OWNER,
    });
    expect(result.trail.commitment.health).toMatchObject({
      needsReview: true,
      meetingCount: 2,
      verifiedMeetingCount: 1,
      revisited: false,
    });
    const row = await commitmentRow(commitment.id);
    expect(row.reviewFlags.map((f) => f.code)).toEqual(["evidence"]);
    expect(row.version).toBe(commitment.version + 1);
  });

  it("keeps a repeated quotation ambiguous", async () => {
    const { projectId, commitment } = await setUp();
    const meeting = await newMeeting(
      projectId,
      "2026-11-08",
      `${M3} Then some discussion. ${M3}`,
    );
    const result = await link(commitment.id, meeting.id, M3);
    expect(result.verificationStatus).toBe("ambiguous");
    const mention = result.trail.events.find(
      (e) => e.meeting?.id === meeting.id,
    )!;
    expect(mention.evidence[0]).toMatchObject({
      verificationStatus: "ambiguous",
      sourceStart: null,
    });
  });

  it("does not verify a quotation at the wrong offsets", async () => {
    const { second, commitment } = await setUp();
    const result = await link(commitment.id, second, "landing page", {
      start: 0,
      end: 12,
    });
    expect(result.verificationStatus).toBe("missing");
  });

  it("adds nothing when the same link is confirmed again", async () => {
    const { second, commitment } = await setUp();
    await link(commitment.id, second, M2);
    const changes = (await changesFor(commitment.id)).length;

    const retry = await link(commitment.id, second, M2);

    expect(retry.replayed).toBe(true);
    expect(await evidenceFor(commitment.id)).toHaveLength(2);
    expect(await changesFor(commitment.id)).toHaveLength(changes);
  });

  it("does not double up when two confirmations race", async () => {
    const { second, commitment } = await setUp();
    const results = await Promise.all([
      link(commitment.id, second, M2),
      link(commitment.id, second, M2),
    ]);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await evidenceFor(commitment.id)).toHaveLength(2);
  });

  it.each([
    "tool",
    "mcp",
    "webmcp",
    "a2a",
    "automation",
    "cli",
    "http",
    "mcp-widget-write",
  ] as ActionCaller[])("refuses the %s caller", async (caller) => {
    const { second, commitment } = await setUp();
    expect(
      await rejection(link(commitment.id, second, M2, {}, OWNER, caller)),
    ).toMatchObject({ errorCode: "ui_only_action", statusCode: 403 });
    expect(await evidenceFor(commitment.id)).toHaveLength(1);
  });

  it("is hidden from the agent as well as refused", () => {
    for (const action of [linkEvidence, dismissLink]) {
      expect(action).toMatchObject({ agentTool: false, uiOnly: true });
    }
  });

  it("refuses the meeting the commitment came from", async () => {
    const { first, commitment } = await setUp();
    expect(await rejection(link(commitment.id, first, M1))).toMatchObject({
      errorCode: "not_a_later_meeting",
    });
  });

  it("refuses a meeting held before the commitment", async () => {
    const { projectId, commitment } = await setUp();
    const earlier = await newMeeting(projectId, "2026-10-20", M2);
    expect(await rejection(link(commitment.id, earlier.id, M2))).toMatchObject({
      errorCode: "not_a_later_meeting",
    });
  });

  it("refuses a rejected commitment", async () => {
    const { second, commitment } = await setUp();
    await call(reviewCommitment, {
      id: commitment.id,
      expectedVersion: commitment.version,
      outcome: "reject",
    });
    expect(await rejection(link(commitment.id, second, M2))).toMatchObject({
      errorCode: "commitment_rejected",
    });
  });

  it("does not disturb the review controls", async () => {
    const { second, commitment } = await setUp();
    const result = await link(commitment.id, second, "Priya finished it.");
    expect(result.verificationStatus).toBe("missing");
    const row = await commitmentRow(commitment.id);

    await call(reviewCommitment, {
      id: commitment.id,
      expectedVersion: row.version,
      outcome: "confirm",
      resolveFlags: ["evidence"],
    });

    const reviewed = await commitmentRow(commitment.id);
    expect(reviewed).toMatchObject({
      reviewState: "confirmed",
      needsReview: false,
    });
    const missing = (await evidenceFor(commitment.id)).find(
      (e) => e.meetingId === second,
    )!;
    expect(missing.verificationStatus).toBe("missing");
  });

  it("leaves an open editor valid after a verified link", async () => {
    const { second, commitment } = await setUp();
    await link(commitment.id, second, M2);
    await expect(
      call(updateCommitment, {
        id: commitment.id,
        expectedVersion: commitment.version,
        status: "in_progress",
      }),
    ).resolves.toMatchObject({ changed: true });
  });
});

describe("resolving a duplicate from a later analysis", () => {
  async function withDuplicate() {
    const base = await setUp();
    await analyze(base.second, [
      commitmentInput({
        description: "Finish the landing page",
        dueDate: null,
        dueDateText: null,
        dueDateBasis: null,
        evidence: [{ quote: M2 }],
      }),
    ]);
    const saved = await call<Meeting>(getMeeting, { id: base.second });
    return { ...base, duplicate: saved.commitments[0]! };
  }

  it("flags the statement as possibly already known", async () => {
    const { second, commitment, duplicate } = await withDuplicate();
    const [statement] = (await candidates(second)).statements;
    expect(statement!.savedFromThisMeeting?.id).toBe(duplicate.id);
    expect(statement!.candidates[0]!.commitmentId).toBe(commitment.id);
  });

  it("links the evidence and rejects the duplicate, keeping its history", async () => {
    const { projectId, second, commitment, duplicate } = await withDuplicate();
    const result = await link(commitment.id, second, M2, {
      duplicateCommitmentId: duplicate.id,
    });

    expect(result.duplicateRejected).toBe(true);
    expect(await commitmentRow(duplicate.id)).toMatchObject({
      reviewState: "rejected",
      reviewedBy: OWNER,
      needsReview: false,
    });
    expect(await evidenceFor(duplicate.id)).toHaveLength(1);
    expect(await countCommitments(projectId)).toBe(2);

    const history = await trail(duplicate.id);
    const decision = history.events.find((e) => e.kind === "review")!;
    expect(decision.fields).toEqual(
      expect.arrayContaining([
        { field: "reviewState", before: "proposed", after: "rejected" },
        { field: "duplicateOf", before: null, after: commitment.description },
      ]),
    );
  });

  it("does not disturb save-analysis replay protection", async () => {
    const { second, duplicate, commitment } = await withDuplicate();
    await link(commitment.id, second, M2, {
      duplicateCommitmentId: duplicate.id,
    });
    const replay = await call<{ replayed: boolean }>(
      saveAnalysis,
      {
        meetingId: second,
        summary: "Saved.",
        decisions: [],
        commitments: [
          commitmentInput({
            description: "Finish the landing page",
            dueDate: null,
            dueDateText: null,
            dueDateBasis: null,
            evidence: [{ quote: M2 }],
          }),
        ],
      },
      OWNER,
      "tool",
    );
    expect(replay.replayed).toBe(true);
  });

  it("only accepts a commitment saved from that meeting", async () => {
    const { second, commitment } = await setUp();
    expect(
      await rejection(
        link(commitment.id, second, M2, {
          duplicateCommitmentId: commitment.id,
        }),
      ),
    ).toMatchObject({ errorCode: "invalid_duplicate" });
  });
});

describe("dismiss-commitment-link", () => {
  it("is idempotent and leaves the commitment alone", async () => {
    const { third, commitment } = await setUp();
    const args = { commitmentId: commitment.id, meetingId: third, quote: M3 };
    const first = await call<{ replayed: boolean }>(dismissLink, args);
    const second = await call<{ replayed: boolean }>(dismissLink, args);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(await evidenceFor(commitment.id)).toHaveLength(1);
    expect(await commitmentRow(commitment.id)).toMatchObject({
      version: commitment.version,
    });
    const dismissals = (await trail(commitment.id)).events.filter(
      (e) => e.kind === "dismissal",
    );
    expect(dismissals).toHaveLength(1);
  });

  it("refuses an agent and a user without access", async () => {
    const { third, commitment } = await setUp();
    const args = { commitmentId: commitment.id, meetingId: third, quote: M3 };
    expect(
      await rejection(call(dismissLink, args, OWNER, "tool")),
    ).toMatchObject({ errorCode: "ui_only_action" });
    expect(await rejection(call(dismissLink, args, OTHER))).toMatchObject({
      errorCode: "access_denied",
    });
  });
});

describe("the trail across three meetings", () => {
  async function linkedThree() {
    const base = await setUp();
    await link(base.commitment.id, base.second, M2);
    await link(base.commitment.id, base.third, M3);
    return base;
  }

  it("shows one commitment with evidence from three distinct meetings", async () => {
    const { projectId, first, second, third, commitment } = await linkedThree();
    const result = await trail(commitment.id);

    expect(await countCommitments(projectId)).toBe(1);
    expect(result.commitment.health).toMatchObject({
      meetingCount: 3,
      verifiedMeetingCount: 3,
      firstMeetingDate: "2026-11-02",
      latestMeetingDate: "2026-11-09",
      revisited: true,
    });
    expect(result.commitment.meetings.map((m) => m.id)).toEqual([
      first,
      second,
      third,
    ]);
    expect(
      result.events.map((e) => [
        e.kind,
        e.meeting?.id,
        e.evidence[0]?.sourceQuote,
      ]),
    ).toEqual([
      ["origin", first, M1],
      ["mention", second, M2],
      ["mention", third, M3],
    ]);
  });

  it("orders by when things happened, not when they were linked", async () => {
    const base = await setUp();
    await link(base.commitment.id, base.third, M3);
    await link(base.commitment.id, base.second, M2);
    const result = await trail(base.commitment.id);
    expect(result.events.map((e) => e.meeting?.id)).toEqual([
      base.first,
      base.second,
      base.third,
    ]);
  });

  it("does not count several quotes from one meeting twice", async () => {
    const { projectId, commitment } = await setUp();
    const meeting = await newMeeting(
      projectId,
      "2026-11-07",
      "The landing page is late. Priya said the landing page needs copy.",
    );
    await link(commitment.id, meeting.id, "The landing page is late.");
    await link(
      commitment.id,
      meeting.id,
      "Priya said the landing page needs copy.",
    );
    const result = await trail(commitment.id);
    expect(result.commitment.health).toMatchObject({
      meetingCount: 2,
      verifiedMeetingCount: 2,
    });
    expect(result.commitment.evidence.total).toBe(3);
    const mentions = result.events.filter((e) => e.kind === "mention");
    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.evidence).toHaveLength(2);
  });

  it("keeps each quote tied to its own meeting's transcript", async () => {
    const { first, second, third, commitment } = await linkedThree();
    const stored = await evidenceFor(commitment.id);
    const quoteFor = (meetingId: string) =>
      stored.find((e) => e.meetingId === meetingId)!.sourceQuote;
    expect(quoteFor(first)).toBe(M1);
    expect(quoteFor(second)).toBe(M2);
    expect(quoteFor(third)).toBe(M3);

    const later = await call<Meeting>(getMeeting, { id: second });
    expect(later.linkedCommitments).toHaveLength(1);
    expect(
      later.linkedCommitments[0]!.evidence.map((e) => e.sourceQuote),
    ).toEqual([M2]);
    const origin = await call<Meeting>(getMeeting, { id: first });
    expect(origin.linkedCommitments).toEqual([]);
  });

  it("shows human edits and review decisions with the original intact", async () => {
    const { second, commitment } = await setUp();
    await link(commitment.id, second, M2);
    await call(updateCommitment, {
      id: commitment.id,
      expectedVersion: commitment.version,
      dueDate: "2026-11-20",
      status: "in_progress",
    });
    const row = await commitmentRow(commitment.id);
    await call(reviewCommitment, {
      id: commitment.id,
      expectedVersion: row.version,
      outcome: "confirm",
    });

    const result = await trail(commitment.id);
    expect(result.original).toMatchObject({
      dueDate: "2026-11-06",
      statedOwnerName: "Priya",
    });
    expect(result.commitment.dueDate).toBe("2026-11-20");

    const kinds = result.events.map((e) => e.kind);
    expect(kinds).toEqual(["origin", "mention", "edit", "review"]);
    expect(result.events[2]).toMatchObject({
      actorType: "user",
      actorId: OWNER,
    });
    expect(result.events[2]!.fields).toEqual(
      expect.arrayContaining([
        { field: "dueDate", before: "2026-11-06", after: "2026-11-20" },
        { field: "status", before: "open", after: "in_progress" },
      ]),
    );
  });

  it("marks who saved the origin as the agent", async () => {
    const { commitment } = await setUp();
    const result = await trail(commitment.id);
    expect(result.events[0]).toMatchObject({
      kind: "origin",
      actorType: "agent",
    });
  });

  it("is denied to someone without project access", async () => {
    const { commitment } = await setUp();
    expect(await rejection(trail(commitment.id, OTHER))).toMatchObject({
      errorCode: "access_denied",
    });
  });
});

describe("overdue from saved data", () => {
  it("marks an unfinished commitment past its confirmed date", async () => {
    const { projectId } = await setUp();
    const [entry] = (await ledger(projectId)).entries;
    expect(entry!.health).toMatchObject({
      overdue: true,
      daysOverdue: 3,
      dueDateConfirmed: true,
    });
  });

  it("clears overdue once the commitment is completed", async () => {
    const { projectId, commitment } = await setUp();
    await call(updateCommitment, {
      id: commitment.id,
      expectedVersion: commitment.version,
      status: "completed",
    });
    const [entry] = (await ledger(projectId)).entries;
    expect(entry!.health.overdue).toBe(false);
  });

  it("does not take an agent's date as confirmed", async () => {
    const { projectId, commitment } = await setUp();
    await call(
      updateCommitment,
      {
        id: commitment.id,
        expectedVersion: commitment.version,
        dueDate: "2026-11-01",
      },
      OWNER,
      "tool",
    );
    const [entry] = (await ledger(projectId)).entries;
    expect(entry!.health).toMatchObject({
      overdue: false,
      dueDateConfirmed: false,
      needsReview: true,
    });
  });

  it("does not call an interpreted date overdue until a person settles it", async () => {
    const { id: projectId } = await newProject();
    const text = "Priya will finish the docs by Friday.";
    const meeting = await newMeeting(projectId, "2026-11-02", text);
    await analyze(meeting.id, [
      commitmentInput({
        description: "Finish the docs",
        dueDate: "2026-11-06",
        dueDateText: "by Friday",
        dueDateBasis: "inferred",
        evidence: [{ quote: text }],
      }),
    ]);
    const before = (await ledger(projectId)).entries[0]!;
    expect(before.health).toMatchObject({
      overdue: false,
      dueDateConfirmed: false,
    });
    expect(before.health.facts.join(" ")).toContain("overdue is not claimed");

    const saved = await call<Meeting>(getMeeting, { id: meeting.id });
    await call(reviewCommitment, {
      id: saved.commitments[0]!.id,
      expectedVersion: saved.commitments[0]!.version,
      outcome: "confirm",
      resolveFlags: ["deadline"],
    });
    expect((await ledger(projectId)).entries[0]!.health.overdue).toBe(true);
  });
});

describe("commitmentHealth", () => {
  const dates = new Map([
    ["m1", "2026-11-02"],
    ["m2", "2026-11-06"],
  ]);
  const input = (overrides: Partial<HealthInput> = {}): HealthInput => ({
    status: "open",
    dueDate: "2026-11-06",
    reviewState: "proposed",
    needsReview: false,
    reviewFlags: [],
    originMeetingId: "m1",
    evidence: [
      { meetingId: "m1", verificationStatus: "verified", linkedBy: null },
    ],
    ...overrides,
  });
  const health = (overrides: Partial<HealthInput> = {}, asOf = AS_OF) =>
    commitmentHealth(input(overrides), dates, asOf);

  it("is overdue only strictly after the due date", () => {
    expect(health({}, "2026-11-06").overdue).toBe(false);
    expect(health({}, "2026-11-07")).toMatchObject({
      overdue: true,
      daysOverdue: 1,
    });
  });

  it("never calls an unknown deadline overdue", () => {
    expect(health({ dueDate: null })).toMatchObject({
      overdue: false,
      daysOverdue: null,
      dueDateConfirmed: false,
    });
  });

  it.each(["completed", "cancelled"] as const)(
    "does not call a %s commitment overdue",
    (status) => {
      expect(health({ status }).overdue).toBe(false);
    },
  );

  it.each(["open", "in_progress", "blocked"] as const)(
    "can call a %s commitment overdue",
    (status) => {
      expect(health({ status }).overdue).toBe(true);
    },
  );

  it("does not call a rejected commitment overdue", () => {
    expect(health({ reviewState: "rejected" }).overdue).toBe(false);
  });

  it.each(["deadline", "legacy"] as const)(
    "does not trust a date under an open %s flag",
    (code) => {
      expect(health({ reviewFlags: [{ code, message: "x" }] })).toMatchObject({
        overdue: false,
        dueDateConfirmed: false,
      });
    },
  );

  it("is not thrown off by an unrelated review flag", () => {
    expect(
      health({ reviewFlags: [{ code: "owner", message: "x" }] }).overdue,
    ).toBe(true);
  });

  it("needs verified evidence from two meetings to count as revisited", () => {
    const verified = {
      meetingId: "m2",
      verificationStatus: "verified",
      linkedBy: "a@b.test",
    };
    const base = input().evidence;
    expect(health().revisited).toBe(false);
    expect(health({ evidence: [...base, verified] }).revisited).toBe(true);
    expect(
      health({
        evidence: [...base, { ...verified, verificationStatus: "missing" }],
      }),
    ).toMatchObject({
      revisited: false,
      meetingCount: 2,
      verifiedMeetingCount: 1,
    });
  });

  it("ignores later-meeting evidence no person confirmed", () => {
    expect(
      health({
        evidence: [
          ...input().evidence,
          { meetingId: "m2", verificationStatus: "verified", linkedBy: null },
        ],
      }),
    ).toMatchObject({ meetingCount: 1, revisited: false });
  });

  it("states only current facts and never counts delays", () => {
    const facts = health().facts.join(" ");
    expect(facts).toContain("Currently marked open.");
    expect(facts).not.toMatch(/delay|slip|extension|missed/i);
  });
});

describe("splitStatements", () => {
  const text =
    "Priya: it is late.  Aarav agreed!\n\nv1.2 ships soon?\nNo punctuation";

  it("returns exact slices of the transcript", () => {
    for (const { text: value, start, end } of splitStatements(text)) {
      expect(text.slice(start, end)).toBe(value);
    }
  });

  it("splits on sentence ends and lines, not inside a version number", () => {
    expect(splitStatements(text).map((s) => s.text)).toEqual([
      "Priya: it is late.",
      "Aarav agreed!",
      "v1.2 ships soon?",
      "No punctuation",
    ]);
  });
});

describe("sortTrailEvents", () => {
  const event = (id: string, kind: string, occurredAt: string) =>
    ({
      id,
      kind,
      occurredAt,
      precision: "time",
      actorType: null,
      actorId: null,
      meeting: null,
      evidence: [],
      fields: [],
    }) as never;

  it("keeps the origin first and breaks ties the same way every time", () => {
    const at = "2026-11-06T00:00:00.000Z";
    const events = [
      event("b", "edit", at),
      event("a", "edit", at),
      event("m", "mention", at),
      event("o", "origin", "2026-11-09T00:00:00.000Z"),
    ];
    const order = (list: typeof events) =>
      sortTrailEvents(list).map((e: { id: string }) => e.id);
    expect(order(events)).toEqual(["o", "m", "a", "b"]);
    expect(order([...events].reverse())).toEqual(["o", "m", "a", "b"]);
  });
});

describe("change history for links", () => {
  it("shows a link in the commitment's history", async () => {
    const { second, commitment } = await setUp();
    await link(commitment.id, second, M2);
    const rows = await getDb()
      .select()
      .from(schema.changes)
      .where(
        and(
          eq(schema.changes.entityId, commitment.id),
          eq(schema.changes.operation, "update"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.beforeState).toEqual({ evidenceLink: null });
  });
});
