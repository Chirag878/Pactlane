import type { runMigrations } from "@agent-native/core/db";

type Migrations = Extract<Parameters<typeof runMigrations>[0], unknown[]>;

/**
 * Pactlane's schema history. Append new entries with a unique `name`; never
 * edit, renumber or remove one that has been applied, and keep changes
 * additive so older running code still works.
 *
 * Two conventions run through the foundation:
 * - Composite foreign keys on (project_id, ...) make it impossible for a row to
 *   reference another project's meeting, person or commitment.
 * - History tables use ON DELETE RESTRICT, so removing a parent can never erase
 *   evidence or audit records as a side effect.
 */
export const migrations: Migrations = [
  {
    version: 1,
    name: "pactlane-foundation",
    sql: `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CONSTRAINT projects_name_present CHECK (length(btrim(name)) > 0),
  description TEXT,
  owner_email TEXT NOT NULL DEFAULT 'local@localhost',
  org_id TEXT,
  visibility TEXT NOT NULL DEFAULT 'private'
    CONSTRAINT projects_visibility_check CHECK (visibility IN ('private', 'org')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_owner_email_idx ON projects (owner_email);
CREATE INDEX IF NOT EXISTS projects_org_id_idx ON projects (org_id);

CREATE TABLE IF NOT EXISTS project_shares (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT now(),
  notified_at TEXT,
  CONSTRAINT project_shares_principal_unique UNIQUE (resource_id, principal_type, principal_id)
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  display_name TEXT NOT NULL CONSTRAINT people_display_name_present CHECK (length(btrim(display_name)) > 0),
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT people_aliases_is_array CHECK (jsonb_typeof(aliases) = 'array'),
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT people_project_id_id_unique UNIQUE (project_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS people_project_name_unique
  ON people (project_id, lower(btrim(display_name)));

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  title TEXT NOT NULL CONSTRAINT meetings_title_present CHECK (length(btrim(title)) > 0),
  meeting_date DATE NOT NULL,
  transcript TEXT,
  summary TEXT,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT meetings_processing_status_check
    CHECK (processing_status IN ('pending', 'processing', 'processed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meetings_project_id_id_unique UNIQUE (project_id, id),
  CONSTRAINT meetings_processing_needs_transcript
    CHECK (processing_status = 'pending' OR transcript IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS meetings_project_date_idx
  ON meetings (project_id, meeting_date DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS commitments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  origin_meeting_id TEXT,
  description TEXT NOT NULL CONSTRAINT commitments_description_present CHECK (length(btrim(description)) > 0),
  owner_id TEXT,
  due_date DATE,
  priority TEXT CONSTRAINT commitments_priority_check CHECK (priority IN ('low', 'medium', 'high')),
  status TEXT NOT NULL DEFAULT 'open'
    CONSTRAINT commitments_status_check
    CHECK (status IN ('open', 'in_progress', 'blocked', 'completed', 'cancelled')),
  needs_review BOOLEAN NOT NULL DEFAULT false,
  review_reason TEXT,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commitments_project_id_id_unique UNIQUE (project_id, id),
  CONSTRAINT commitments_completed_at_matches_status
    CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CONSTRAINT commitments_origin_meeting_fk FOREIGN KEY (project_id, origin_meeting_id)
    REFERENCES meetings (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT commitments_owner_fk FOREIGN KEY (project_id, owner_id)
    REFERENCES people (project_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS commitments_project_status_due_idx
  ON commitments (project_id, status, due_date);
CREATE INDEX IF NOT EXISTS commitments_project_owner_idx
  ON commitments (project_id, owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commitments_project_origin_idx
  ON commitments (project_id, origin_meeting_id) WHERE origin_meeting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS commitments_needs_review_idx
  ON commitments (project_id) WHERE needs_review;

CREATE TABLE IF NOT EXISTS commitment_evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  commitment_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  source_quote TEXT NOT NULL CONSTRAINT commitment_evidence_quote_present CHECK (length(source_quote) > 0),
  source_start INTEGER,
  source_end INTEGER,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CONSTRAINT commitment_evidence_verification_status_check
    CHECK (verification_status IN ('unverified', 'verified', 'missing', 'ambiguous')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commitment_evidence_offsets_valid CHECK (
    (source_start IS NULL AND source_end IS NULL)
    OR (source_start IS NOT NULL AND source_end IS NOT NULL
        AND source_start >= 0 AND source_end > source_start)
  ),
  CONSTRAINT commitment_evidence_verified_has_offsets
    CHECK (verification_status <> 'verified' OR source_start IS NOT NULL),
  CONSTRAINT commitment_evidence_commitment_fk FOREIGN KEY (project_id, commitment_id)
    REFERENCES commitments (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT commitment_evidence_meeting_fk FOREIGN KEY (project_id, meeting_id)
    REFERENCES meetings (project_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS commitment_evidence_commitment_idx
  ON commitment_evidence (project_id, commitment_id, created_at);
CREATE INDEX IF NOT EXISTS commitment_evidence_meeting_idx
  ON commitment_evidence (project_id, meeting_id);

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  entity_type TEXT NOT NULL
    CONSTRAINT changes_entity_type_check
    CHECK (entity_type IN ('project', 'person', 'meeting', 'commitment', 'evidence', 'followup')),
  entity_id TEXT NOT NULL,
  actor_type TEXT NOT NULL
    CONSTRAINT changes_actor_type_check CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id TEXT NOT NULL CONSTRAINT changes_actor_id_present CHECK (length(btrim(actor_id)) > 0),
  operation TEXT NOT NULL
    CONSTRAINT changes_operation_check CHECK (operation IN ('create', 'update', 'delete')),
  before_state JSONB,
  after_state JSONB,
  reverts_change_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT changes_project_id_id_unique UNIQUE (project_id, id),
  CONSTRAINT changes_reverts_once UNIQUE (reverts_change_id),
  CONSTRAINT changes_state_matches_operation CHECK (
    (operation = 'create' AND before_state IS NULL AND after_state IS NOT NULL)
    OR (operation = 'update' AND before_state IS NOT NULL AND after_state IS NOT NULL)
    OR (operation = 'delete' AND before_state IS NOT NULL AND after_state IS NULL)
  ),
  CONSTRAINT changes_reverts_fk FOREIGN KEY (project_id, reverts_change_id)
    REFERENCES changes (project_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS changes_project_created_idx
  ON changes (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS changes_entity_idx
  ON changes (project_id, entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS followups (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  recipient_id TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CONSTRAINT followups_status_check CHECK (status IN ('draft', 'approved', 'discarded')),
  approved_at TIMESTAMPTZ,
  approved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT followups_approval_matches_status CHECK (
    (status = 'approved' AND approved_at IS NOT NULL AND approved_by IS NOT NULL)
    OR (status <> 'approved' AND approved_at IS NULL AND approved_by IS NULL)
  ),
  CONSTRAINT followups_meeting_fk FOREIGN KEY (project_id, meeting_id)
    REFERENCES meetings (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT followups_recipient_fk FOREIGN KEY (project_id, recipient_id)
    REFERENCES people (project_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS followups_project_meeting_idx
  ON followups (project_id, meeting_id);
CREATE INDEX IF NOT EXISTS followups_project_recipient_idx
  ON followups (project_id, recipient_id) WHERE recipient_id IS NOT NULL;
`,
  },
  {
    version: 2,
    name: "pactlane-meeting-analysis",
    sql: `
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS analysis_hash TEXT;

ALTER TABLE commitments ADD COLUMN IF NOT EXISTS stated_owner_name TEXT;
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS stated_due_text TEXT;

ALTER TABLE changes DROP CONSTRAINT IF EXISTS changes_entity_type_check;
ALTER TABLE changes ADD CONSTRAINT changes_entity_type_check
  CHECK (entity_type IN ('project', 'person', 'meeting', 'commitment', 'decision', 'evidence', 'followup'));

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE RESTRICT,
  meeting_id TEXT NOT NULL,
  description TEXT NOT NULL CONSTRAINT decisions_description_present CHECK (length(btrim(description)) > 0),
  needs_review BOOLEAN NOT NULL DEFAULT false,
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT decisions_project_id_id_unique UNIQUE (project_id, id),
  CONSTRAINT decisions_meeting_fk FOREIGN KEY (project_id, meeting_id)
    REFERENCES meetings (project_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS decisions_meeting_idx
  ON decisions (project_id, meeting_id, created_at);

CREATE TABLE IF NOT EXISTS decision_evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  source_quote TEXT NOT NULL CONSTRAINT decision_evidence_quote_present CHECK (length(source_quote) > 0),
  source_start INTEGER,
  source_end INTEGER,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CONSTRAINT decision_evidence_verification_status_check
    CHECK (verification_status IN ('unverified', 'verified', 'missing', 'ambiguous')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT decision_evidence_offsets_valid CHECK (
    (source_start IS NULL AND source_end IS NULL)
    OR (source_start IS NOT NULL AND source_end IS NOT NULL
        AND source_start >= 0 AND source_end > source_start)
  ),
  CONSTRAINT decision_evidence_verified_has_offsets
    CHECK (verification_status <> 'verified' OR source_start IS NOT NULL),
  CONSTRAINT decision_evidence_decision_fk FOREIGN KEY (project_id, decision_id)
    REFERENCES decisions (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT decision_evidence_meeting_fk FOREIGN KEY (project_id, meeting_id)
    REFERENCES meetings (project_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS decision_evidence_decision_idx
  ON decision_evidence (project_id, decision_id, created_at);
`,
  },
  {
    version: 3,
    name: "pactlane-human-control",
    sql: `
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS review_flags JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS review_state TEXT NOT NULL DEFAULT 'proposed';
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE commitments ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE commitments DROP CONSTRAINT IF EXISTS commitments_review_state_check;
ALTER TABLE commitments ADD CONSTRAINT commitments_review_state_check
  CHECK (review_state IN ('proposed', 'confirmed', 'rejected'));
ALTER TABLE commitments DROP CONSTRAINT IF EXISTS commitments_review_flags_is_array;
ALTER TABLE commitments ADD CONSTRAINT commitments_review_flags_is_array
  CHECK (jsonb_typeof(review_flags) = 'array');
ALTER TABLE commitments DROP CONSTRAINT IF EXISTS commitments_version_positive;
ALTER TABLE commitments ADD CONSTRAINT commitments_version_positive CHECK (version >= 1);

UPDATE commitments
  SET review_flags = jsonb_build_array(jsonb_build_object('code', 'legacy', 'message', COALESCE(review_reason, 'Flagged for review.')))
  WHERE needs_review AND review_flags = '[]'::jsonb;
`,
  },
  {
    version: 4,
    name: "pactlane-commitment-trail",
    sql: `
ALTER TABLE commitment_evidence ADD COLUMN IF NOT EXISTS linked_by TEXT;
ALTER TABLE commitment_evidence ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ;

ALTER TABLE commitment_evidence DROP CONSTRAINT IF EXISTS commitment_evidence_link_complete;
ALTER TABLE commitment_evidence ADD CONSTRAINT commitment_evidence_link_complete
  CHECK ((linked_by IS NULL) = (linked_at IS NULL));

CREATE UNIQUE INDEX IF NOT EXISTS commitment_evidence_link_unique
  ON commitment_evidence (project_id, commitment_id, meeting_id, md5(source_quote), COALESCE(source_start, -1))
  WHERE linked_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS commitment_link_dismissals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  commitment_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  source_quote TEXT NOT NULL CONSTRAINT commitment_link_dismissals_quote_present CHECK (length(source_quote) > 0),
  dismissed_by TEXT NOT NULL CONSTRAINT commitment_link_dismissals_actor_present CHECK (length(btrim(dismissed_by)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT commitment_link_dismissals_commitment_fk FOREIGN KEY (project_id, commitment_id)
    REFERENCES commitments (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT commitment_link_dismissals_meeting_fk FOREIGN KEY (project_id, meeting_id)
    REFERENCES meetings (project_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS commitment_link_dismissals_unique
  ON commitment_link_dismissals (project_id, commitment_id, meeting_id, md5(source_quote));
`,
  },
];
