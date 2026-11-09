export interface EvidenceRange {
  sourceQuote: string;
  sourceStart: number | null;
  sourceEnd: number | null;
  verificationStatus: string;
}

export interface Segment {
  text: string;
  highlighted: boolean;
}

const isLocatable = (transcript: string, e: EvidenceRange) =>
  e.verificationStatus === "verified" &&
  e.sourceStart !== null &&
  e.sourceEnd !== null &&
  transcript.slice(e.sourceStart, e.sourceEnd) === e.sourceQuote;

/**
 * Splits the transcript around the quotations that can be located. A range is
 * used only if the server verified it and the transcript still holds exactly
 * that text there, so a highlight never points at the wrong words.
 */
export function buildSegments(
  transcript: string,
  evidence: EvidenceRange[],
): Segment[] {
  const ranges = evidence
    .filter((e) => isLocatable(transcript, e))
    .map((e) => ({ start: e.sourceStart!, end: e.sourceEnd! }))
    .sort((a, b) => a.start - b.start);

  const segments: Segment[] = [];
  let cursor = 0;
  for (const { start, end } of ranges) {
    if (start < cursor) continue; // overlapping ranges: keep the first
    if (start > cursor) {
      segments.push({
        text: transcript.slice(cursor, start),
        highlighted: false,
      });
    }
    segments.push({ text: transcript.slice(start, end), highlighted: true });
    cursor = end;
  }
  if (cursor < transcript.length) {
    segments.push({ text: transcript.slice(cursor), highlighted: false });
  }
  return segments;
}

/** Quotations that cannot be shown in place, because the server could not locate them. */
export function unlocatedQuotes(transcript: string, evidence: EvidenceRange[]) {
  return evidence.filter((e) => !isLocatable(transcript, e));
}
