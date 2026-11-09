import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import {
  ANALYSIS_BASES,
  ANALYSIS_PUBLICATION_STATES,
  COMMITMENT_PRIORITIES,
  COMMITMENT_STATUSES,
  EVIDENCE_VERIFICATION_STATUSES,
  MEETING_FINDING_KINDS,
  MEETING_PROCESSING_STATUSES,
  REVIEW_FLAG_CODES,
  REVIEW_STATES,
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

const findingResult = z.object({
  id: z.string(),
  kind: z.enum(MEETING_FINDING_KINDS),
  description: z.string(),
  needsReview: z.boolean(),
  reviewReason: z.string().nullable(),
  evidence: z.array(evidenceResult),
});

const nextMeetingResult = z.object({
  id: z.string(),
  proposedDate: z.string().nullable(),
  statedDateText: z.string().nullable(),
  dateBasis: z.enum(ANALYSIS_BASES).nullable(),
  proposedTime: z.string().nullable(),
  statedTimeText: z.string().nullable(),
  participants: z.array(z.string()),
  purpose: z.string().nullable(),
  unknowns: z.array(z.string()),
  needsReview: z.boolean(),
  reviewReason: z.string().nullable(),
  evidence: z.array(evidenceResult),
});

const reviewFlagResult = z.object({
  code: z.enum(REVIEW_FLAG_CODES),
  message: z.string(),
});

export const commitmentResult = z.object({
  id: z.string(),
  projectId: z.string(),
  originMeetingId: z.string().nullable(),
  version: z
    .number()
    .describe("Pass as expectedVersion when updating or reviewing"),
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
  reviewFlags: z.array(reviewFlagResult),
  reviewState: z.enum(REVIEW_STATES),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  evidence: z.array(evidenceResult),
});

export type CommitmentResult = z.infer<typeof commitmentResult>;

export const meetingResultSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  meetingDate: z.string(),
  transcript: z.string().nullable(),
  summary: z.string().nullable(),
  processingStatus: z.enum(MEETING_PROCESSING_STATUSES),
  analysisSaved: z.boolean(),
  analysisVisible: z
    .boolean()
    .describe(
      "False when a viewer can see the meeting but its AI analysis remains a private draft",
    ),
  analysisPublicationState: z.enum(ANALYSIS_PUBLICATION_STATES),
  analysisContentRevision: z.number().int().min(0),
  analysisPublishedBy: z.string().nullable(),
  analysisPublishedAt: z.string().nullable(),
  analysisPublishedRevision: z.number().int().min(0).nullable(),
  canPublish: z.boolean(),
  decisions: z.array(decisionResult),
  commitments: z.array(commitmentResult),
  openQuestions: z.array(findingResult),
  blockers: z.array(findingResult),
  nextMeeting: nextMeetingResult.nullable(),
  linkedCommitments: z
    .array(commitmentResult)
    .describe(
      "Earlier commitments a person linked to this meeting. Evidence shown is from this meeting only",
    ),
});

export type MeetingResult = z.infer<typeof meetingResultSchema>;
type Meeting = typeof schema.meetings.$inferSelect;
type Commitment = typeof schema.commitments.$inferSelect;
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

export function toCommitmentResult(
  c: Commitment,
  ownerDisplayName: string | null,
  evidence: EvidenceResult[],
): CommitmentResult {
  return {
    id: c.id,
    projectId: c.projectId,
    originMeetingId: c.originMeetingId,
    version: c.version,
    description: c.description,
    ownerId: c.ownerId,
    ownerDisplayName,
    statedOwnerName: c.statedOwnerName,
    dueDate: c.dueDate,
    statedDueText: c.statedDueText,
    priority: c.priority,
    status: c.status,
    needsReview: c.needsReview,
    reviewReason: c.reviewReason,
    reviewFlags: c.reviewFlags,
    reviewState: c.reviewState,
    reviewedBy: c.reviewedBy,
    reviewedAt: c.reviewedAt ? c.reviewedAt.toISOString() : null,
    evidence,
  };
}

/** Reads one commitment with its owner name and evidence, in the shape get-meeting returns. */
export async function loadCommitmentResult(
  commitment: Commitment,
): Promise<CommitmentResult> {
  const db = getDb();
  const { projectId } = commitment;
  const [evidence, owner] = await Promise.all([
    db
      .select()
      .from(schema.commitmentEvidence)
      .where(
        and(
          eq(schema.commitmentEvidence.projectId, projectId),
          eq(schema.commitmentEvidence.commitmentId, commitment.id),
        ),
      )
      .orderBy(asc(schema.commitmentEvidence.sourceStart)),
    commitment.ownerId
      ? db
          .select({ displayName: schema.people.displayName })
          .from(schema.people)
          .where(
            and(
              eq(schema.people.projectId, projectId),
              eq(schema.people.id, commitment.ownerId),
            ),
          )
          .limit(1)
      : Promise.resolve([]),
  ]);
  return toCommitmentResult(
    commitment,
    owner[0]?.displayName ?? null,
    groupEvidence(evidence, "commitmentId").get(commitment.id) ?? [],
  );
}

/** Call only after authorizing the caller against the meeting's project. */
export async function loadMeetingResult(
  meeting: Meeting,
  options: { includeDraft?: boolean; canPublish?: boolean } = {},
  db: ReturnType<typeof getDb> = getDb(),
): Promise<MeetingResult> {
  const { projectId, id: meetingId } = meeting;
  const analysisVisible =
    meeting.analysisPublicationState === "published" ||
    options.includeDraft === true;

  // The meeting and its original transcript remain visible to an authorized
  // viewer. AI-generated rows stay private until an editor publishes them.
  if (!analysisVisible) {
    return {
      id: meetingId,
      projectId,
      title: meeting.title,
      meetingDate: meeting.meetingDate,
      transcript: meeting.transcript,
      summary: null,
      processingStatus: meeting.processingStatus,
      analysisSaved: meeting.analysisHash !== null,
      analysisVisible: false,
      analysisPublicationState: meeting.analysisPublicationState,
      // The internal revision count is review metadata. A viewer only needs to
      // know that the analysis is not yet visible, not how often it changed.
      analysisContentRevision: 0,
      analysisPublishedBy: null,
      analysisPublishedAt: null,
      analysisPublishedRevision: null,
      canPublish: false,
      decisions: [],
      commitments: [],
      openQuestions: [],
      blockers: [],
      nextMeeting: null,
      linkedCommitments: [],
    };
  }

  const [
    commitments,
    decisions,
    findings,
    nextMeetingRows,
    commitmentEvidence,
    decisionEvidence,
    findingEvidence,
    nextMeetingEvidence,
  ] = await Promise.all([
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
      .from(schema.meetingFindings)
      .where(
        and(
          eq(schema.meetingFindings.projectId, projectId),
          eq(schema.meetingFindings.meetingId, meetingId),
        ),
      ),
    db
      .select()
      .from(schema.nextMeetingSuggestions)
      .where(
        and(
          eq(schema.nextMeetingSuggestions.projectId, projectId),
          eq(schema.nextMeetingSuggestions.meetingId, meetingId),
        ),
      )
      .limit(1),
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
    db
      .select()
      .from(schema.meetingFindingEvidence)
      .where(
        and(
          eq(schema.meetingFindingEvidence.projectId, projectId),
          eq(schema.meetingFindingEvidence.meetingId, meetingId),
        ),
      )
      .orderBy(asc(schema.meetingFindingEvidence.sourceStart)),
    db
      .select()
      .from(schema.nextMeetingEvidence)
      .where(
        and(
          eq(schema.nextMeetingEvidence.projectId, projectId),
          eq(schema.nextMeetingEvidence.meetingId, meetingId),
        ),
      )
      .orderBy(asc(schema.nextMeetingEvidence.sourceStart)),
  ]);

  const originIds = new Set(commitments.map((c) => c.id));
  const linkedIds = [
    ...new Set(
      commitmentEvidence
        .map((e) => e.commitmentId)
        .filter((id) => !originIds.has(id)),
    ),
  ];
  const linkedCommitments = linkedIds.length
    ? await db
        .select()
        .from(schema.commitments)
        .where(
          and(
            eq(schema.commitments.projectId, projectId),
            inArray(schema.commitments.id, linkedIds),
          ),
        )
    : [];
  const linkedOriginIds = [
    ...new Set(
      linkedCommitments.flatMap((commitment) =>
        commitment.originMeetingId ? [commitment.originMeetingId] : [],
      ),
    ),
  ];
  const linkedOrigins = linkedOriginIds.length
    ? await db
        .select({
          id: schema.meetings.id,
          publicationState: schema.meetings.analysisPublicationState,
        })
        .from(schema.meetings)
        .where(
          and(
            eq(schema.meetings.projectId, projectId),
            inArray(schema.meetings.id, linkedOriginIds),
          ),
        )
    : [];
  const linkedOriginStates = new Map(
    linkedOrigins.map((origin) => [origin.id, origin.publicationState]),
  );
  const visibleLinkedCommitments = options.includeDraft
    ? linkedCommitments
    : linkedCommitments.filter(
        (commitment) =>
          !commitment.originMeetingId ||
          linkedOriginStates.get(commitment.originMeetingId) !== "draft",
      );

  const ownerIds = [
    ...new Set(
      [...commitments, ...visibleLinkedCommitments].flatMap((c) =>
        c.ownerId ? [c.ownerId] : [],
      ),
    ),
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
  const evidenceByFinding = groupEvidence(findingEvidence, "findingId");
  const evidenceByNextMeeting = groupEvidence(
    nextMeetingEvidence,
    "suggestionId",
  );
  const asResult = (c: Commitment) =>
    toCommitmentResult(
      c,
      c.ownerId ? (ownerNames.get(c.ownerId) ?? null) : null,
      evidenceByCommitment.get(c.id) ?? [],
    );

  return {
    id: meetingId,
    projectId,
    title: meeting.title,
    meetingDate: meeting.meetingDate,
    transcript: meeting.transcript,
    summary: meeting.summary,
    processingStatus: meeting.processingStatus,
    analysisSaved: meeting.analysisHash !== null,
    analysisVisible: true,
    analysisPublicationState: meeting.analysisPublicationState,
    analysisContentRevision: meeting.analysisContentRevision,
    analysisPublishedBy: meeting.analysisPublishedBy,
    analysisPublishedAt: meeting.analysisPublishedAt
      ? meeting.analysisPublishedAt.toISOString()
      : null,
    analysisPublishedRevision: meeting.analysisPublishedRevision,
    canPublish: options.canPublish === true,
    decisions: inTranscriptOrder(
      decisions.map((d) => ({
        id: d.id,
        description: d.description,
        needsReview: d.needsReview,
        reviewReason: d.reviewReason,
        evidence: evidenceByDecision.get(d.id) ?? [],
      })),
    ),
    commitments: inTranscriptOrder(commitments.map(asResult)),
    openQuestions: inTranscriptOrder(
      findings
        .filter((finding) => finding.kind === "open_question")
        .map((finding) => ({
          id: finding.id,
          kind: finding.kind,
          description: finding.description,
          needsReview: finding.needsReview,
          reviewReason: finding.reviewReason,
          evidence: evidenceByFinding.get(finding.id) ?? [],
        })),
    ),
    blockers: inTranscriptOrder(
      findings
        .filter((finding) => finding.kind === "blocker")
        .map((finding) => ({
          id: finding.id,
          kind: finding.kind,
          description: finding.description,
          needsReview: finding.needsReview,
          reviewReason: finding.reviewReason,
          evidence: evidenceByFinding.get(finding.id) ?? [],
        })),
    ),
    nextMeeting: nextMeetingRows[0]
      ? {
          id: nextMeetingRows[0].id,
          proposedDate: nextMeetingRows[0].proposedDate,
          statedDateText: nextMeetingRows[0].statedDateText,
          dateBasis: nextMeetingRows[0].dateBasis,
          proposedTime: nextMeetingRows[0].proposedTime,
          statedTimeText: nextMeetingRows[0].statedTimeText,
          participants: nextMeetingRows[0].participants,
          purpose: nextMeetingRows[0].purpose,
          unknowns: nextMeetingRows[0].unknowns,
          needsReview: nextMeetingRows[0].needsReview,
          reviewReason: nextMeetingRows[0].reviewReason,
          evidence: evidenceByNextMeeting.get(nextMeetingRows[0].id) ?? [],
        }
      : null,
    linkedCommitments: inTranscriptOrder(
      visibleLinkedCommitments.map(asResult),
    ),
  };
}
