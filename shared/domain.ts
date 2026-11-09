/**
 * Allowed values for Pactlane's enum-like columns. Importable from both client
 * and server so Zod schemas, UI labels and Drizzle column types share one list.
 * `server/db/migrations.ts` holds the matching CHECK constraints, and
 * `server/db/schema.test.ts` fails if the two drift apart.
 */

export const PROJECT_VISIBILITIES = ["private", "org"] as const;

export const MEETING_PROCESSING_STATUSES = [
  "pending",
  "processing",
  "processed",
  "failed",
] as const;

/** Visibility of an AI analysis, separate from evidence verification and item review. */
export const ANALYSIS_PUBLICATION_STATES = ["draft", "published"] as const;
export type AnalysisPublicationState =
  (typeof ANALYSIS_PUBLICATION_STATES)[number];

export const MEETING_FINDING_KINDS = ["open_question", "blocker"] as const;
export type MeetingFindingKind = (typeof MEETING_FINDING_KINDS)[number];

export const COMMITMENT_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

/**
 * Moves a person may make by hand. Reopening a completed commitment is allowed
 * but deliberate; the server also refuses it to an agent. Cancelled work can
 * only be reinstated as open.
 */
export const COMMITMENT_TRANSITIONS: Record<
  CommitmentStatus,
  readonly CommitmentStatus[]
> = {
  open: ["in_progress", "blocked", "completed", "cancelled"],
  in_progress: ["open", "blocked", "completed", "cancelled"],
  blocked: ["open", "in_progress", "completed", "cancelled"],
  completed: ["open", "in_progress"],
  cancelled: ["open"],
};

export const COMMITMENT_PRIORITIES = ["low", "medium", "high"] as const;

/**
 * `unverified` is the only state a caller may write. The other three are
 * outcomes of the server's comparison against the stored transcript.
 */
export const EVIDENCE_VERIFICATION_STATUSES = [
  "unverified",
  "verified",
  "missing",
  "ambiguous",
] as const;

export const CHANGE_ENTITY_TYPES = [
  "project",
  "person",
  "meeting",
  "commitment",
  "decision",
  "finding",
  "next_meeting",
  "evidence",
  "followup",
] as const;

export const CHANGE_ACTOR_TYPES = ["user", "agent", "system"] as const;

export const CHANGE_OPERATIONS = ["create", "update", "delete"] as const;

export const FOLLOWUP_STATUSES = ["draft", "approved", "discarded"] as const;

/** Whether a value was said outright or worked out from what was said. */
export const ANALYSIS_BASES = ["explicit", "inferred"] as const;

export const MAX_EVIDENCE_QUOTE_LENGTH = 2_000;
export const MAX_TRANSCRIPT_LENGTH = 200_000;

/** Human judgement about a commitment, separate from evidence verification. */
export const REVIEW_STATES = ["proposed", "confirmed", "rejected"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** Why a commitment needs a person. `legacy` marks flags saved before codes. */
export const REVIEW_FLAG_CODES = [
  "evidence",
  "owner",
  "deadline",
  "note",
  "legacy",
] as const;
export type ReviewFlagCode = (typeof REVIEW_FLAG_CODES)[number];

export interface ReviewFlag {
  code: ReviewFlagCode;
  message: string;
}

export const MAX_COMMITMENT_DESCRIPTION_LENGTH = 1_000;
export const MAX_PERSON_NAME_LENGTH = 200;
