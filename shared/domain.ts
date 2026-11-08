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

export const COMMITMENT_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "completed",
  "cancelled",
] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

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
  "evidence",
  "followup",
] as const;

export const CHANGE_ACTOR_TYPES = ["user", "agent", "system"] as const;

export const CHANGE_OPERATIONS = ["create", "update", "delete"] as const;

export const FOLLOWUP_STATUSES = ["draft", "approved", "discarded"] as const;
