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
}

function evidenceReasons(quotes: ReviewedQuote[]): string[] {
  if (quotes.length === 0) return ["No supporting quotation was provided."];
  const counts = { missing: 0, ambiguous: 0 };
  for (const { verification } of quotes) {
    if (verification.status !== "verified") counts[verification.status] += 1;
  }
  const reasons: string[] = [];
  const quotations = (count: number) =>
    `${count} quotation${count === 1 ? "" : "s"}`;
  if (counts.missing > 0) {
    reasons.push(`${quotations(counts.missing)} not found in the transcript.`);
  }
  if (counts.ambiguous > 0) {
    reasons.push(
      `${quotations(counts.ambiguous)} found more than once in the transcript.`,
    );
  }
  return reasons;
}

function toReview(reasons: string[], note: string | null) {
  const all = note?.trim() ? [...reasons, note.trim()] : reasons;
  return {
    needsReview: all.length > 0,
    reviewReason: all.length > 0 ? all.join(" ") : null,
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
    reasons.push("No owner was stated.");
  } else if (claims.ownerBasis === "inferred") {
    reasons.push(`Owner "${ownerName}" is inferred, not stated. Confirm it.`);
  } else if (!verified.some((quote) => containsName(quote, ownerName))) {
    reasons.push(
      `Proposed owner "${ownerName}" is not supported by verified evidence.`,
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
        `"${ownerName}" matches more than one person in this project.`,
      );
    }
  }

  let dueDate: string | null = null;
  let statedDueText: string | null = null;
  const { dueDateText } = claims;
  if (dueDateText !== null) {
    if (!verified.some((quote) => quote.includes(dueDateText))) {
      reasons.push(
        `Proposed deadline "${dueDateText}" is not supported by verified evidence.`,
      );
    } else {
      statedDueText = dueDateText;
      dueDate = claims.dueDate;
      if (dueDate === null) {
        reasons.push(`Deadline "${dueDateText}" has no calendar date yet.`);
      } else if (
        claims.dueDateBasis !== "explicit" ||
        !/\d/.test(dueDateText)
      ) {
        reasons.push(
          `Date ${dueDate} is interpreted from "${dueDateText}". Confirm it.`,
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
  return toReview(evidenceReasons(quotes), reviewNote);
}
