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
  {
    version: 5,
    name: "pactlane-meeting-intelligence",
    sql: `
ALTER TABLE changes DROP CONSTRAINT IF EXISTS changes_entity_type_check;
ALTER TABLE changes ADD CONSTRAINT changes_entity_type_check
  CHECK (entity_type IN ('project', 'person', 'meeting', 'commitment', 'decision', 'finding', 'next_meeting', 'evidence', 'followup'));

CREATE TABLE IF NOT EXISTS meeting_findings (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  kind TEXT NOT NULL
    CONSTRAINT meeting_findings_kind_check CHECK (kind IN ('open_question', 'blocker')),
  description TEXT NOT NULL
    CONSTRAINT meeting_findings_description_present CHECK (length(btrim(description)) > 0),
  needs_review BOOLEAN NOT NULL DEFAULT false,
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meeting_findings_project_id_id_unique UNIQUE (project_id, id),
  CONSTRAINT meeting_findings_meeting_fk FOREIGN KEY (project_id, meeting_id)
    REFERENCES meetings (project_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS meeting_findings_meeting_idx
  ON meeting_findings (project_id, meeting_id, kind, created_at);

CREATE TABLE IF NOT EXISTS meeting_finding_evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  finding_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  source_quote TEXT NOT NULL
    CONSTRAINT meeting_finding_evidence_quote_present CHECK (length(source_quote) > 0),
  source_start INTEGER,
  source_end INTEGER,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CONSTRAINT meeting_finding_evidence_verification_status_check
    CHECK (verification_status IN ('unverified', 'verified', 'missing', 'ambiguous')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meeting_finding_evidence_offsets_valid CHECK (
    (source_start IS NULL AND source_end IS NULL)
    OR (source_start IS NOT NULL AND source_end IS NOT NULL
        AND source_start >= 0 AND source_end > source_start)
  ),
  CONSTRAINT meeting_finding_evidence_verified_has_offsets
    CHECK (verification_status <> 'verified' OR source_start IS NOT NULL),
  CONSTRAINT meeting_finding_evidence_finding_fk FOREIGN KEY (project_id, finding_id)
    REFERENCES meeting_findings (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT meeting_finding_evidence_meeting_fk FOREIGN KEY (project_id, meeting_id)
    REFERENCES meetings (project_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS meeting_finding_evidence_finding_idx
  ON meeting_finding_evidence (project_id, finding_id, created_at);
CREATE INDEX IF NOT EXISTS meeting_finding_evidence_meeting_idx
  ON meeting_finding_evidence (project_id, meeting_id);

CREATE TABLE IF NOT EXISTS next_meeting_suggestions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  proposed_date DATE,
  stated_date_text TEXT,
  date_basis TEXT CONSTRAINT next_meeting_suggestions_date_basis_check
    CHECK (date_basis IN ('explicit', 'inferred')),
  proposed_time TEXT,
  stated_time_text TEXT,
  participants JSONB NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT next_meeting_suggestions_participants_is_array
    CHECK (jsonb_typeof(participants) = 'array'),
  purpose TEXT,
  unknowns JSONB NOT NULL DEFAULT '[]'::jsonb
    CONSTRAINT next_meeting_suggestions_unknowns_is_array
    CHECK (jsonb_typeof(unknowns) = 'array'),
  needs_review BOOLEAN NOT NULL DEFAULT false,
  review_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT next_meeting_suggestions_project_id_id_unique UNIQUE (project_id, id),
  CONSTRAINT next_meeting_suggestions_meeting_unique UNIQUE (project_id, meeting_id),
  CONSTRAINT next_meeting_suggestions_date_complete CHECK (
    (proposed_date IS NULL AND date_basis IS NULL)
    OR (proposed_date IS NOT NULL AND stated_date_text IS NOT NULL AND date_basis IS NOT NULL)
  ),
  CONSTRAINT next_meeting_suggestions_time_complete CHECK (
    proposed_time IS NULL OR stated_time_text IS NOT NULL
  ),
  CONSTRAINT next_meeting_suggestions_time_format CHECK (
    proposed_time IS NULL OR proposed_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  ),
  CONSTRAINT next_meeting_suggestions_meeting_fk FOREIGN KEY (project_id, meeting_id)
    REFERENCES meetings (project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS next_meeting_evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  suggestion_id TEXT NOT NULL,
  meeting_id TEXT NOT NULL,
  source_quote TEXT NOT NULL
    CONSTRAINT next_meeting_evidence_quote_present CHECK (length(source_quote) > 0),
  source_start INTEGER,
  source_end INTEGER,
  verification_status TEXT NOT NULL DEFAULT 'unverified'
    CONSTRAINT next_meeting_evidence_verification_status_check
    CHECK (verification_status IN ('unverified', 'verified', 'missing', 'ambiguous')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT next_meeting_evidence_offsets_valid CHECK (
    (source_start IS NULL AND source_end IS NULL)
    OR (source_start IS NOT NULL AND source_end IS NOT NULL
        AND source_start >= 0 AND source_end > source_start)
  ),
  CONSTRAINT next_meeting_evidence_verified_has_offsets
    CHECK (verification_status <> 'verified' OR source_start IS NOT NULL),
  CONSTRAINT next_meeting_evidence_suggestion_fk FOREIGN KEY (project_id, suggestion_id)
    REFERENCES next_meeting_suggestions (project_id, id) ON DELETE RESTRICT,
  CONSTRAINT next_meeting_evidence_meeting_fk FOREIGN KEY (project_id, meeting_id)
    REFERENCES meetings (project_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS next_meeting_evidence_suggestion_idx
  ON next_meeting_evidence (project_id, suggestion_id, created_at);
`,
  },
  {
    version: 6,
    name: "pactlane-analysis-publication",
    sql: `
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS analysis_publication_state TEXT NOT NULL DEFAULT 'published';
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS analysis_published_by TEXT;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS analysis_published_at TIMESTAMPTZ;

ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_analysis_publication_state_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_analysis_publication_state_check
  CHECK (analysis_publication_state IN ('draft', 'published'));
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_analysis_publication_attribution_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_analysis_publication_attribution_check
  CHECK (
    (analysis_published_by IS NULL) = (analysis_published_at IS NULL)
  );

CREATE INDEX IF NOT EXISTS meetings_project_analysis_publication_idx
  ON meetings (project_id, analysis_publication_state);
`,
  },
  {
    version: 7,
    name: "pactlane-publication-revision",
    sql: `
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS analysis_content_revision INTEGER;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS analysis_published_revision INTEGER;

UPDATE meetings
SET analysis_content_revision = CASE
      WHEN analysis_hash IS NOT NULL THEN 1
      ELSE 0
    END
WHERE analysis_content_revision IS NULL;

-- V6 marked every pre-existing meeting published. Only analyzed legacy rows
-- retain that visibility; an empty meeting has no analysis to publish.
UPDATE meetings
SET analysis_publication_state = 'draft',
    analysis_published_by = NULL,
    analysis_published_at = NULL,
    analysis_published_revision = NULL
WHERE analysis_hash IS NULL;

-- A publication attributed by v6 approved the then-current content. Material
-- edits in that application version already retracted the meeting to draft.
UPDATE meetings
SET analysis_published_revision = analysis_content_revision
WHERE analysis_publication_state = 'published'
  AND analysis_published_by IS NOT NULL
  AND analysis_published_at IS NOT NULL
  AND analysis_published_revision IS NULL;

ALTER TABLE meetings ALTER COLUMN analysis_publication_state SET DEFAULT 'draft';
ALTER TABLE meetings ALTER COLUMN analysis_content_revision SET DEFAULT 0;
ALTER TABLE meetings ALTER COLUMN analysis_content_revision SET NOT NULL;

ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_analysis_content_revision_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_analysis_content_revision_check
  CHECK (analysis_content_revision >= 0);
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_analysis_publication_attribution_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_analysis_publication_attribution_check
  CHECK (
    (
      analysis_publication_state = 'draft'
      AND analysis_published_by IS NULL
      AND analysis_published_at IS NULL
      AND analysis_published_revision IS NULL
    )
    OR (
      analysis_publication_state = 'published'
      AND (
        (
          analysis_published_by IS NULL
          AND analysis_published_at IS NULL
          AND analysis_published_revision IS NULL
        )
        OR (
          analysis_published_by IS NOT NULL
          AND analysis_published_at IS NOT NULL
          AND analysis_published_revision = analysis_content_revision
        )
      )
    )
  );
`,
  },
  {
    // Additive only. Pactlane organizations are separate from the framework's
    // own organizations (see ADR-020); existing projects stay personal.
    version: 8,
    name: "pactlane-organizations",
    sql: `
CREATE TABLE IF NOT EXISTS pactlane_organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
    CONSTRAINT pactlane_organizations_name_present
    CHECK (length(btrim(name)) > 0 AND length(name) <= 200),
  description TEXT
    CONSTRAINT pactlane_organizations_description_length
    CHECK (description IS NULL OR length(description) <= 2000),
  created_by TEXT NOT NULL
    CONSTRAINT pactlane_organizations_created_by_normalized
    CHECK (length(created_by) > 0 AND created_by = lower(btrim(created_by))),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_memberships (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  email TEXT NOT NULL
    CONSTRAINT organization_memberships_email_normalized
    CHECK (length(email) > 0 AND email = lower(btrim(email))),
  role TEXT NOT NULL
    CONSTRAINT organization_memberships_role_check
    CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active'
    CONSTRAINT organization_memberships_status_check
    CHECK (status IN ('active', 'removed')),
  added_by TEXT NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_by TEXT,
  removed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organization_memberships_org_email_unique UNIQUE (organization_id, email),
  CONSTRAINT organization_memberships_removal_complete CHECK (
    (status = 'active' AND removed_by IS NULL AND removed_at IS NULL)
    OR (status = 'removed' AND removed_by IS NOT NULL AND removed_at IS NOT NULL)
  ),
  CONSTRAINT organization_memberships_owner_active
    CHECK (role <> 'owner' OR status = 'active'),
  CONSTRAINT organization_memberships_organization_fk FOREIGN KEY (organization_id)
    REFERENCES pactlane_organizations (id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_memberships_one_owner
  ON organization_memberships (organization_id) WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS organization_memberships_email_idx
  ON organization_memberships (email, status);

CREATE TABLE IF NOT EXISTS organization_invitations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  email TEXT NOT NULL
    CONSTRAINT organization_invitations_email_normalized
    CHECK (position('@' in email) > 1 AND email = lower(btrim(email))),
  role TEXT NOT NULL
    CONSTRAINT organization_invitations_role_check
    CHECK (role IN ('admin', 'member')),
  token_hash TEXT NOT NULL
    CONSTRAINT organization_invitations_token_hash_format
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT organization_invitations_status_check
    CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  invited_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_by TEXT,
  accepted_at TIMESTAMPTZ,
  revoked_by TEXT,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT organization_invitations_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT organization_invitations_expiry_after_creation
    CHECK (expires_at > created_at),
  CONSTRAINT organization_invitations_acceptance_complete CHECK (
    (status = 'accepted') = (accepted_by IS NOT NULL AND accepted_at IS NOT NULL)
  ),
  CONSTRAINT organization_invitations_accepted_by_recipient
    CHECK (accepted_by IS NULL OR accepted_by = email),
  CONSTRAINT organization_invitations_revocation_complete CHECK (
    (status = 'revoked') = (revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  ),
  CONSTRAINT organization_invitations_organization_fk FOREIGN KEY (organization_id)
    REFERENCES pactlane_organizations (id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_invitations_one_pending
  ON organization_invitations (organization_id, email) WHERE status = 'pending';

ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id TEXT;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_organization_fk;
ALTER TABLE projects ADD CONSTRAINT projects_organization_fk
  FOREIGN KEY (organization_id) REFERENCES pactlane_organizations (id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS projects_organization_idx
  ON projects (organization_id) WHERE organization_id IS NOT NULL;
`,
  },
  {
    // Assignment handoff reuses commitments. The partial unique index makes
    // concurrent delivery idempotent for every non-terminal assignment.
    version: 9,
    name: "pactlane-commitment-assignments",
    sql: `
CREATE TABLE IF NOT EXISTS commitment_assignments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  commitment_id TEXT NOT NULL,
  recipient_account_id TEXT NOT NULL,
  recipient_email TEXT NOT NULL
    CONSTRAINT commitment_assignments_recipient_email_normalized
    CHECK (length(recipient_email) > 0 AND recipient_email = lower(btrim(recipient_email))),
  status TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT commitment_assignments_status_check
    CHECK (status IN ('pending', 'accepted', 'disputed', 'in_progress', 'completed')),
  assigned_by TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT
    CONSTRAINT commitment_assignments_note_length
    CHECK (note IS NULL OR length(note) <= 2000),
  version INTEGER NOT NULL DEFAULT 1
    CONSTRAINT commitment_assignments_version_positive CHECK (version > 0),
  completed_at TIMESTAMPTZ,
  CONSTRAINT commitment_assignments_completion_complete CHECK (
    (status = 'completed') = (completed_at IS NOT NULL)
  ),
  CONSTRAINT commitment_assignments_project_fk FOREIGN KEY (project_id)
    REFERENCES projects (id) ON DELETE RESTRICT,
  CONSTRAINT commitment_assignments_organization_fk FOREIGN KEY (organization_id)
    REFERENCES pactlane_organizations (id) ON DELETE RESTRICT,
  CONSTRAINT commitment_assignments_commitment_fk FOREIGN KEY (project_id, commitment_id)
    REFERENCES commitments (project_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS commitment_assignments_one_active
  ON commitment_assignments (commitment_id)
  WHERE status IN ('pending', 'accepted', 'in_progress');
CREATE INDEX IF NOT EXISTS commitment_assignments_recipient_idx
  ON commitment_assignments (recipient_account_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS commitment_assignments_project_idx
  ON commitment_assignments (project_id, updated_at DESC);
`,
  },
];
