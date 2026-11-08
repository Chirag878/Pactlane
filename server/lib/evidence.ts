export interface EvidenceLocation {
  start?: number | undefined;
  end?: number | undefined;
}

export type QuoteVerification =
  | { status: "verified"; sourceStart: number; sourceEnd: number }
  | { status: "missing" | "ambiguous"; sourceStart: null; sourceEnd: null };

const unresolved = (status: "missing" | "ambiguous"): QuoteVerification => ({
  status,
  sourceStart: null,
  sourceEnd: null,
});

function occurrences(transcript: string, quote: string): number[] {
  const found: number[] = [];
  let index = transcript.indexOf(quote);
  while (index !== -1) {
    found.push(index);
    index = transcript.indexOf(quote, index + 1);
  }
  return found;
}

/**
 * Compares a proposed quote with the stored transcript, by exact JavaScript
 * string index. Quotes are never normalized, so a paraphrase cannot pass. See
 * the Source verification table in docs/ARCHITECTURE.md.
 */
export function verifyQuote(
  transcript: string,
  quote: string,
  location: EvidenceLocation = {},
): QuoteVerification {
  const { start, end } = location;
  if (
    start !== undefined &&
    end !== undefined &&
    transcript.slice(start, end) === quote
  ) {
    return { status: "verified", sourceStart: start, sourceEnd: end };
  }

  const found = occurrences(transcript, quote);
  if (found.length === 0) return unresolved("missing");
  if (found.length > 1) return unresolved("ambiguous");
  // One occurrence, but the caller pointed somewhere else: the claim is wrong.
  if (start !== undefined) return unresolved("missing");
  return {
    status: "verified",
    sourceStart: found[0]!,
    sourceEnd: found[0]! + quote.length,
  };
}

/** Whole-word and case-insensitive, so "Ana" does not match "Banana". */
export function containsName(text: string, name: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`,
    "iu",
  ).test(text);
}
