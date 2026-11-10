import {
  createSharesTable,
  ownableColumns,
} from "@agent-native/core/db/schema";
import {
  boolean,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import {
  ANALYSIS_BASES,
  CHANGE_ACTOR_TYPES,
  CHANGE_ENTITY_TYPES,
  CHANGE_OPERATIONS,
  COMMITMENT_PRIORITIES,
  COMMITMENT_STATUSES,
  EVIDENCE_VERIFICATION_STATUSES,
  FOLLOWUP_STATUSES,
  MEETING_FINDING_KINDS,
  MEETING_PROCESSING_STATUSES,
  ANALYSIS_PUBLICATION_STATES,
  ASSIGNMENT_STATUSES,
  ORGANIZATION_INVITATION_STATUSES,
  ORGANIZATION_INVITE_ROLES,
  ORGANIZATION_MEMBERSHIP_STATUSES,
  ORGANIZATION_ROLES,
  REVIEW_STATES,
  type ReviewFlag,
} from "../../shared/domain.js";

/**
 * Typed query surface for Pactlane's domain tables.
 *
 * The Chat template has no Drizzle Kit step: `server/db/migrations.ts` owns the
 * DDL, including foreign keys, CHECK constraints and indexes. This file only
 * declares what queries need. `schema.test.ts` fails if the columns drift.
 */

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * A Pactlane organization (ADR-020). Not the framework's `organizations`
 * table: membership here never grants project access on its own.
 */
export const pactlaneOrganizations = pgTable("pactlane_organizations", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  createdBy: text("created_by").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** One row per person per organization; removal keeps the row as history. */
export const organizationMemberships = pgTable("organization_memberships", {
  id: id(),
  organizationId: text("organization_id").notNull(),
  email: text("email").notNull(),
  role: text("role", { enum: ORGANIZATION_ROLES }).notNull(),
  status: text("status", { enum: ORGANIZATION_MEMBERSHIP_STATUSES })
    .notNull()
    .default("active"),
  addedBy: text("added_by").notNull(),
  joinedAt: timestamp("joined_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  removedBy: text("removed_by"),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  updatedAt: updatedAt(),
});

/** Only the SHA-256 hash of an invitation token is ever stored. */
export const organizationInvitations = pgTable("organization_invitations", {
  id: id(),
  organizationId: text("organization_id").notNull(),
  email: text("email").notNull(),
  role: text("role", { enum: ORGANIZATION_INVITE_ROLES }).notNull(),
  tokenHash: text("token_hash").notNull(),
  status: text("status", { enum: ORGANIZATION_INVITATION_STATUSES })
    .notNull()
    .default("pending"),
  invitedBy: text("invited_by").notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedBy: text("accepted_by"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedBy: text("revoked_by"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const projects = pgTable("projects", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  ...ownableColumns(),
  /** Null for a personal project. Set only at creation. */
  organizationId: text("organization_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projectShares = createSharesTable("project_shares");

/** Someone named in a project. Most never have a Pactlane account. */
export const people = pgTable("people", {
  id: id(),
  projectId: text("project_id").notNull(),
  displayName: text("display_name").notNull(),
  aliases: jsonb("aliases").$type<string[]>().notNull().default([]),
  email: text("email"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const meetings = pgTable("meetings", {
  id: id(),
  projectId: text("project_id").notNull(),
  title: text("title").notNull(),
  meetingDate: date("meeting_date", { mode: "string" }).notNull(),
  /** Original text, never normalized: evidence offsets index into it. */
  transcript: text("transcript"),
  summary: text("summary"),
  processingStatus: text("processing_status", {
    enum: MEETING_PROCESSING_STATUSES,
  })
    .notNull()
    .default("pending"),
  /** Set once by save-analysis, so a retried save cannot create duplicates. */
  analysisHash: text("analysis_hash"),
  /** New AI results are private drafts until an editor publishes them. */
  analysisPublicationState: text("analysis_publication_state", {
    enum: ANALYSIS_PUBLICATION_STATES,
  })
    .notNull()
    .default("draft"),
  /** Bumped whenever reviewable analysis content changes. */
  analysisContentRevision: integer("analysis_content_revision")
    .notNull()
    .default(0),
  /** Attribution exists for publications made after publication tracking began. */
  analysisPublishedBy: text("analysis_published_by"),
  analysisPublishedAt: timestamp("analysis_published_at", {
    withTimezone: true,
  }),
  /** The exact content revision approved by the attributed reviewer. */
  analysisPublishedRevision: integer("analysis_published_revision"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** One promise with one stable id, however many meetings revisit it. */
export const commitments = pgTable("commitments", {
  id: id(),
  projectId: text("project_id").notNull(),
  originMeetingId: text("origin_meeting_id"),
  description: text("description").notNull(),
  ownerId: text("owner_id"),
  /** The owner's name as verified in the transcript, linked or not. */
  statedOwnerName: text("stated_owner_name"),
  dueDate: date("due_date", { mode: "string" }),
  /** The deadline's words as verified in the transcript, such as "by Friday". */
  statedDueText: text("stated_due_text"),
  priority: text("priority", { enum: COMMITMENT_PRIORITIES }),
  status: text("status", { enum: COMMITMENT_STATUSES })
    .notNull()
    .default("open"),
  needsReview: boolean("needs_review").notNull().default(false),
  /** The open flags' messages joined, kept for readers of older rows. */
  reviewReason: text("review_reason"),
  /** Unresolved reasons for review. Resolving one never clears another. */
  reviewFlags: jsonb("review_flags")
    .$type<ReviewFlag[]>()
    .notNull()
    .default([]),
  /** A person's verdict. It never changes any evidence verification status. */
  reviewState: text("review_state", { enum: REVIEW_STATES })
    .notNull()
    .default("proposed"),
  reviewedBy: text("reviewed_by"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  /** Bumped on every change, so a stale editor is told instead of overwriting. */
  version: integer("version").notNull().default(1),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** A deliberate delivery of an existing commitment to one authenticated user. */
export const commitmentAssignments = pgTable("commitment_assignments", {
  id: id(),
  projectId: text("project_id").notNull(),
  organizationId: text("organization_id").notNull(),
  commitmentId: text("commitment_id").notNull(),
  /** Stable Better Auth user id. Email is a historical display snapshot only. */
  recipientAccountId: text("recipient_account_id").notNull(),
  recipientEmail: text("recipient_email").notNull(),
  status: text("status", { enum: ASSIGNMENT_STATUSES })
    .notNull()
    .default("pending"),
  assignedBy: text("assigned_by").notNull(),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: updatedAt(),
  note: text("note"),
  version: integer("version").notNull().default(1),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

/** Also the commitment-to-meeting link: no separate join table is needed. */
export const commitmentEvidence = pgTable("commitment_evidence", {
  id: id(),
  projectId: text("project_id").notNull(),
  commitmentId: text("commitment_id").notNull(),
  meetingId: text("meeting_id").notNull(),
  sourceQuote: text("source_quote").notNull(),
  sourceStart: integer("source_start"),
  sourceEnd: integer("source_end"),
  verificationStatus: text("verification_status", {
    enum: EVIDENCE_VERIFICATION_STATUSES,
  })
    .notNull()
    .default("unverified"),
  /** Set only when a person confirmed this quote as a later mention. */
  linkedBy: text("linked_by"),
  linkedAt: timestamp("linked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** Suggestions a person ruled out, so they are not offered again. */
export const commitmentLinkDismissals = pgTable("commitment_link_dismissals", {
  id: id(),
  projectId: text("project_id").notNull(),
  commitmentId: text("commitment_id").notNull(),
  meetingId: text("meeting_id").notNull(),
  sourceQuote: text("source_quote").notNull(),
  dismissedBy: text("dismissed_by").notNull(),
  createdAt: createdAt(),
});

/** A choice a meeting made, backed by quotes the same way commitments are. */
export const decisions = pgTable("decisions", {
  id: id(),
  projectId: text("project_id").notNull(),
  meetingId: text("meeting_id").notNull(),
  description: text("description").notNull(),
  needsReview: boolean("needs_review").notNull().default(false),
  reviewReason: text("review_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const decisionEvidence = pgTable("decision_evidence", {
  id: id(),
  projectId: text("project_id").notNull(),
  decisionId: text("decision_id").notNull(),
  meetingId: text("meeting_id").notNull(),
  sourceQuote: text("source_quote").notNull(),
  sourceStart: integer("source_start"),
  sourceEnd: integer("source_end"),
  verificationStatus: text("verification_status", {
    enum: EVIDENCE_VERIFICATION_STATUSES,
  })
    .notNull()
    .default("unverified"),
  createdAt: createdAt(),
});

/** An unresolved question or blocker identified in one meeting. */
export const meetingFindings = pgTable("meeting_findings", {
  id: id(),
  projectId: text("project_id").notNull(),
  meetingId: text("meeting_id").notNull(),
  kind: text("kind", { enum: MEETING_FINDING_KINDS }).notNull(),
  description: text("description").notNull(),
  needsReview: boolean("needs_review").notNull().default(false),
  reviewReason: text("review_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const meetingFindingEvidence = pgTable("meeting_finding_evidence", {
  id: id(),
  projectId: text("project_id").notNull(),
  findingId: text("finding_id").notNull(),
  meetingId: text("meeting_id").notNull(),
  sourceQuote: text("source_quote").notNull(),
  sourceStart: integer("source_start"),
  sourceEnd: integer("source_end"),
  verificationStatus: text("verification_status", {
    enum: EVIDENCE_VERIFICATION_STATUSES,
  })
    .notNull()
    .default("unverified"),
  createdAt: createdAt(),
});

/** A reviewable suggestion only; it never creates an external event. */
export const nextMeetingSuggestions = pgTable("next_meeting_suggestions", {
  id: id(),
  projectId: text("project_id").notNull(),
  meetingId: text("meeting_id").notNull(),
  proposedDate: date("proposed_date", { mode: "string" }),
  statedDateText: text("stated_date_text"),
  dateBasis: text("date_basis", { enum: ANALYSIS_BASES }),
  proposedTime: text("proposed_time"),
  statedTimeText: text("stated_time_text"),
  participants: jsonb("participants").$type<string[]>().notNull().default([]),
  purpose: text("purpose"),
  unknowns: jsonb("unknowns").$type<string[]>().notNull().default([]),
  needsReview: boolean("needs_review").notNull().default(false),
  reviewReason: text("review_reason"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const nextMeetingEvidence = pgTable("next_meeting_evidence", {
  id: id(),
  projectId: text("project_id").notNull(),
  suggestionId: text("suggestion_id").notNull(),
  meetingId: text("meeting_id").notNull(),
  sourceQuote: text("source_quote").notNull(),
  sourceStart: integer("source_start"),
  sourceEnd: integer("source_end"),
  verificationStatus: text("verification_status", {
    enum: EVIDENCE_VERIFICATION_STATUSES,
  })
    .notNull()
    .default("unverified"),
  createdAt: createdAt(),
});

/** Append-only history. `actorType` and `actorId` come from trusted context. */
export const changes = pgTable("changes", {
  id: id(),
  projectId: text("project_id").notNull(),
  entityType: text("entity_type", { enum: CHANGE_ENTITY_TYPES }).notNull(),
  entityId: text("entity_id").notNull(),
  actorType: text("actor_type", { enum: CHANGE_ACTOR_TYPES }).notNull(),
  actorId: text("actor_id").notNull(),
  operation: text("operation", { enum: CHANGE_OPERATIONS }).notNull(),
  beforeState: jsonb("before_state").$type<Record<string, unknown>>(),
  afterState: jsonb("after_state").$type<Record<string, unknown>>(),
  /** Set on the change that undoes another one. */
  revertsChangeId: text("reverts_change_id"),
  createdAt: createdAt(),
});

export const followups = pgTable("followups", {
  id: id(),
  projectId: text("project_id").notNull(),
  meetingId: text("meeting_id").notNull(),
  recipientId: text("recipient_id"),
  content: text("content").notNull(),
  status: text("status", { enum: FOLLOWUP_STATUSES })
    .notNull()
    .default("draft"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedBy: text("approved_by"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
