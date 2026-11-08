import { PGlite } from "@electric-sql/pglite";
import { getTableColumns, getTableName } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  CHANGE_ACTOR_TYPES,
  CHANGE_ENTITY_TYPES,
  CHANGE_OPERATIONS,
  COMMITMENT_PRIORITIES,
  COMMITMENT_STATUSES,
  EVIDENCE_VERIFICATION_STATUSES,
  FOLLOWUP_STATUSES,
  MEETING_PROCESSING_STATUSES,
  PROJECT_VISIBILITIES,
} from "../../shared/domain.js";
import { migrations } from "./migrations.js";
import * as schema from "./schema.js";

const ddl = migrations.map((m) => m.sql as string).join("\n");

let db: PGlite;

const insert = (table: string, row: Record<string, unknown>) => {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  return db.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
    Object.values(row),
  );
};

const commitment = (extra: Record<string, unknown> = {}) =>
  insert("commitments", {
    id: "c1",
    project_id: "p1",
    description: "Prepare the presentation",
    ...extra,
  });

const evidence = (extra: Record<string, unknown> = {}) =>
  insert("commitment_evidence", {
    id: "e1",
    project_id: "p1",
    commitment_id: "c1",
    meeting_id: "m1",
    source_quote: "I will prepare the presentation",
    ...extra,
  });

const change = (extra: Record<string, unknown> = {}) =>
  insert("changes", {
    id: "ch1",
    project_id: "p1",
    entity_type: "commitment",
    entity_id: "c1",
    actor_type: "user",
    actor_id: "owner@example.test",
    operation: "create",
    after_state: { status: "open" },
    ...extra,
  });

beforeAll(async () => {
  db = new PGlite();
  await db.exec(ddl);
}, 60_000);

afterAll(() => db.close());

beforeEach(async () => {
  await db.exec(`TRUNCATE projects CASCADE`);
  for (const project of ["p1", "p2"]) {
    await insert("projects", { id: project, name: `Project ${project}` });
    await insert("meetings", {
      id: project === "p1" ? "m1" : "m2",
      project_id: project,
      title: "Weekly sync",
      meeting_date: "2026-11-02",
    });
    await insert("people", {
      id: project === "p1" ? "a1" : "a2",
      project_id: project,
      display_name: "Aarav",
    });
  }
});

describe("foundation migration", () => {
  it("can be re-applied after a partial run", async () => {
    await expect(db.exec(ddl)).resolves.toBeDefined();
  });

  it("matches the Drizzle columns exactly", async () => {
    const tables = [
      schema.projects,
      schema.projectShares,
      schema.people,
      schema.meetings,
      schema.commitments,
      schema.commitmentEvidence,
      schema.decisions,
      schema.decisionEvidence,
      schema.changes,
      schema.followups,
    ];
    for (const table of tables) {
      const name = getTableName(table);
      const { rows } = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [name],
      );
      const expected = Object.values(getTableColumns(table)).map((c) => c.name);
      expect(rows.map((r) => r.column_name).sort(), name).toEqual(
        [...expected].sort(),
      );
    }
  });

  it.each([
    ["projects_visibility_check", PROJECT_VISIBILITIES],
    ["meetings_processing_status_check", MEETING_PROCESSING_STATUSES],
    ["commitments_status_check", COMMITMENT_STATUSES],
    ["commitments_priority_check", COMMITMENT_PRIORITIES],
    [
      "commitment_evidence_verification_status_check",
      EVIDENCE_VERIFICATION_STATUSES,
    ],
    [
      "decision_evidence_verification_status_check",
      EVIDENCE_VERIFICATION_STATUSES,
    ],
    ["changes_entity_type_check", CHANGE_ENTITY_TYPES],
    ["changes_actor_type_check", CHANGE_ACTOR_TYPES],
    ["changes_operation_check", CHANGE_OPERATIONS],
    ["followups_status_check", FOLLOWUP_STATUSES],
  ])("%s allows exactly the shared values", async (constraint, values) => {
    const { rows } = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`,
      [constraint],
    );
    const allowed = [...rows[0]!.def.matchAll(/'([a-z_]+)'::text/g)].map(
      (m) => m[1],
    );
    expect(allowed.sort()).toEqual([...values].sort());
  });
});

describe("commitment invariants", () => {
  it("keeps unknown owners, dates and priorities unknown", async () => {
    await commitment();
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT owner_id, due_date, priority FROM commitments WHERE id = 'c1'`,
    );
    expect(rows[0]).toEqual({ owner_id: null, due_date: null, priority: null });
  });

  it("must belong to an existing project", async () => {
    await expect(commitment({ project_id: "missing" })).rejects.toThrow();
  });

  it("rejects an owner or origin meeting from another project", async () => {
    await expect(commitment({ owner_id: "a2" })).rejects.toThrow(
      /commitments_owner_fk/,
    );
    await expect(commitment({ origin_meeting_id: "m2" })).rejects.toThrow(
      /commitments_origin_meeting_fk/,
    );
  });

  it("ties completed status to a completion time", async () => {
    await expect(commitment({ status: "completed" })).rejects.toThrow(
      /completed_at_matches_status/,
    );
    await expect(
      commitment({ completed_at: new Date().toISOString() }),
    ).rejects.toThrow(/completed_at_matches_status/);
    await commitment({
      status: "completed",
      completed_at: new Date().toISOString(),
    });
  });
});

describe("evidence invariants", () => {
  beforeEach(async () => {
    await commitment({ origin_meeting_id: "m1" });
    await insert("meetings", {
      id: "m1b",
      project_id: "p1",
      title: "Follow-up",
      meeting_date: "2026-11-09",
    });
  });

  it("lets one commitment gather evidence from several meetings", async () => {
    await evidence();
    await evidence({ id: "e2", meeting_id: "m1b" });
    const { rows } = await db.query(
      `SELECT DISTINCT meeting_id FROM commitment_evidence WHERE commitment_id = 'c1'`,
    );
    expect(rows).toHaveLength(2);
  });

  it("starts unverified", async () => {
    await evidence();
    const { rows } = await db.query<{ verification_status: string }>(
      `SELECT verification_status FROM commitment_evidence`,
    );
    expect(rows[0]!.verification_status).toBe("unverified");
  });

  it("rejects a meeting from another project", async () => {
    await expect(evidence({ meeting_id: "m2" })).rejects.toThrow(
      /commitment_evidence_meeting_fk/,
    );
  });

  it("rejects verified evidence with no transcript location", async () => {
    await expect(evidence({ verification_status: "verified" })).rejects.toThrow(
      /verified_has_offsets/,
    );
  });

  it.each([
    [5, null],
    [null, 5],
    [-1, 5],
    [8, 8],
    [9, 2],
  ])("rejects invalid offsets %s..%s", async (start, end) => {
    await expect(
      evidence({ source_start: start, source_end: end }),
    ).rejects.toThrow(/offsets_valid/);
  });
});

describe("history preservation", () => {
  it.each([
    ["DELETE FROM meetings WHERE id = 'm1'", "the meeting"],
    ["DELETE FROM commitments WHERE id = 'c1'", "the commitment"],
    ["DELETE FROM projects WHERE id = 'p1'", "the project"],
  ])("blocks %s while %s has evidence", async (statement) => {
    await commitment({ origin_meeting_id: "m1" });
    await evidence();
    await expect(db.exec(statement)).rejects.toThrow(/violates RESTRICT/);
    const { rows } = await db.query(`SELECT id FROM commitment_evidence`);
    expect(rows).toHaveLength(1);
  });

  it("blocks removing a person who still owns a commitment", async () => {
    await commitment({ owner_id: "a1" });
    await expect(db.exec(`DELETE FROM people WHERE id = 'a1'`)).rejects.toThrow(
      /violates RESTRICT/,
    );
  });
});

describe("change history", () => {
  it.each([
    ["create", { before_state: { a: 1 } }],
    ["update", { before_state: null }],
    ["update", { after_state: null, before_state: { a: 1 } }],
    ["delete", { before_state: { a: 1 } }],
  ])("rejects a malformed %s record", async (operation, extra) => {
    await expect(change({ operation, ...extra })).rejects.toThrow(
      /state_matches_operation/,
    );
  });

  it("requires an attributable actor", async () => {
    await expect(change({ actor_id: "  " })).rejects.toThrow(
      /actor_id_present/,
    );
  });

  it("allows a change to be undone only once", async () => {
    await change();
    const undo = {
      operation: "update",
      before_state: { status: "open" },
      reverts_change_id: "ch1",
    };
    await change({ id: "ch2", ...undo });
    await expect(change({ id: "ch3", ...undo })).rejects.toThrow(
      /changes_reverts_once/,
    );
  });

  it("rejects an undo that points at another project", async () => {
    await change();
    await expect(
      change({
        id: "ch2",
        project_id: "p2",
        operation: "update",
        before_state: { status: "open" },
        reverts_change_id: "ch1",
      }),
    ).rejects.toThrow(/changes_reverts_fk/);
  });
});

describe("people and followups", () => {
  it("treats differently cased names as the same person", async () => {
    await expect(
      insert("people", { id: "a3", project_id: "p1", display_name: " aarav " }),
    ).rejects.toThrow(/people_project_name_unique/);
  });

  it("creates followups as unapproved drafts", async () => {
    const followup = { id: "f1", project_id: "p1", meeting_id: "m1" };
    await insert("followups", { ...followup, content: "Draft" });
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT status, approved_at FROM followups`,
    );
    expect(rows[0]).toEqual({ status: "draft", approved_at: null });
  });

  it("requires an approver and time for approved followups", async () => {
    await expect(
      insert("followups", {
        id: "f1",
        project_id: "p1",
        meeting_id: "m1",
        content: "Draft",
        status: "approved",
      }),
    ).rejects.toThrow(/approval_matches_status/);
  });
});

describe("project visibility", () => {
  it("cannot be made link-public", async () => {
    await expect(
      insert("projects", { id: "p3", name: "Open", visibility: "public" }),
    ).rejects.toThrow(/projects_visibility_check/);
  });
});
