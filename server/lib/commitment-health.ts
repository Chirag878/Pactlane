import { z } from "zod";

import {
  COMMITMENT_STATUSES,
  type CommitmentStatus,
  type ReviewFlag,
  type ReviewState,
} from "../../shared/domain.js";

export const commitmentHealthResult = z.object({
  status: z.enum(COMMITMENT_STATUSES),
  overdue: z.boolean().describe("Only true for a confirmed, past due date"),
  daysOverdue: z.number().nullable(),
  dueDateConfirmed: z
    .boolean()
    .describe("A due date exists and no review flag questions it"),
  revisited: z
    .boolean()
    .describe("Verified evidence exists from two or more distinct meetings"),
  needsReview: z.boolean(),
  meetingCount: z.number(),
  verifiedMeetingCount: z.number(),
  firstMeetingDate: z.string().nullable(),
  latestMeetingDate: z.string().nullable(),
  facts: z
    .array(z.string())
    .describe("Sentences derived only from saved data, safe to repeat"),
});

export type CommitmentHealth = z.infer<typeof commitmentHealthResult>;

export interface HealthEvidence {
  meetingId: string;
  verificationStatus: string;
  linkedBy: string | null;
}

export interface HealthInput {
  status: CommitmentStatus;
  dueDate: string | null;
  reviewState: ReviewState;
  needsReview: boolean;
  reviewFlags: ReviewFlag[];
  originMeetingId: string | null;
  evidence: HealthEvidence[];
}

const UNFINISHED: readonly CommitmentStatus[] = [
  "open",
  "in_progress",
  "blocked",
];

const STATUS_WORDS: Record<CommitmentStatus, string> = {
  open: "open",
  in_progress: "in progress",
  blocked: "blocked",
  completed: "completed",
  cancelled: "cancelled",
};

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * Derives a commitment's health from what is saved, without a model. It reports
 * the current state only: nothing here claims the work was unfinished at some
 * past date, and repeated mentions are never counted as delays.
 *
 * `meetingDates` maps a meeting id to its calendar date.
 */
export function commitmentHealth(
  input: HealthInput,
  meetingDates: ReadonlyMap<string, string>,
  asOf: string,
): CommitmentHealth {
  // Only the origin meeting and links a person confirmed count as related.
  const confirmed = input.evidence.filter(
    (e) => e.meetingId === input.originMeetingId || e.linkedBy !== null,
  );
  const meetingIds = new Set(confirmed.map((e) => e.meetingId));
  if (input.originMeetingId) meetingIds.add(input.originMeetingId);
  const verifiedMeetingIds = new Set(
    confirmed
      .filter((e) => e.verificationStatus === "verified")
      .map((e) => e.meetingId),
  );
  const dates = [...meetingIds]
    .map((id) => meetingDates.get(id))
    .filter((date): date is string => date !== undefined)
    .sort();
  const firstMeetingDate = dates[0] ?? null;
  const latestMeetingDate = dates[dates.length - 1] ?? null;

  const rejected = input.reviewState === "rejected";
  const unfinished = UNFINISHED.includes(input.status) && !rejected;
  const dueDateConfirmed =
    input.dueDate !== null &&
    !input.reviewFlags.some(
      (flag) => flag.code === "deadline" || flag.code === "legacy",
    );
  const pastDue = input.dueDate !== null && input.dueDate < asOf;
  const overdue = unfinished && dueDateConfirmed && pastDue;
  const daysOverdue = overdue
    ? dayNumber(asOf) - dayNumber(input.dueDate!)
    : null;
  const revisited = verifiedMeetingIds.size >= 2;

  const facts: string[] = [];
  if (rejected) facts.push("A person rejected this commitment.");
  if (meetingIds.size >= 2) {
    facts.push(
      `Linked to ${plural(meetingIds.size, "meeting")}, from ${firstMeetingDate} to ${latestMeetingDate}.`,
    );
    if (verifiedMeetingIds.size < meetingIds.size) {
      facts.push(
        `Only ${plural(verifiedMeetingIds.size, "meeting")} ${verifiedMeetingIds.size === 1 ? "has" : "have"} a quotation verified against the transcript.`,
      );
    }
  }
  facts.push(`Currently marked ${STATUS_WORDS[input.status]}.`);
  if (overdue) {
    facts.push(
      `Due ${input.dueDate}, ${plural(daysOverdue!, "day")} before ${asOf}, and not marked completed.`,
    );
  } else if (unfinished && input.dueDate === null) {
    facts.push("No due date is recorded, so it cannot be called overdue.");
  } else if (unfinished && pastDue) {
    facts.push(
      `Due date ${input.dueDate} still has an open review flag, so overdue is not claimed.`,
    );
  }

  return {
    status: input.status,
    overdue,
    daysOverdue,
    dueDateConfirmed,
    revisited,
    needsReview: input.needsReview,
    meetingCount: meetingIds.size,
    verifiedMeetingCount: verifiedMeetingIds.size,
    firstMeetingDate,
    latestMeetingDate,
    facts,
  };
}
