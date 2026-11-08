import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import {
  COMMITMENT_PRIORITIES,
  COMMITMENT_STATUSES,
  EVIDENCE_VERIFICATION_STATUSES,
  MEETING_PROCESSING_STATUSES,
} from "../../shared/domain.js";
import { getDb, schema } from "../db/index.js";

const evidenceResult = z.object({
  id: z.string(),
  sourceQuote: z.string(),
  sourceStart: z.number().nullable(),
  sourceEnd: z.number().nullable(),
  verificationStatus: z.enum(EVIDENCE_VERIFICATION_STATUSES),
});

const decisionResult = z.object({
  id: z.string(),
  description: z.string(),
  needsReview: z.boolean(),
  reviewReason: z.string().nullable(),
  evidence: z.array(evidenceResult),
});

const commitmentResult = z.object({
  id: z.string(),
  description: z.string(),
  ownerId: z.string().nullable(),
  ownerDisplayName: z.string().nullable(),
  statedOwnerName: z.string().nullable(),
  dueDate: z.string().nullable(),
  statedDueText: z.string().nullable(),
  priority: z.enum(COMMITMENT_PRIORITIES).nullable(),
  status: z.enum(COMMITMENT_STATUSES),
  needsReview: z.boolean(),
  reviewReason: z.string().nullable(),
  evidence: z.array(evidenceResult),
});

export const meetingResultSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  meetingDate: z.string(),
  transcript: z.string().nullable(),
  summary: z.string().nullable(),
  processingStatus: z.enum(MEETING_PROCESSING_STATUSES),
  analysisSaved: z.boolean(),
  decisions: z.array(decisionResult),
  commitments: z.array(commitmentResult),
});

export type MeetingResult = z.infer<typeof meetingResultSchema>;
type Meeting = typeof schema.meetings.$inferSelect;
type EvidenceResult = z.infer<typeof evidenceResult>;

/** Transcript order, because every row of one save shares a timestamp. */
const firstPosition = (evidence: EvidenceResult[]) =>
  Math.min(
    ...evidence.map((e) => e.sourceStart ?? Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  );

const inTranscriptOrder = <T extends { evidence: EvidenceResult[] }>(
  rows: T[],
) => rows.sort((a, b) => firstPosition(a.evidence) - firstPosition(b.evidence));

function groupEvidence<K extends string>(
  rows: ({ id: string } & Record<K, string> & Omit<EvidenceResult, "id">)[],
  key: K,
) {
  const grouped = new Map<string, EvidenceResult[]>();
  for (const row of rows) {
    const list = grouped.get(row[key]) ?? [];
    list.push({
      id: row.id,
      sourceQuote: row.sourceQuote,
      sourceStart: row.sourceStart,
      sourceEnd: row.sourceEnd,
      verificationStatus: row.verificationStatus,
    });
    grouped.set(row[key], list);
  }
  return grouped;
}

/** Call only after authorizing the caller against the meeting's project. */
export async function loadMeetingResult(
  meeting: Meeting,
): Promise<MeetingResult> {
  const db = getDb();
  const { projectId, id: meetingId } = meeting;

  const [commitments, decisions, commitmentEvidence, decisionEvidence] =
    await Promise.all([
      db
        .select()
        .from(schema.commitments)
        .where(
          and(
            eq(schema.commitments.projectId, projectId),
            eq(schema.commitments.originMeetingId, meetingId),
          ),
        ),
      db
        .select()
        .from(schema.decisions)
        .where(
          and(
            eq(schema.decisions.projectId, projectId),
            eq(schema.decisions.meetingId, meetingId),
          ),
        ),
      db
        .select()
        .from(schema.commitmentEvidence)
        .where(
          and(
            eq(schema.commitmentEvidence.projectId, projectId),
            eq(schema.commitmentEvidence.meetingId, meetingId),
          ),
        )
        .orderBy(asc(schema.commitmentEvidence.sourceStart)),
      db
        .select()
        .from(schema.decisionEvidence)
        .where(
          and(
            eq(schema.decisionEvidence.projectId, projectId),
            eq(schema.decisionEvidence.meetingId, meetingId),
          ),
        )
        .orderBy(asc(schema.decisionEvidence.sourceStart)),
    ]);

  const ownerIds = [
    ...new Set(commitments.flatMap((c) => (c.ownerId ? [c.ownerId] : []))),
  ];
  const owners = ownerIds.length
    ? await db
        .select({
          id: schema.people.id,
          displayName: schema.people.displayName,
        })
        .from(schema.people)
        .where(
          and(
            eq(schema.people.projectId, projectId),
            inArray(schema.people.id, ownerIds),
          ),
        )
    : [];
  const ownerNames = new Map(owners.map((o) => [o.id, o.displayName]));
  const evidenceByCommitment = groupEvidence(
    commitmentEvidence,
    "commitmentId",
  );
  const evidenceByDecision = groupEvidence(decisionEvidence, "decisionId");

  return {
    id: meetingId,
    projectId,
    title: meeting.title,
    meetingDate: meeting.meetingDate,
    transcript: meeting.transcript,
    summary: meeting.summary,
    processingStatus: meeting.processingStatus,
    analysisSaved: meeting.analysisHash !== null,
    decisions: inTranscriptOrder(
      decisions.map((d) => ({
        id: d.id,
        description: d.description,
        needsReview: d.needsReview,
        reviewReason: d.reviewReason,
        evidence: evidenceByDecision.get(d.id) ?? [],
      })),
    ),
    commitments: inTranscriptOrder(
      commitments.map((c) => ({
        id: c.id,
        description: c.description,
        ownerId: c.ownerId,
        ownerDisplayName: c.ownerId
          ? (ownerNames.get(c.ownerId) ?? null)
          : null,
        statedOwnerName: c.statedOwnerName,
        dueDate: c.dueDate,
        statedDueText: c.statedDueText,
        priority: c.priority,
        status: c.status,
        needsReview: c.needsReview,
        reviewReason: c.reviewReason,
        evidence: evidenceByCommitment.get(c.id) ?? [],
      })),
    ),
  };
}
