import type { ReviewFlag, ReviewFlagCode } from "../../shared/domain.js";
import { containsName, type QuoteVerification } from "./evidence.js";

type Basis = "explicit" | "inferred";

export interface PersonRecord {
  id: string;
  displayName: string;
  aliases: string[];
}

export interface ReviewedQuote {
  quote: string;
  verification: QuoteVerification;
}

export interface CommitmentClaims {
  ownerName: string | null;
  ownerBasis: Basis | null;
  dueDate: string | null;
  dueDateText: string | null;
  dueDateBasis: Basis | null;
  reviewNote: string | null;
}

export interface CommitmentFields {
  ownerId: string | null;
  statedOwnerName: string | null;
  dueDate: string | null;
  statedDueText: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  reviewFlags: ReviewFlag[];
}

export interface NextMeetingClaims {
  proposedDate: string | null;
  dateText: string | null;
  dateBasis: Basis | null;
  proposedTime: string | null;
  timeText: string | null;
  participants: string[];
  reviewNote: string | null;
}

export interface NextMeetingFields {
  proposedDate: string | null;
  statedDateText: string | null;
  dateBasis: Basis | null;
  proposedTime: string | null;
  statedTimeText: string | null;
  participants: string[];
  needsReview: boolean;
  reviewReason: string | null;
}

const flag = (code: ReviewFlagCode, message: string): ReviewFlag => ({
  code,
  message,
});

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/** Parses only unambiguous English calendar dates or ISO dates. */
function parseCalendarDate(value: string): string | null {
  const normalized = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
  if (iso) {
    const date = new Date(`${normalized}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : normalized;
  }

  const monthDayYear =
    /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*|\s+)(\d{4})$/.exec(
      normalized,
    );
  const dayMonthYear =
    /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(normalized);
  const parts = monthDayYear
    ? {
        month: monthDayYear[1]!,
        day: Number(monthDayYear[2]),
        year: Number(monthDayYear[3]),
      }
    : dayMonthYear
      ? {
          month: dayMonthYear[2]!,
          day: Number(dayMonthYear[1]),
          year: Number(dayMonthYear[3]),
        }
      : null;
  if (!parts) return null;

  const month = MONTHS[parts.month.toLowerCase()];
  if (!month) return null;
  const date = new Date(Date.UTC(parts.year, month - 1, parts.day));
  if (
    date.getUTCFullYear() !== parts.year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== parts.day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** Parses a stated wall-clock time without assigning a timezone to it. */
function parseClockTime(value: string): string | null {
  const normalized = value.trim();
  const twentyFour = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(normalized);
  if (twentyFour) {
    return `${twentyFour[1]!.padStart(2, "0")}:${twentyFour[2]}`;
  }
  const twelveHour = /^(\d{1,2})(?::([0-5]\d))?\s*([ap])\.?m\.?$/i.exec(
    normalized,
  );
  if (!twelveHour) return null;
  const hour = Number(twelveHour[1]);
  if (hour < 1 || hour > 12) return null;
  const hour24 = (hour % 12) + (twelveHour[3]!.toLowerCase() === "p" ? 12 : 0);
  return `${hour24.toString().padStart(2, "0")}:${twelveHour[2] ?? "00"}`;
}

/** The one place that turns open flags into the stored summary text. */
export function summarizeFlags(flags: ReviewFlag[]) {
  return flags.length > 0 ? flags.map((f) => f.message).join(" ") : null;
}

function evidenceReasons(quotes: ReviewedQuote[]): ReviewFlag[] {
  if (quotes.length === 0) {
    return [flag("evidence", "No supporting quotation was provided.")];
  }
  const counts = { missing: 0, ambiguous: 0 };
  for (const { verification } of quotes) {
    if (verification.status !== "verified") counts[verification.status] += 1;
  }
  const reasons: ReviewFlag[] = [];
  const quotations = (count: number) =>
    `${count} quotation${count === 1 ? "" : "s"}`;
  if (counts.missing > 0) {
    reasons.push(
      flag(
        "evidence",
        `${quotations(counts.missing)} not found in the transcript.`,
      ),
    );
  }
  if (counts.ambiguous > 0) {
    reasons.push(
      flag(
        "evidence",
        `${quotations(counts.ambiguous)} found more than once in the transcript.`,
      ),
    );
  }
  return reasons;
}

function toReview(reasons: ReviewFlag[], note: string | null) {
  const all = note?.trim() ? [...reasons, flag("note", note.trim())] : reasons;
  return {
    needsReview: all.length > 0,
    reviewReason: summarizeFlags(all),
    reviewFlags: all,
  };
}

/**
 * Decides what a commitment's proposed owner and deadline may become. A value
 * is kept only when a verified quote contains its words. Everything else stays
 * empty, with the proposal named in the review reason so a person can act on it.
 */
export function reviewCommitment(
  claims: CommitmentClaims,
  quotes: ReviewedQuote[],
  people: PersonRecord[],
): CommitmentFields {
  const reasons = evidenceReasons(quotes);
  const verified = quotes
    .filter((q) => q.verification.status === "verified")
    .map((q) => q.quote);

  let ownerId: string | null = null;
  let statedOwnerName: string | null = null;
  const { ownerName } = claims;
  if (ownerName === null) {
    reasons.push(flag("owner", "No owner was stated."));
  } else if (claims.ownerBasis === "inferred") {
    reasons.push(
      flag(
        "owner",
        `Owner "${ownerName}" is inferred, not stated. Confirm it.`,
      ),
    );
  } else if (!verified.some((quote) => containsName(quote, ownerName))) {
    reasons.push(
      flag(
        "owner",
        `Proposed owner "${ownerName}" is not supported by verified evidence.`,
      ),
    );
  } else {
    statedOwnerName = ownerName;
    const key = ownerName.trim().toLowerCase();
    const matches = people.filter((person) =>
      [person.displayName, ...person.aliases].some(
        (name) => name.trim().toLowerCase() === key,
      ),
    );
    if (matches.length === 1) ownerId = matches[0]!.id;
    if (matches.length > 1) {
      reasons.push(
        flag(
          "owner",
          `"${ownerName}" matches more than one person in this project.`,
        ),
      );
    }
  }

  let dueDate: string | null = null;
  let statedDueText: string | null = null;
  const { dueDateText } = claims;
  if (dueDateText !== null) {
    if (!verified.some((quote) => quote.includes(dueDateText))) {
      reasons.push(
        flag(
          "deadline",
          `Proposed deadline "${dueDateText}" is not supported by verified evidence.`,
        ),
      );
    } else {
      statedDueText = dueDateText;
      dueDate = claims.dueDate;
      if (dueDate === null) {
        reasons.push(
          flag(
            "deadline",
            `Deadline "${dueDateText}" has no calendar date yet.`,
          ),
        );
      } else if (
        claims.dueDateBasis !== "explicit" ||
        !/\d/.test(dueDateText)
      ) {
        reasons.push(
          flag(
            "deadline",
            `Date ${dueDate} is interpreted from "${dueDateText}". Confirm it.`,
          ),
        );
      }
    }
  }

  return {
    ownerId,
    statedOwnerName,
    dueDate,
    statedDueText,
    ...toReview(reasons, claims.reviewNote),
  };
}

export function reviewDecision(
  reviewNote: string | null,
  quotes: ReviewedQuote[],
) {
  const { needsReview, reviewReason } = toReview(
    evidenceReasons(quotes),
    reviewNote,
  );
  return { needsReview, reviewReason };
}

/**
 * Keeps only scheduling claims supported by exact, verified transcript text.
 * The result remains a suggestion for human review; it never books anything.
 */
export function reviewNextMeetingSuggestion(
  claims: NextMeetingClaims,
  quotes: ReviewedQuote[],
): NextMeetingFields {
  const reasons = evidenceReasons(quotes);
  const verified = quotes
    .filter((quote) => quote.verification.status === "verified")
    .map((quote) => quote.quote);

  let proposedDate: string | null = null;
  let statedDateText: string | null = null;
  let dateBasis: Basis | null = null;
  if (claims.dateText !== null) {
    if (!verified.some((quote) => quote.includes(claims.dateText!))) {
      reasons.push(
        flag(
          "deadline",
          `Proposed next-meeting date "${claims.dateText}" is not supported by verified evidence.`,
        ),
      );
    } else {
      statedDateText = claims.dateText;
      if (claims.proposedDate === null) {
        reasons.push(
          flag(
            "deadline",
            `Next-meeting date "${claims.dateText}" has no calendar date yet.`,
          ),
        );
      } else if (claims.dateBasis !== "explicit") {
        reasons.push(
          flag(
            "deadline",
            `Next-meeting date "${claims.dateText}" is relative and remains unresolved.`,
          ),
        );
      } else {
        const statedDate = parseCalendarDate(claims.dateText);
        if (statedDate === null) {
          reasons.push(
            flag(
              "deadline",
              `Next-meeting date "${claims.dateText}" could not be resolved safely.`,
            ),
          );
        } else if (statedDate !== claims.proposedDate) {
          reasons.push(
            flag(
              "deadline",
              `Proposed next-meeting date ${claims.proposedDate} does not match "${claims.dateText}".`,
            ),
          );
        } else {
          proposedDate = statedDate;
          dateBasis = "explicit";
        }
      }
    }
  }

  let proposedTime: string | null = null;
  let statedTimeText: string | null = null;
  if (claims.timeText !== null) {
    if (!verified.some((quote) => quote.includes(claims.timeText!))) {
      reasons.push(
        flag(
          "note",
          `Proposed next-meeting time "${claims.timeText}" is not supported by verified evidence.`,
        ),
      );
    } else {
      statedTimeText = claims.timeText;
      if (claims.proposedTime === null) {
        reasons.push(
          flag("note", `Next-meeting time "${claims.timeText}" is unresolved.`),
        );
      } else {
        const statedTime = parseClockTime(claims.timeText);
        if (statedTime === null) {
          reasons.push(
            flag(
              "note",
              `Next-meeting time "${claims.timeText}" could not be resolved safely.`,
            ),
          );
        } else if (statedTime !== claims.proposedTime) {
          reasons.push(
            flag(
              "note",
              `Proposed next-meeting time ${claims.proposedTime} does not match "${claims.timeText}".`,
            ),
          );
        } else {
          proposedTime = statedTime;
        }
      }
    }
  }

  const participants = claims.participants.filter((participant) => {
    const supported = verified.some((quote) =>
      containsName(quote, participant),
    );
    if (!supported) {
      reasons.push(
        flag(
          "owner",
          `Proposed participant "${participant}" is not supported by verified evidence.`,
        ),
      );
    }
    return supported;
  });

  return {
    proposedDate,
    statedDateText,
    dateBasis,
    proposedTime,
    statedTimeText,
    participants,
    ...toReview(reasons, claims.reviewNote),
  };
}
