import { containsName } from "./evidence.js";

/**
 * Finds statements in a meeting that may refer to a known commitment. It is
 * deterministic and deliberately modest: every result is a suggestion for a
 * person, with plain reasons and no confidence number.
 */

const STOP_WORDS = new Set(
  `a an the and or but of to in on at by for from with about as is are was were be been being it its this that these those
  we you they he she i me my our your their his her them us will would shall should can could may might must do does did done
  have has had not no nor yet still already just very too also so if then than there here need needs needed more most less
  time get gets got make makes made said say says told team someone everyone anyone people
  complete completed completing finish finished finishing unfinished incomplete prepare prepared preparing deliver delivered
  delivering work working worked build built building create created creating write wrote written writing send sent sending
  update updated updating fix fixed fixing lead leading own owns owned take takes took handle handled start started starting
  next last this week weeks month months day days today tomorrow yesterday soon later morning afternoon evening
  monday tuesday wednesday thursday friday saturday sunday
  january february march april june july august september october november december
  hasn isn wasn weren aren won don didn doesn couldn shouldn wouldn haven hadn ll ve re`.split(
    /\s+/,
  ),
);

const CONTINUATION_CUE =
  /\b(still|again|yet|unfinished|incomplete|not (?:done|finished|ready|delivered|complete|completed)|hasn['’]t|haven['’]t|isn['’]t|wasn['’]t|delayed|behind|carried over|as discussed|more time|extension)\b/i;

function stem(token: string) {
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss")
    ? token.slice(0, -1)
    : token;
}

export function distinctiveTerms(text: string, exclude: string[] = []) {
  const excluded = new Set(exclude.flatMap((value) => rawTokens(value)));
  const terms = new Set<string>();
  for (const token of rawTokens(text)) {
    if (token.length < 2 || /^\d+$/.test(token)) continue;
    if (STOP_WORDS.has(token) || excluded.has(token)) continue;
    terms.add(stem(token));
  }
  return terms;
}

function rawTokens(text: string) {
  return (
    text
      .normalize("NFKC")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

export interface Statement {
  text: string;
  start: number;
  end: number;
}

/** Sentences and lines of a transcript, each an exact slice of the original. */
export function splitStatements(transcript: string): Statement[] {
  const statements: Statement[] = [];
  // A statement ends at closing punctuation followed by a space, or at a line end.
  const pattern = /\S[^\n]*?(?:[.!?]+(?=\s|$)|(?=\n|$))/g;
  for (const match of transcript.matchAll(pattern)) {
    const text = match[0].trimEnd();
    const start = match.index ?? 0;
    statements.push({ text, start, end: start + text.length });
  }
  return statements;
}

export interface KnownCommitment {
  id: string;
  description: string;
  originMeetingId: string | null;
  originMeetingTitle: string | null;
  originMeetingDate: string | null;
  ownerNames: string[];
}

export interface AnalysedCommitment {
  id: string;
  description: string;
  ranges: { start: number; end: number }[];
}

export interface CandidateMatch {
  commitmentId: string;
  reasons: string[];
}

export interface StatementMatches {
  quote: string;
  start: number | null;
  end: number | null;
  occurrences: number;
  savedFromThisMeeting: { id: string; description: string } | null;
  candidates: CandidateMatch[];
}

const countOccurrences = (transcript: string, quote: string) => {
  let count = 0;
  let index = transcript.indexOf(quote);
  while (index !== -1) {
    count += 1;
    index = transcript.indexOf(quote, index + 1);
  }
  return count;
};

const quoted = (terms: string[]) => terms.map((t) => `"${t}"`).join(", ");

function matchStatement(
  statement: Statement,
  extraTerms: Set<string>,
  commitment: KnownCommitment,
): (CandidateMatch & { strength: number; shared: number }) | null {
  const described = distinctiveTerms(
    commitment.description,
    commitment.ownerNames,
  );
  if (described.size === 0) return null;
  const said = new Set([...distinctiveTerms(statement.text), ...extraTerms]);
  const shared = [...described].filter((term) => said.has(term)).sort();
  const coverage = shared.length / described.size;
  const owner = commitment.ownerNames.find((name) =>
    containsName(statement.text, name),
  );

  const enough =
    (shared.length >= 2 && coverage >= 0.5) ||
    coverage === 1 ||
    (shared.length >= 1 && owner !== undefined && coverage >= 0.5);
  if (!enough) return null;

  const reasons = [`Shares the words ${quoted(shared)} with this commitment.`];
  let strength = 1;
  if (owner) {
    reasons.push(`Names its owner, ${owner}.`);
    strength += 1;
  }
  const cue = statement.text.match(CONTINUATION_CUE)?.[0];
  if (cue) {
    reasons.push(`Wording suggests earlier work continues: "${cue}".`);
    strength += 1;
  }
  const title = commitment.originMeetingTitle;
  if (title && title.length >= 4 && containsName(statement.text, title)) {
    reasons.push(`Mentions the meeting "${title}".`);
    strength += 1;
  }
  return {
    commitmentId: commitment.id,
    reasons,
    strength,
    shared: shared.length,
  };
}

/**
 * `known` must already exclude commitments that are not eligible for this
 * meeting. `isSettled` says whether a person already linked or dismissed a pair.
 * A repeated statement gets no offsets, so linking it stays ambiguous.
 */
export function findCandidates(
  transcript: string,
  known: KnownCommitment[],
  analysed: AnalysedCommitment[],
  isSettled: (commitmentId: string, quote: string) => boolean,
  maxPerStatement = 5,
): StatementMatches[] {
  const dates = new Map(known.map((c) => [c.id, c.originMeetingDate ?? ""]));
  const results: StatementMatches[] = [];
  const seen = new Set<string>();

  for (const statement of splitStatements(transcript)) {
    // The same words said twice are one suggestion, not two.
    if (seen.has(statement.text)) continue;
    seen.add(statement.text);

    const saved = analysed.find((commitment) =>
      commitment.ranges.some(
        (r) => r.start < statement.end && statement.start < r.end,
      ),
    );
    const extra = saved
      ? distinctiveTerms(saved.description)
      : new Set<string>();

    const matches = known
      .filter((commitment) => !isSettled(commitment.id, statement.text))
      .flatMap((commitment) => {
        const match = matchStatement(statement, extra, commitment);
        return match ? [match] : [];
      })
      .sort(
        (a, b) =>
          b.strength - a.strength ||
          b.shared - a.shared ||
          (dates.get(b.commitmentId) ?? "").localeCompare(
            dates.get(a.commitmentId) ?? "",
          ) ||
          a.commitmentId.localeCompare(b.commitmentId),
      );
    if (matches.length === 0) continue;

    const occurrences = countOccurrences(transcript, statement.text);
    const unique = occurrences === 1;
    results.push({
      quote: statement.text,
      start: unique ? statement.start : null,
      end: unique ? statement.end : null,
      occurrences,
      savedFromThisMeeting: saved
        ? { id: saved.id, description: saved.description }
        : null,
      candidates: matches
        .slice(0, maxPerStatement)
        .map(({ commitmentId, reasons }) => ({ commitmentId, reasons })),
    });
  }
  return results;
}
