import { describe, expect, it } from "vitest";

import {
  buildPatch,
  describeFailure,
  draftFromCommitment,
  findParticipant,
  selectableStatuses,
} from "./commitment-edit";
import {
  buildSegments,
  unlocatedQuotes,
  type EvidenceRange,
} from "./transcript-highlight";

const saved = {
  description: "Prepare the landing page",
  ownerId: null,
  dueDate: "2026-11-06",
  priority: null,
  status: "open" as const,
};

describe("building a patch from the form", () => {
  it("sends nothing for an untouched form", () => {
    expect(buildPatch(saved, draftFromCommitment(saved))).toEqual({
      ok: true,
      patch: {},
      changed: false,
    });
  });

  it("sends only the fields that differ", () => {
    const draft = {
      ...draftFromCommitment(saved),
      dueDate: "2026-11-13",
      ownerId: "person-1",
      status: "in_progress" as const,
    };
    expect(buildPatch(saved, draft)).toEqual({
      ok: true,
      changed: true,
      patch: {
        dueDate: "2026-11-13",
        ownerId: "person-1",
        status: "in_progress",
      },
    });
  });

  it("sends null to clear a field", () => {
    const withValues = { ...saved, ownerId: "p", priority: "high" };
    const draft = {
      ...draftFromCommitment(withValues),
      ownerId: "",
      dueDate: "",
      priority: "",
    };
    expect(buildPatch(withValues, draft)).toMatchObject({
      patch: { ownerId: null, dueDate: null, priority: null },
    });
  });

  it("ignores whitespace-only description changes", () => {
    const draft = {
      ...draftFromCommitment(saved),
      description: "  Prepare the landing page ",
    };
    expect(buildPatch(saved, draft)).toMatchObject({ changed: false });
  });

  it("reports a blank description or a malformed date before sending", () => {
    expect(
      buildPatch(saved, { ...draftFromCommitment(saved), description: "  " }),
    ).toMatchObject({ ok: false, field: "description" });
    expect(
      buildPatch(saved, { ...draftFromCommitment(saved), dueDate: "6/11/26" }),
    ).toMatchObject({ ok: false, field: "dueDate" });
  });

  it("offers only the moves the server allows", () => {
    expect(selectableStatuses("completed")).toEqual([
      "completed",
      "open",
      "in_progress",
    ]);
    expect(selectableStatuses("cancelled")).toEqual(["cancelled", "open"]);
  });
});

describe("describing a failed save", () => {
  it("recognises a conflict so the form can offer the latest version", () => {
    expect(
      describeFailure({ errorCode: "version_conflict", actionMessage: "x" }),
    ).toMatchObject({ kind: "conflict" });
  });

  it("explains a refused permission without the server's wording", () => {
    const result = describeFailure({ errorCode: "access_denied" });
    expect(result.kind).toBe("denied");
    expect(result.message).toMatch(/permission/);
  });

  it("shows the server's own validation message", () => {
    expect(
      describeFailure({
        errorCode: "invalid_transition",
        actionMessage: "A completed commitment cannot become cancelled.",
      }),
    ).toEqual({
      kind: "invalid",
      message: "A completed commitment cannot become cancelled.",
    });
  });

  it("falls back to a retry message when the server never answered", () => {
    expect(describeFailure(new Error("Failed to fetch"))).toMatchObject({
      kind: "other",
    });
    expect(describeFailure(null)).toMatchObject({ kind: "other" });
  });
});

describe("matching a stated name to participants", () => {
  const people = [
    { id: "1", displayName: "Priya Sharma", aliases: ["Priya"] },
    { id: "2", displayName: "Priya Nair", aliases: [] },
  ];
  it("matches by name or alias, case-insensitively", () => {
    expect(findParticipant(" priya ", people).map((p) => p.id)).toEqual(["1"]);
    expect(findParticipant("priya nair", people).map((p) => p.id)).toEqual([
      "2",
    ]);
  });
  it("does not guess from a partial name", () => {
    expect(findParticipant("Aarav", people)).toEqual([]);
    expect(findParticipant(null, people)).toEqual([]);
  });
});

describe("highlighting evidence in the transcript", () => {
  const transcript = "Priya will finish it. Aarav will help.";
  const evidence = (over: Partial<EvidenceRange>): EvidenceRange => ({
    sourceQuote: "Aarav will help.",
    sourceStart: 22,
    sourceEnd: 38,
    verificationStatus: "verified",
    ...over,
  });

  it("marks a verified quotation where the server located it", () => {
    expect(buildSegments(transcript, [evidence({})])).toEqual([
      { text: "Priya will finish it. ", highlighted: false },
      { text: "Aarav will help.", highlighted: true },
    ]);
  });

  it("never highlights offsets that no longer match the words", () => {
    const stale = evidence({ sourceStart: 0, sourceEnd: 16 });
    expect(buildSegments(transcript, [stale])).toEqual([
      { text: transcript, highlighted: false },
    ]);
    expect(unlocatedQuotes(transcript, [stale])).toHaveLength(1);
  });

  it("does not highlight a quotation the server could not verify", () => {
    const missing = evidence({
      sourceQuote: "Meera owns the deployment",
      sourceStart: null,
      sourceEnd: null,
      verificationStatus: "missing",
    });
    expect(buildSegments(transcript, [missing])).toEqual([
      { text: transcript, highlighted: false },
    ]);
    expect(unlocatedQuotes(transcript, [missing])).toEqual([missing]);
  });
});
