import { describe, expect, it } from "vitest";

import {
  formatDay,
  matchesLedgerFilter,
  meetingHighlightPath,
} from "./trail-format";

const entry = (overrides: {
  status?: string;
  reviewState?: string;
  needsReview?: boolean;
  overdue?: boolean;
  revisited?: boolean;
}) => ({
  status: overrides.status ?? "open",
  reviewState: overrides.reviewState ?? "proposed",
  health: {
    needsReview: overrides.needsReview ?? false,
    overdue: overrides.overdue ?? false,
    revisited: overrides.revisited ?? false,
  },
});

describe("filtering the ledger", () => {
  it("hides rejected commitments everywhere but their own filter", () => {
    const rejected = entry({ reviewState: "rejected", overdue: true });
    expect(matchesLedgerFilter(rejected, "active")).toBe(false);
    expect(matchesLedgerFilter(rejected, "overdue")).toBe(false);
    expect(matchesLedgerFilter(rejected, "rejected")).toBe(true);
  });

  it("matches each signal on its own", () => {
    expect(matchesLedgerFilter(entry({ overdue: true }), "overdue")).toBe(true);
    expect(matchesLedgerFilter(entry({}), "overdue")).toBe(false);
    expect(matchesLedgerFilter(entry({ revisited: true }), "revisited")).toBe(
      true,
    );
    expect(
      matchesLedgerFilter(entry({ needsReview: true }), "needsReview"),
    ).toBe(true);
    expect(
      matchesLedgerFilter(entry({ status: "completed" }), "completed"),
    ).toBe(true);
  });
});

describe("formatting", () => {
  it("does not let a time zone move a date-only value", () => {
    expect(formatDay("2026-11-06")).toMatch(/6/);
    expect(formatDay("2026-11-06")).not.toMatch(/\b5\b/);
  });

  it("builds a source link that names the item to highlight", () => {
    expect(meetingHighlightPath("m1", "c 1")).toBe(
      "/meetings/m1?highlight=c%201",
    );
  });
});
