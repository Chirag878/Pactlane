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
  CHANGE_ACTOR_TYPES,
  CHANGE_ENTITY_TYPES,
  CHANGE_OPERATIONS,
  COMMITMENT_PRIORITIES,
  COMMITMENT_STATUSES,
  EVIDENCE_VERIFICATION_STATUSES,
  FOLLOWUP_STATUSES,
  MEETING_PROCESSING_STATUSES,
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

export const projects = pgTable("projects", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  ...ownableColumns(),
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
