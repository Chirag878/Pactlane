import {
  defineAction,
  fail,
  type WriteReceipt,
} from "@agent-native/core/action";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeMeeting,
  requireActor,
} from "../server/lib/action-context.js";
import {
  reviewCommitment,
  reviewDecision,
  reviewNextMeetingSuggestion,
  type ReviewedQuote,
} from "../server/lib/analysis-review.js";
import { verifyQuote } from "../server/lib/evidence.js";
import {
  loadMeetingResult,
  meetingResultSchema,
} from "../server/lib/meeting-results.js";
import {
  ANALYSIS_BASES,
  COMMITMENT_PRIORITIES,
  MAX_EVIDENCE_QUOTE_LENGTH,
} from "../shared/domain.js";

const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => value.trim().length > 0, "Must not be blank.");

const evidenceSchema = z
  .strictObject({
    quote: z
      .string()
      .max(MAX_EVIDENCE_QUOTE_LENGTH)
      .refine((value) => value.trim().length > 0, "Must not be blank.")
      .describe(
        "Exact words copied from the transcript, character for character",
      ),
    start: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Start offset. Send only when the quote occurs more than once"),
    end: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("End offset, exclusive. Required when start is sent"),
  })
  .refine(
    ({ start, end }) =>
      (start === undefined) === (end === undefined) &&
      (start === undefined || start < end!),
    "Send both start and end, with start before end, or neither.",
  );

const reviewNote = z
  .string()
  .max(1_000)
  .nullable()
  .describe("Any doubt a reviewer should know about, or null");

const decisionSchema = z.strictObject({
  description: text(2_000).describe("What the meeting decided"),
  evidence: z.array(evidenceSchema).max(10),
  reviewNote,
});

const findingSchema = z.strictObject({
  description: text(2_000).describe("The unresolved question or blocker"),
  evidence: z.array(evidenceSchema).max(10),
  reviewNote,
});

const basis = z.enum(ANALYSIS_BASES).nullable();

const commitmentSchema = z
  .strictObject({
    description: text(2_000).describe("What was promised"),
    ownerName: z
      .string()
      .max(200)
      .nullable()
      .describe("Owner's name as said in the transcript, or null when unknown"),
    ownerBasis: basis.describe(
      'How the owner is known: "explicit" (said outright) or "inferred"; null when ownerName is null',
    ),
    dueDate: z.iso
      .date()
      .nullable()
      .describe(
        "Calendar date YYYY-MM-DD, or null when none can be determined",
      ),
    dueDateText: z
      .string()
      .max(200)
      .nullable()
      .describe(
        'The exact deadline words in the quote, such as "by Friday", or null',
      ),
    dueDateBasis: basis.describe(
      'How dueDate is known: "explicit" (a calendar date was said) or "inferred" (worked out from relative words); null when dueDate is null',
    ),
    priority: z
      .enum(COMMITMENT_PRIORITIES)
      .nullable()
      .describe('"low", "medium" or "high" only when stated; otherwise null'),
    evidence: z.array(evidenceSchema).max(10),
    reviewNote,
  })
  .refine(
    (c) => (c.ownerName === null) === (c.ownerBasis === null),
    "ownerBasis is required with ownerName, and must be null without it.",
  )
  .refine(
    (c) => (c.dueDate === null) === (c.dueDateBasis === null),
    "dueDateBasis is required with dueDate, and must be null without it.",
  )
  .refine(
    (c) => c.dueDate === null || c.dueDateText !== null,
    "dueDateText is required with dueDate.",
  );

const nextMeetingSchema = z
  .strictObject({
    proposedDate: z.iso.date().nullable(),
    dateText: z.string().max(200).nullable(),
    dateBasis: basis,
    proposedTime: z
      .string()
      .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/)
      .nullable()
      .describe("24-hour HH:MM time, or null when unresolved"),
    timeText: z.string().max(200).nullable(),
    participants: z.array(text(200)).max(50),
    purpose: z.string().max(2_000).nullable(),
    unknowns: z.array(text(500)).max(20),
    evidence: z.array(evidenceSchema).max(10),
    reviewNote,
  })
  .refine(
    (suggestion) =>
      (suggestion.proposedDate === null) === (suggestion.dateBasis === null),
    "dateBasis is required with proposedDate, and must be null without it.",
  )
  .refine(
    (suggestion) =>
      suggestion.proposedDate === null || suggestion.dateText !== null,
    "dateText is required with proposedDate.",
  )
  .refine(
    (suggestion) =>
      suggestion.proposedTime === null || suggestion.timeText !== null,
    "timeText is required with proposedTime.",
  );

const inputSchema = z.strictObject({
  meetingId: z.string().min(1).describe("Meeting being analyzed"),
  summary: text(5_000).describe("Short factual summary of the meeting"),
  decisions: z.array(decisionSchema).max(100),
  commitments: z.array(commitmentSchema).max(200),
  openQuestions: z.array(findingSchema).max(100).default([]),
  blockers: z.array(findingSchema).max(100).default([]),
  nextMeeting: nextMeetingSchema.nullable().default(null),
});

async function hashAnalysis(analysis: z.output<typeof inputSchema>) {
  // Preserve the v1-v4 hash for old callers and already-saved meetings. New
  // fields enter the hash only when the analysis actually contains them.
  const legacy = {
    meetingId: analysis.meetingId,
    summary: analysis.summary,
    decisions: analysis.decisions,
    commitments: analysis.commitments,
  };
  const canonical =
    analysis.openQuestions.length === 0 &&
    analysis.blockers.length === 0 &&
    analysis.nextMeeting === null
      ? legacy
      : {
          ...legacy,
          openQuestions: analysis.openQuestions,
          blockers: analysis.blockers,
          nextMeeting: analysis.nextMeeting,
        };
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function verifyAll(
  transcript: string,
  evidence: z.output<typeof evidenceSchema>[],
): ReviewedQuote[] {
  const seen = new Set<string>();
  const quotes: ReviewedQuote[] = [];
  for (const { quote, start, end } of evidence) {
    const key = JSON.stringify([quote, start, end]);
    if (seen.has(key)) continue;
    seen.add(key);
    quotes.push({
      quote,
      verification: verifyQuote(transcript, quote, { start, end }),
    });
  }
  return quotes;
}

const alreadySaved = (): never =>
  fail(
    "This meeting already has a saved analysis, and a different one cannot replace it. Call get-meeting to see what was saved.",
    { errorCode: "analysis_already_saved", statusCode: 409 },
  );

export default defineAction({
  description:
    "Save the analysis of a meeting: factual summary, commitments/action items, decisions, open questions, blockers, and an optional reviewable next-meeting suggestion with transcript quotations. Unknown owners, dates, and times stay unknown. The server checks every quotation against the stored transcript, sets verification status, and flags uncertainty for review. Repeating an identical save is safe. A meeting's first saved analysis cannot be replaced.",
  schema: inputSchema,
  outputSchema: meetingResultSchema.extend({
    replayed: z
      .boolean()
      .describe("True when this exact analysis had already been saved"),
    _receipt: z.custom<WriteReceipt>(),
  }),
  run: async (analysis, ctx) => {
    const actor = requireActor(ctx);
    const meeting = await authorizeMeeting(analysis.meetingId, "editor");
    const { projectId, id: meetingId, transcript } = meeting;
    if (transcript === null) {
      fail("This meeting has no transcript to verify against.", {
        errorCode: "no_transcript",
        statusCode: 409,
      });
    }

    const hash = await hashAnalysis(analysis);

    const replay = async (current: typeof meeting) => {
      if (current.analysisHash !== hash) alreadySaved();
      const result = await loadMeetingResult(current);
      const _receipt: WriteReceipt = {
        changed: false,
        verified: true,
        summary: "This analysis was already saved. Nothing changed.",
      };
      return { ...result, replayed: true, _receipt };
    };
    if (meeting.analysisHash !== null) return replay(meeting);

    const db = getDb();
    const people = await db
      .select({
        id: schema.people.id,
        displayName: schema.people.displayName,
        aliases: schema.people.aliases,
      })
      .from(schema.people)
      .where(eq(schema.people.projectId, projectId));

    const decisions = analysis.decisions.map((decision) => {
      const quotes = verifyAll(transcript, decision.evidence);
      return {
        id: crypto.randomUUID(),
        description: decision.description.trim(),
        quotes,
        ...reviewDecision(decision.reviewNote, quotes),
      };
    });
    const commitments = analysis.commitments.map((commitment) => {
      const quotes = verifyAll(transcript, commitment.evidence);
      return {
        id: crypto.randomUUID(),
        description: commitment.description.trim(),
        priority: commitment.priority,
        quotes,
        ...reviewCommitment(commitment, quotes, people),
      };
    });
    const findings = [
      ...analysis.openQuestions.map((finding) => ({
        ...finding,
        kind: "open_question" as const,
      })),
      ...analysis.blockers.map((finding) => ({
        ...finding,
        kind: "blocker" as const,
      })),
    ].map((finding) => {
      const quotes = verifyAll(transcript, finding.evidence);
      return {
        id: crypto.randomUUID(),
        kind: finding.kind,
        description: finding.description.trim(),
        quotes,
        ...reviewDecision(finding.reviewNote, quotes),
      };
    });
    const nextMeeting = analysis.nextMeeting
      ? (() => {
          const quotes = verifyAll(transcript, analysis.nextMeeting.evidence);
          return {
            id: crypto.randomUUID(),
            purpose: analysis.nextMeeting.purpose?.trim() || null,
            unknowns: analysis.nextMeeting.unknowns.map((unknown) =>
              unknown.trim(),
            ),
            quotes,
            ...reviewNextMeetingSuggestion(analysis.nextMeeting, quotes),
          };
        })()
      : null;

    const evidenceRow = ({ quote, verification }: ReviewedQuote) => ({
      id: crypto.randomUUID(),
      projectId,
      meetingId,
      sourceQuote: quote,
      sourceStart: verification.sourceStart,
      sourceEnd: verification.sourceEnd,
      verificationStatus: verification.status,
    });
    const decisionEvidence = decisions.flatMap((d) =>
      d.quotes.map((q) => ({ ...evidenceRow(q), decisionId: d.id })),
    );
    const commitmentEvidence = commitments.flatMap((c) =>
      c.quotes.map((q) => ({ ...evidenceRow(q), commitmentId: c.id })),
    );
    const findingEvidence = findings.flatMap((finding) =>
      finding.quotes.map((quote) => ({
        ...evidenceRow(quote),
        findingId: finding.id,
      })),
    );
    const nextMeetingEvidence = nextMeeting
      ? nextMeeting.quotes.map((quote) => ({
          ...evidenceRow(quote),
          suggestionId: nextMeeting.id,
        }))
      : [];

    const changeBase = {
      projectId,
      actorType: actor.actorType,
      actorId: actor.email,
    };
    const created = (
      entityType:
        | "commitment"
        | "decision"
        | "finding"
        | "next_meeting"
        | "evidence",
      entityId: string,
      afterState: Record<string, unknown>,
    ) => ({
      ...changeBase,
      entityType,
      entityId,
      operation: "create" as const,
      afterState,
    });

    const saved = await db.transaction(async (tx) => {
      // One compare-and-set per meeting: a concurrent save waits, then loses.
      const claimed = await tx
        .update(schema.meetings)
        .set({
          summary: analysis.summary.trim(),
          processingStatus: "processed",
          analysisHash: hash,
        })
        .where(
          and(
            eq(schema.meetings.id, meetingId),
            isNull(schema.meetings.analysisHash),
          ),
        )
        .returning({ id: schema.meetings.id });
      if (claimed.length === 0) return false;

      if (decisions.length > 0) {
        await tx.insert(schema.decisions).values(
          decisions.map(({ quotes: _quotes, ...decision }) => ({
            ...decision,
            projectId,
            meetingId,
          })),
        );
      }
      if (commitments.length > 0) {
        await tx.insert(schema.commitments).values(
          commitments.map(({ quotes: _quotes, ...commitment }) => ({
            ...commitment,
            projectId,
            originMeetingId: meetingId,
          })),
        );
      }
      if (findings.length > 0) {
        await tx.insert(schema.meetingFindings).values(
          findings.map(({ quotes: _quotes, ...finding }) => ({
            ...finding,
            projectId,
            meetingId,
          })),
        );
      }
      if (nextMeeting) {
        const { quotes: _quotes, ...suggestion } = nextMeeting;
        await tx.insert(schema.nextMeetingSuggestions).values({
          ...suggestion,
          projectId,
          meetingId,
        });
      }
      if (decisionEvidence.length > 0) {
        await tx.insert(schema.decisionEvidence).values(decisionEvidence);
      }
      if (commitmentEvidence.length > 0) {
        await tx.insert(schema.commitmentEvidence).values(commitmentEvidence);
      }
      if (findingEvidence.length > 0) {
        await tx.insert(schema.meetingFindingEvidence).values(findingEvidence);
      }
      if (nextMeetingEvidence.length > 0) {
        await tx.insert(schema.nextMeetingEvidence).values(nextMeetingEvidence);
      }

      await tx.insert(schema.changes).values([
        {
          ...changeBase,
          entityType: "meeting",
          entityId: meetingId,
          operation: "update",
          beforeState: {
            summary: meeting.summary,
            processingStatus: meeting.processingStatus,
          },
          afterState: {
            summary: analysis.summary.trim(),
            processingStatus: "processed",
          },
        },
        ...decisions.map((d) =>
          created("decision", d.id, {
            description: d.description,
            needsReview: d.needsReview,
            reviewReason: d.reviewReason,
          }),
        ),
        ...commitments.map((c) =>
          created("commitment", c.id, {
            description: c.description,
            ownerId: c.ownerId,
            statedOwnerName: c.statedOwnerName,
            dueDate: c.dueDate,
            statedDueText: c.statedDueText,
            priority: c.priority,
            needsReview: c.needsReview,
            reviewReason: c.reviewReason,
            reviewFlags: c.reviewFlags.map((f) => f.code),
          }),
        ),
        ...findings.map((finding) =>
          created("finding", finding.id, {
            kind: finding.kind,
            description: finding.description,
            needsReview: finding.needsReview,
            reviewReason: finding.reviewReason,
          }),
        ),
        ...(nextMeeting
          ? [
              created("next_meeting", nextMeeting.id, {
                proposedDate: nextMeeting.proposedDate,
                statedDateText: nextMeeting.statedDateText,
                dateBasis: nextMeeting.dateBasis,
                proposedTime: nextMeeting.proposedTime,
                statedTimeText: nextMeeting.statedTimeText,
                participants: nextMeeting.participants,
                purpose: nextMeeting.purpose,
                unknowns: nextMeeting.unknowns,
                needsReview: nextMeeting.needsReview,
                reviewReason: nextMeeting.reviewReason,
              }),
            ]
          : []),
        ...[
          ...decisionEvidence,
          ...commitmentEvidence,
          ...findingEvidence,
          ...nextMeetingEvidence,
        ].map((e) => {
          // Each evidence table has exactly one parent key.
          const parent =
            "decisionId" in e
              ? { decisionId: e.decisionId }
              : "commitmentId" in e
                ? { commitmentId: e.commitmentId }
                : "findingId" in e
                  ? { findingId: e.findingId }
                  : { suggestionId: e.suggestionId };
          return created("evidence", e.id, {
            ...parent,
            sourceQuote: e.sourceQuote,
            verificationStatus: e.verificationStatus,
          });
        }),
      ]);
      return true;
    });

    if (!saved) {
      return replay(await authorizeMeeting(meetingId, "editor"));
    }

    const result = await loadMeetingResult(
      await authorizeMeeting(meetingId, "viewer"),
    );
    const persisted =
      result.analysisSaved &&
      result.decisions.length === decisions.length &&
      result.commitments.length === commitments.length &&
      result.openQuestions.length === analysis.openQuestions.length &&
      result.blockers.length === analysis.blockers.length &&
      (result.nextMeeting === null) === (nextMeeting === null);
    const flagged = [
      ...result.decisions,
      ...result.commitments,
      ...result.openQuestions,
      ...result.blockers,
      ...(result.nextMeeting ? [result.nextMeeting] : []),
    ].filter((item) => item.needsReview).length;
    const _receipt: WriteReceipt = {
      changed: true,
      verified: persisted,
      summary: `Saved ${result.commitments.length} action items, ${result.decisions.length} decisions, ${result.openQuestions.length} open questions, and ${result.blockers.length} blockers; ${flagged} need review.`,
    };
    return { ...result, replayed: false, _receipt };
  },
});
