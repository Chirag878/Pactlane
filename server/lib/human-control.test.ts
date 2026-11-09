import type { ActionCaller } from "@agent-native/core/action";
import { getDbExec } from "@agent-native/core/db";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import addPerson from "../../actions/add-person.js";
import createMeeting from "../../actions/create-meeting.js";
import createProject from "../../actions/create-project.js";
import getCommitmentHistory from "../../actions/get-commitment-history.js";
import getMeeting from "../../actions/get-meeting.js";
import listPeople from "../../actions/list-people.js";
import publishMeetingAnalysis from "../../actions/publish-meeting-analysis.js";
import reviewCommitment from "../../actions/review-commitment.js";
import saveAnalysis from "../../actions/save-analysis.js";
import updateCommitment from "../../actions/update-commitment.js";
import { getDb, schema } from "../db/index.js";
import { migrations } from "../db/migrations.js";

const OWNER = "owner@example.test";
const OTHER = "other@example.test";

const TRANSCRIPT =
  "Priya will prepare the landing page by Friday.\n\nAarav will build the demonstration.\n\nThe team agreed to launch a preview next week.";

type RunnableAction = { run: (args: never, ctx?: never) => unknown };

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

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("Expected the action to fail.");
    },
    (error: {
      errorCode?: string;
      statusCode?: number;
      message: string;
      details?: Record<string, unknown>;
    }) => error,
  );

interface Evidence {
  sourceQuote: string;
  sourceStart: number | null;
  verificationStatus: string;
}
interface Commitment {
  id: string;
  projectId: string;
  version: number;
  description: string;
  ownerId: string | null;
  ownerDisplayName: string | null;
  statedOwnerName: string | null;
  dueDate: string | null;
  statedDueText: string | null;
  priority: string | null;
  status: string;
  needsReview: boolean;
  reviewReason: string | null;
  reviewFlags: { code: string; message: string }[];
  reviewState: string;
  reviewedBy: string | null;
  evidence: Evidence[];
}
interface Updated {
  commitment: Commitment;
  changed: boolean;
  changedFields: string[];
}
interface Meeting {
  id: string;
  transcript: string;
  commitments: Commitment[];
  decisions: { id: string; description: string }[];
}
interface History {
  entries: {
    operation: string;
    actorType: string;
    actorId: string;
    fields: { field: string; before: unknown; after: unknown }[];
  }[];
}

const analysis = (meetingId: string) => ({
  meetingId,
  summary: "Landing page and demo are assigned; a preview launch was agreed.",
  decisions: [
    {
      description: "Launch a preview next week",
      evidence: [{ quote: "The team agreed to launch a preview next week." }],
      reviewNote: null,
    },
  ],
  commitments: [
    {
      description: "Prepare the landing page",
      ownerName: "Priya",
      ownerBasis: "explicit",
      dueDate: "2026-11-06",
      dueDateText: "by Friday",
      dueDateBasis: "inferred",
      priority: null,
      evidence: [{ quote: "Priya will prepare the landing page by Friday." }],
      reviewNote: null,
    },
    {
      description: "Build the demonstration",
      ownerName: "Aarav",
      ownerBasis: "explicit",
      dueDate: null,
      dueDateText: null,
      dueDateBasis: null,
      priority: null,
      evidence: [{ quote: "Aarav will build the demonstration." }],
      reviewNote: null,
    },
    {
      description: "Deploy the preview",
      ownerName: "Meera",
      ownerBasis: "explicit",
      dueDate: null,
      dueDateText: null,
      dueDateBasis: null,
      priority: null,
      evidence: [{ quote: "Meera owns the deployment" }],
      reviewNote: null,
    },
  ],
});

/** A project holding the acceptance meeting, analysed and saved. */
async function setUp(userEmail = OWNER) {
  const project = await call<{ id: string }>(
    createProject,
    { name: "Launch", description: null },
    userEmail,
  );
  const created = await call<{ id: string }>(
    createMeeting,
    {
      projectId: project.id,
      title: "Planning",
      meetingDate: "2026-11-02",
      transcript: TRANSCRIPT,
    },
    userEmail,
  );
  await call(saveAnalysis, analysis(created.id), userEmail, "tool");
  const meeting = await call<Meeting>(
    getMeeting,
    { id: created.id },
    userEmail,
  );
  const byText = (text: string) =>
    meeting.commitments.find((c) => c.description.includes(text))!;
  return {
    projectId: project.id,
    meeting,
    priya: byText("landing page"),
    aarav: byText("demonstration"),
    meera: byText("Deploy"),
  };
}

const update = (
  commitment: Commitment,
  changes: Record<string, unknown>,
  userEmail = OWNER,
  caller: ActionCaller = "frontend",
) =>
  call<Updated>(
    updateCommitment,
    { id: commitment.id, expectedVersion: commitment.version, ...changes },
    userEmail,
    caller,
  );

const review = (
  commitment: Commitment,
  outcome: string,
  resolveFlags: string[] = [],
  caller: ActionCaller = "frontend",
) =>
  call<{ commitment: Commitment; changed: boolean }>(
    reviewCommitment,
    {
      id: commitment.id,
      expectedVersion: commitment.version,
      outcome,
      resolveFlags,
    },
    OWNER,
    caller,
  );

const person = (
  projectId: string,
  displayName: string,
  aliases: string[] = [],
) =>
  call<{ person: { id: string; displayName: string } }>(addPerson, {
    projectId,
    displayName,
    aliases,
  }).then((r) => r.person);

const evidenceFor = (commitmentId: string) =>
  getDb()
    .select()
    .from(schema.commitmentEvidence)
    .where(eq(schema.commitmentEvidence.commitmentId, commitmentId));

const historyFor = (id: string, userEmail = OWNER) =>
  call<History>(getCommitmentHistory, { id }, userEmail);

beforeAll(async () => {
  const exec = getDbExec();
  for (const { sql } of migrations) {
    for (const statement of (sql as string).split(/;\s*\n/)) {
      if (statement.trim()) await exec.execute(statement);
    }
  }
}, 60_000);

describe("update-commitment", () => {
  it("applies a correction and leaves the transcript and evidence alone", async () => {
    const { projectId, meeting, priya } = await setUp();
    const priyaPerson = await person(projectId, "Priya Sharma", ["Priya"]);
    const evidenceBefore = await evidenceFor(priya.id);

    const result = await update(priya, {
      dueDate: "2026-11-13",
      ownerId: priyaPerson.id,
      status: "in_progress",
      description: "  Prepare the landing page  ",
    });

    expect(result).toMatchObject({
      changed: true,
      // The description only differed by whitespace, so it is not a change.
      changedFields: ["ownerId", "dueDate", "status"],
    });
    expect(result.commitment).toMatchObject({
      version: priya.version + 1,
      dueDate: "2026-11-13",
      ownerId: priyaPerson.id,
      ownerDisplayName: "Priya Sharma",
      status: "in_progress",
      description: "Prepare the landing page",
    });

    // What was stated is preserved, and so is the evidence and transcript.
    expect(result.commitment.statedOwnerName).toBe("Priya");
    expect(result.commitment.statedDueText).toBe("by Friday");
    expect(await evidenceFor(priya.id)).toEqual(evidenceBefore);
    const [stored] = await getDb()
      .select()
      .from(schema.meetings)
      .where(eq(schema.meetings.id, meeting.id));
    expect(stored!.transcript).toBe(TRANSCRIPT);
  });

  it("changes only the fields that were sent", async () => {
    const { aarav } = await setUp();
    const result = await update(aarav, { priority: "high" });
    expect(result.changedFields).toEqual(["priority"]);
    expect(result.commitment).toMatchObject({
      priority: "high",
      description: aarav.description,
      ownerId: aarav.ownerId,
      dueDate: null,
      status: "open",
    });
  });

  it("can clear an optional field", async () => {
    const { priya } = await setUp();
    const set = await update(priya, { priority: "low" });
    const cleared = await update(set.commitment, {
      priority: null,
      dueDate: null,
    });
    expect(cleared.commitment).toMatchObject({ priority: null, dueDate: null });
  });

  it("sets and clears the completion time with the status", async () => {
    const { aarav } = await setUp();
    const done = await update(aarav, { status: "completed" });
    const [row] = await getDb()
      .select()
      .from(schema.commitments)
      .where(eq(schema.commitments.id, aarav.id));
    expect(row!.completedAt).not.toBeNull();
    await update(done.commitment, { status: "open" });
    const [reopened] = await getDb()
      .select()
      .from(schema.commitments)
      .where(eq(schema.commitments.id, aarav.id));
    expect(reopened!.completedAt).toBeNull();
  });

  describe("access", () => {
    it("denies a user with no access to the project", async () => {
      const { priya } = await setUp();
      const error = await rejection(update(priya, { priority: "high" }, OTHER));
      expect(error).toMatchObject({ errorCode: "access_denied" });
    });

    it("denies a viewer, and gives the same answer for a missing id", async () => {
      const { projectId, priya } = await setUp();
      await getDb().insert(schema.projectShares).values({
        id: crypto.randomUUID(),
        resourceId: projectId,
        principalType: "user",
        principalId: OTHER,
        role: "viewer",
        createdBy: OWNER,
      });
      const forbidden = await rejection(
        update(priya, { priority: "high" }, OTHER),
      );
      const missing = await rejection(
        call(
          updateCommitment,
          { id: "no-such-id", expectedVersion: 1, priority: "high" },
          OTHER,
        ),
      );
      expect(forbidden).toMatchObject({ errorCode: "access_denied" });
      expect(missing).toMatchObject({ errorCode: "access_denied" });
      expect(forbidden.message).toBe(missing.message);
    });

    it("requires a signed-in user", async () => {
      const { priya } = await setUp();
      const error = await rejection(
        call(
          updateCommitment,
          { id: priya.id, expectedVersion: 1, priority: "low" },
          "",
        ),
      );
      expect(error).toMatchObject({ errorCode: "not_authenticated" });
    });

    it("never takes an actor from the client", async () => {
      const { priya } = await setUp();
      const parsed = (
        updateCommitment as unknown as {
          schema: { safeParse: (v: unknown) => { success: boolean } };
        }
      ).schema.safeParse({
        id: priya.id,
        expectedVersion: 1,
        priority: "low",
        actorId: "someone@else.test",
        actorType: "system",
      });
      expect(parsed.success).toBe(false);
    });

    it("refuses an owner from another project", async () => {
      const first = await setUp();
      const second = await setUp();
      const foreign = await person(second.projectId, "Dana");
      const error = await rejection(
        update(first.priya, { ownerId: foreign.id }),
      );
      expect(error).toMatchObject({ errorCode: "owner_not_in_project" });
      const [row] = await getDb()
        .select()
        .from(schema.commitments)
        .where(eq(schema.commitments.id, first.priya.id));
      expect(row!.ownerId).toBeNull();
      expect(row!.version).toBe(first.priya.version);
    });

    it("refuses an owner id that does not exist", async () => {
      const { priya } = await setUp();
      const error = await rejection(update(priya, { ownerId: "ghost" }));
      expect(error).toMatchObject({ errorCode: "owner_not_in_project" });
    });
  });

  describe("validation", () => {
    const schemaOf = (
      updateCommitment as unknown as {
        schema: { safeParse: (v: unknown) => { success: boolean } };
      }
    ).schema;
    const base = { id: "c", expectedVersion: 1 };

    it.each([
      ["a date that does not exist", { dueDate: "2026-02-30" }],
      ["a date in words", { dueDate: "next Friday" }],
      ["a date with a time", { dueDate: "2026-11-06T10:00:00Z" }],
      ["an unknown priority", { priority: "urgent" }],
      ["an unknown status", { status: "done" }],
      ["a blank description", { description: "   " }],
      ["an unknown field", { notes: "x" }],
      ["no change at all", {}],
      ["a fractional version", { priority: "low", expectedVersion: 1.5 }],
    ])("rejects %s", (_name, extra) => {
      expect(schemaOf.safeParse({ ...base, ...extra }).success).toBe(false);
    });

    it("rejects an invalid status transition", async () => {
      const { aarav } = await setUp();
      const done = await update(aarav, { status: "completed" });
      const error = await rejection(
        update(done.commitment, { status: "cancelled" }),
      );
      expect(error).toMatchObject({ errorCode: "invalid_transition" });
    });

    it("does not let an agent reopen a completed commitment", async () => {
      const { aarav } = await setUp();
      const done = await update(aarav, { status: "completed" });
      const error = await rejection(
        update(done.commitment, { status: "open" }, OWNER, "tool"),
      );
      expect(error).toMatchObject({ errorCode: "human_required" });
      const reopened = await update(done.commitment, { status: "open" });
      expect(reopened.commitment.status).toBe("open");
    });
  });

  describe("concurrent edits", () => {
    it("refuses a stale version and returns the current commitment", async () => {
      const { priya } = await setUp();
      await update(priya, { priority: "high" });

      const error = await rejection(update(priya, { dueDate: "2026-12-01" }));
      expect(error).toMatchObject({
        errorCode: "version_conflict",
        statusCode: 409,
      });
      expect((error.details?.current as Commitment).priority).toBe("high");

      const [row] = await getDb()
        .select()
        .from(schema.commitments)
        .where(eq(schema.commitments.id, priya.id));
      expect(row!.dueDate).toBe("2026-11-06");
    });

    it("lets only one of two simultaneous edits win", async () => {
      const { aarav } = await setUp();
      const results = await Promise.allSettled([
        update(aarav, { priority: "low" }),
        update(aarav, { priority: "high" }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const [rejected] = results.filter((r) => r.status === "rejected");
      expect((rejected as PromiseRejectedResult).reason).toMatchObject({
        errorCode: "version_conflict",
      });
      const history = await historyFor(aarav.id);
      expect(
        history.entries.filter((e) => e.operation === "update"),
      ).toHaveLength(1);
    });
  });

  describe("audit history", () => {
    it("records who changed what, from trusted context", async () => {
      const { priya } = await setUp();
      await update(priya, { dueDate: "2026-11-13", status: "in_progress" });

      const rows = await getDb()
        .select()
        .from(schema.changes)
        .where(
          and(
            eq(schema.changes.entityId, priya.id),
            eq(schema.changes.operation, "update"),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: "user",
        actorId: OWNER,
        beforeState: { dueDate: "2026-11-06", status: "open" },
        afterState: { dueDate: "2026-11-13", status: "in_progress" },
      });

      const history = await historyFor(priya.id);
      expect(history.entries[0]).toMatchObject({
        operation: "update",
        actorId: OWNER,
      });
      expect(history.entries[0]!.fields).toEqual([
        { field: "dueDate", before: "2026-11-06", after: "2026-11-13" },
        { field: "status", before: "open", after: "in_progress" },
        // Setting the date settled the deadline flag, and the history says so.
        { field: "reviewFlags", before: ["deadline"], after: [] },
      ]);
      // The record saved with the analysis is still the oldest entry.
      expect(history.entries[history.entries.length - 1]).toMatchObject({
        operation: "create",
        actorType: "agent",
      });
    });

    it("attributes an agent's edit to the agent", async () => {
      const { aarav } = await setUp();
      await update(aarav, { priority: "low" }, OWNER, "tool");
      const history = await historyFor(aarav.id);
      expect(history.entries[0]).toMatchObject({
        actorType: "agent",
        actorId: OWNER,
      });
    });

    it("writes no record when nothing changes", async () => {
      const { priya } = await setUp();
      const before = (await historyFor(priya.id)).entries.length;
      const result = await update(priya, {
        dueDate: priya.dueDate,
        priority: null,
        description: priya.description,
      });
      expect(result).toMatchObject({ changed: false, changedFields: [] });
      expect(result.commitment.version).toBe(priya.version);
      expect((await historyFor(priya.id)).entries).toHaveLength(before);
    });

    it("names the owner in the history", async () => {
      const { projectId, priya } = await setUp();
      const p = await person(projectId, "Priya Sharma");
      const assigned = await update(priya, { ownerId: p.id });
      await update(assigned.commitment, { ownerId: null });
      const history = await historyFor(priya.id);
      expect(history.entries[0]!.fields).toEqual([
        { field: "owner", before: "Priya Sharma", after: null },
      ]);
      expect(history.entries[1]!.fields).toEqual([
        { field: "owner", before: null, after: "Priya Sharma" },
      ]);
    });

    it("is readable by a viewer and hidden from everyone else", async () => {
      const { projectId, meeting, priya } = await setUp();
      await call(publishMeetingAnalysis, {
        meetingId: meeting.id,
        expectedContentRevision: 1,
      });
      await getDb().insert(schema.projectShares).values({
        id: crypto.randomUUID(),
        resourceId: projectId,
        principalType: "user",
        principalId: OTHER,
        role: "viewer",
        createdBy: OWNER,
      });
      await expect(historyFor(priya.id, OTHER)).resolves.toBeDefined();
      const error = await rejection(historyFor(priya.id, "third@example.test"));
      expect(error).toMatchObject({ errorCode: "access_denied" });
    });
  });
});

describe("people", () => {
  it("adds and lists participants of the project only", async () => {
    const first = await setUp();
    const second = await setUp();
    await person(first.projectId, "Priya Sharma", ["Priya"]);
    await person(second.projectId, "Dana");

    const listed = await call<{ displayName: string; aliases: string[] }[]>(
      listPeople,
      { projectId: first.projectId },
    );
    expect(listed.map((p) => p.displayName)).toEqual(["Priya Sharma"]);
    expect(listed[0]!.aliases).toEqual(["Priya"]);
  });

  it("needs no Pactlane account or email", async () => {
    const { projectId } = await setUp();
    const added = await call<{ person: { email: string | null } }>(addPerson, {
      projectId,
      displayName: "Contractor",
    });
    expect(added.person.email).toBeNull();
  });

  it("does not create a duplicate, and points at the existing person", async () => {
    const { projectId } = await setUp();
    const existing = await person(projectId, "Priya Sharma", ["Priya"]);

    for (const attempt of [
      { displayName: " priya sharma " },
      { displayName: "Priya" },
      { displayName: "P. Sharma", aliases: ["PRIYA"] },
    ]) {
      const error = await rejection(call(addPerson, { projectId, ...attempt }));
      expect(error).toMatchObject({ errorCode: "person_exists" });
      expect(error.details?.matches).toEqual([
        { id: existing.id, displayName: "Priya Sharma" },
      ]);
    }
    const listed = await call<unknown[]>(listPeople, { projectId });
    expect(listed).toHaveLength(1);
  });

  it("does not merge a similar but different name", async () => {
    const { projectId } = await setUp();
    await person(projectId, "Priya Sharma");
    await person(projectId, "Priya Nair");
    const listed = await call<unknown[]>(listPeople, { projectId });
    expect(listed).toHaveLength(2);
  });

  it("requires editor access to add and viewer access to list", async () => {
    const { projectId } = await setUp();
    await getDb().insert(schema.projectShares).values({
      id: crypto.randomUUID(),
      resourceId: projectId,
      principalType: "user",
      principalId: OTHER,
      role: "viewer",
      createdBy: OWNER,
    });
    await expect(call(listPeople, { projectId }, OTHER)).resolves.toBeDefined();
    const denied = await rejection(
      call(addPerson, { projectId, displayName: "Sam" }, OTHER),
    );
    expect(denied).toMatchObject({ errorCode: "access_denied" });
    const stranger = await rejection(
      call(listPeople, { projectId }, "third@example.test"),
    );
    expect(stranger).toMatchObject({ errorCode: "access_denied" });
  });

  it("records who added a person", async () => {
    const { projectId } = await setUp();
    const added = await person(projectId, "Sam");
    const [row] = await getDb()
      .select()
      .from(schema.changes)
      .where(eq(schema.changes.entityId, added.id));
    expect(row).toMatchObject({
      entityType: "person",
      actorType: "user",
      actorId: OWNER,
    });
  });
});

describe("review", () => {
  it("keeps a missing quotation unverified after a person confirms it", async () => {
    const { meera } = await setUp();
    expect(meera.evidence[0]).toMatchObject({ verificationStatus: "missing" });
    const open = meera.reviewFlags.map((f) => f.code);
    expect(open).toContain("evidence");

    const confirmed = await review(meera, "confirm", open);

    expect(confirmed.commitment).toMatchObject({
      reviewState: "confirmed",
      reviewedBy: OWNER,
      needsReview: false,
      reviewFlags: [],
    });
    const stored = await evidenceFor(meera.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      sourceQuote: "Meera owns the deployment",
      verificationStatus: "missing",
      sourceStart: null,
    });
    // What is shown to the reader still says the words are not in the transcript.
    expect(confirmed.commitment.evidence[0]!.verificationStatus).toBe(
      "missing",
    );
  });

  it("clears only the flags that were named", async () => {
    const { meera } = await setUp();
    const codes = meera.reviewFlags.map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(["evidence", "owner"]));

    const partial = await review(meera, "confirm", ["owner"]);

    expect(partial.commitment.reviewFlags.map((f) => f.code)).toEqual(
      codes.filter((c) => c !== "owner"),
    );
    expect(partial.commitment).toMatchObject({
      needsReview: true,
      reviewState: "proposed",
    });
    expect(partial.commitment.reviewReason).not.toContain("Meera");
    expect(partial.commitment.reviewReason).toContain("not found");
  });

  it("requires the flags to be named and open", async () => {
    const { meera } = await setUp();
    expect(await rejection(review(meera, "confirm"))).toMatchObject({
      errorCode: "flags_not_listed",
    });
    expect(await rejection(review(meera, "confirm", ["legacy"]))).toMatchObject(
      {
        errorCode: "flag_not_open",
      },
    );
  });

  it("confirms a commitment that has nothing to resolve", async () => {
    const { priya } = await setUp();
    const open = priya.reviewFlags.map((f) => f.code);
    const resolved = await review(priya, "confirm", open);
    const again = await review(resolved.commitment, "confirm");
    expect(again.changed).toBe(false);
    expect(again.commitment.version).toBe(resolved.commitment.version);
  });

  it("clears the matching flag when a person corrects the field", async () => {
    const { projectId, priya } = await setUp();
    expect(priya.reviewFlags.map((f) => f.code)).toEqual(["deadline"]);
    const priyaPerson = await person(projectId, "Priya Sharma");

    const corrected = await update(priya, {
      dueDate: "2026-11-13",
      ownerId: priyaPerson.id,
    });
    expect(corrected.commitment).toMatchObject({
      reviewFlags: [],
      needsReview: false,
    });
  });

  it("leaves unrelated flags when a person corrects one field", async () => {
    const { meera } = await setUp();
    const corrected = await update(meera, { dueDate: "2026-11-20" });
    // The deadline was never flagged: the evidence and owner flags stay.
    expect(corrected.commitment.reviewFlags.map((f) => f.code).sort()).toEqual(
      meera.reviewFlags.map((f) => f.code).sort(),
    );
    expect(corrected.commitment.needsReview).toBe(true);
  });

  it("does not let an agent's edit clear a flag, and withdraws a confirmation", async () => {
    const { projectId, priya } = await setUp();
    const p = await person(projectId, "Priya Sharma");

    const byAgent = await update(
      priya,
      { dueDate: "2026-11-13" },
      OWNER,
      "tool",
    );
    expect(byAgent.commitment.reviewFlags.map((f) => f.code)).toEqual([
      "deadline",
    ]);

    const confirmed = await review(byAgent.commitment, "confirm", ["deadline"]);
    expect(confirmed.commitment.reviewState).toBe("confirmed");
    const edited = await update(
      confirmed.commitment,
      { ownerId: p.id },
      OWNER,
      "tool",
    );
    expect(edited.commitment).toMatchObject({
      reviewState: "proposed",
      reviewedBy: null,
    });
  });

  it("allows review from the signed-in app UI", async () => {
    const { priya } = await setUp();
    const result = await review(
      priya,
      "confirm",
      priya.reviewFlags.map((flag) => flag.code),
      "frontend",
    );
    expect(result.commitment.reviewState).toBe("confirmed");
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
  ] as ActionCaller[])(
    "refuses the %s caller before review",
    async (caller) => {
      const { priya } = await setUp();
      const error = await rejection(review(priya, "reject", [], caller));
      expect(error).toMatchObject({
        errorCode: "ui_only_action",
        statusCode: 403,
      });

      const [stored] = await getDb()
        .select()
        .from(schema.commitments)
        .where(eq(schema.commitments.id, priya.id));
      expect(stored).toMatchObject({
        version: priya.version,
        reviewState: priya.reviewState,
        reviewedBy: null,
      });
      expect(
        reviewCommitment as unknown as {
          agentTool?: boolean;
          uiOnly?: boolean;
        },
      ).toMatchObject({ agentTool: false, uiOnly: true });
    },
  );

  it("denies review to a user without editor access", async () => {
    const { priya } = await setUp();
    const error = await rejection(
      call(
        reviewCommitment,
        { id: priya.id, expectedVersion: 1, outcome: "reject" },
        OTHER,
      ),
    );
    expect(error).toMatchObject({ errorCode: "access_denied" });
  });

  it("detects a conflicting review", async () => {
    const { aarav } = await setUp();
    await update(aarav, { priority: "low" });
    const error = await rejection(review(aarav, "reject"));
    expect(error).toMatchObject({ errorCode: "version_conflict" });
  });

  describe("rejecting", () => {
    it("keeps the commitment, its evidence and its history", async () => {
      const { meeting, meera } = await setUp();
      const rejected = await review(meera, "reject");

      expect(rejected.commitment).toMatchObject({
        reviewState: "rejected",
        reviewedBy: OWNER,
        needsReview: false,
      });
      const [row] = await getDb()
        .select()
        .from(schema.commitments)
        .where(eq(schema.commitments.id, meera.id));
      expect(row).toBeDefined();
      expect(await evidenceFor(meera.id)).toHaveLength(1);

      const history = await historyFor(meera.id);
      expect(history.entries.map((e) => e.operation)).toEqual([
        "update",
        "create",
      ]);
      expect(history.entries[0]!.fields).toEqual([
        { field: "reviewState", before: "proposed", after: "rejected" },
      ]);

      const result = await call<Meeting>(getMeeting, { id: meeting.id });
      expect(result.commitments.map((c) => c.id)).toContain(meera.id);
    });

    it("refuses edits and confirmation until it is restored", async () => {
      const { meera } = await setUp();
      const rejected = await review(meera, "reject");
      expect(
        await rejection(update(rejected.commitment, { priority: "low" })),
      ).toMatchObject({ errorCode: "commitment_rejected" });
      expect(
        await rejection(review(rejected.commitment, "confirm", ["owner"])),
      ).toMatchObject({ errorCode: "commitment_rejected" });

      const restored = await review(rejected.commitment, "restore");
      expect(restored.commitment).toMatchObject({
        reviewState: "proposed",
        reviewedBy: null,
        needsReview: true,
      });
      expect(restored.commitment.reviewFlags).toEqual(meera.reviewFlags);
      await expect(
        update(restored.commitment, { priority: "low" }),
      ).resolves.toMatchObject({ changed: true });
    });

    it("only restores what was rejected", async () => {
      const { priya } = await setUp();
      expect(await rejection(review(priya, "restore"))).toMatchObject({
        errorCode: "not_rejected",
      });
    });
  });
});

describe("existing data", () => {
  it("turns a flag saved before structured flags into one legacy flag", async () => {
    const { meera } = await setUp();
    await getDb()
      .update(schema.commitments)
      .set({ reviewFlags: [], needsReview: true, reviewReason: "Old note." })
      .where(eq(schema.commitments.id, meera.id));

    // Runs the backfill statement of the real migration.
    const backfill = (migrations[2]!.sql as string)
      .split(/;\s*\n/)
      .find((statement) => statement.trim().startsWith("UPDATE commitments"))!;
    await getDbExec().execute(backfill);

    const [row] = await getDb()
      .select()
      .from(schema.commitments)
      .where(eq(schema.commitments.id, meera.id));
    expect(row!.reviewFlags).toEqual([
      { code: "legacy", message: "Old note." },
    ]);
    expect(row!.needsReview).toBe(true);
  });
});
