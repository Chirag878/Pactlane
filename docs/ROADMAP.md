# Roadmap

Status key: 🟩 **Critical MVP**, must exist for a credible submission. ⬜ **Optional**, cut first.

## Deadline and critical path

Rules checked 2026-11-08 at [builder.io/hackathon/rules](https://www.builder.io/hackathon/rules). The final submission time is **November 9, 2026, 11:59 PM Pacific (November 10, 07:59 UTC)**, about one working day after Phase 0 finished.

That is not enough time for every phase as scoped below. The critical path is one vertical slice:

1. 🟩 Store a transcript and extract commitments with checked evidence (Phase 1).
2. 🟩 View and correct them, with the source quote visible (Phase 2, minimum).
3. 🟩 A later meeting attaches to the same commitment and shows its history (Phase 3, minimum).
4. 🟩 One agent proposal, approved by a person, recorded in history (Phase 4, minimum).
5. 🟩 Record the public Clips demo and submit through the form, then confirm receipt (Phase 5).

Deploying is optional for submission. Use the local app if hosting costs time. Judging weighs Usefulness and Execution at 40%, so a smaller working journey beats a broader unfinished one.

---

## Phase 0: Foundation

**State: complete locally. External connectivity not tested.**

- **Goal:** a validated scaffold, schema, agent rules and documentation.
- **Features:** Chat template, eight-table schema, invariant tests, `AGENTS.md`, docs.
- **Dependencies:** none.
- **Deliverables:** this repository.
- **Definition of done:** tests, typecheck, doctor, dev server, Node and Cloudflare builds all pass.
- **Risks:** the deployment runtime is unproven.
- **Can be cut:** nothing remaining.

## Phase 1: Meeting Intelligence 🟩

**State: built locally and tested with controlled inputs. Extraction by a real model is unverified until a provider is connected.**

- **Goal:** a pasted transcript becomes validated, persisted commitments.
- **Features:**
  - 🟩 `create-project`, `create-meeting`, `get-meeting`, with access checks
  - 🟩 `save-analysis` with server evidence verification and `changes` records
  - 🟩 Agent prompt or skill for extraction
  - 🟩 Decisions storage, an additive migration
  - ⬜ File upload, since paste is enough
- **Dependencies:** an LLM provider credential.
- **Deliverables:** one transcript processed from end to end.
- **Definition of done:** a sample transcript yields commitments, unknown fields stay empty, a fabricated quote is marked `missing`, and another account cannot read the project.
- **Risks:** extraction quality; model output that fails validation; prompt injection in transcripts.
- **Can be cut:** upload, priorities, summaries beyond a short paragraph.

## Phase 2: Evidence Workspace 🟩

**State: built locally and tested, including a browser run on a database copy. Not tested against a real model's output, and not deployed.**

- **Goal:** people can see, trust and correct what was extracted.
- **Features:**
  - 🟩 Commitment list and `update-commitment`, with a version check against concurrent edits
  - 🟩 Source quote with its verification state
  - 🟩 Review flag for uncertain items, resolved flag by flag
  - 🟩 Confirm, reject and restore, kept separate from evidence verification
  - 🟩 Project participants: `add-person`, `list-people`, owner selection
  - 🟩 Per-commitment change history
  - 🟩 Inline highlighting within the full transcript, where server offsets still match
  - ⬜ Editing or resolving decisions
  - ⬜ Bulk editing
  - ⬜ Editing a participant, merging two, or inviting one
- **Dependencies:** Phase 1.
- **Deliverables:** an editable workspace.
- **Definition of done:** an edit persists after reload, records a change, and is visible to the agent.
- **Risks:** time spent on interface polish.
- **Can be cut:** nothing remaining that Phase 3 needs.

## Phase 3: Commitment Trail 🟩

**State: built locally and tested, including a browser run on a database copy. Candidate matching is deterministic. No real model has used these actions, and nothing is deployed.**

- **Goal:** one commitment, tracked across meetings. This is the core differentiator.
- **Features:**
  - 🟩 Project ledger of commitments across meetings, with filters
  - 🟩 Deterministic candidate search with plain reasons
  - 🟩 A person confirms or rules out each link; the agent cannot
  - 🟩 Later evidence attached to the same commitment, verified against that meeting's transcript
  - 🟩 Trail view: meetings, evidence, edits and review decisions in sequence, with source navigation
  - 🟩 Health derived from saved data: overdue, revisited, needs review, meeting counts
  - 🟩 Resolving a duplicate saved by a later analysis
  - ⬜ Undoing a link or a dismissal
  - ⬜ Evidence kind column, such as delay or progress, an additive migration
  - ⬜ Slippage scoring
- **Dependencies:** Phases 1 and 2.
- **Deliverables:** a three-meeting history for one commitment.
- **Definition of done:** a second transcript creates no duplicate, earlier evidence is intact, and a completed commitment does not reopen from unrelated text.
- **Risks:** wrong matches. Treat uncertain matches as review items.
- **Can be cut:** scoring. Keep the trail itself.

## Phase 4: Agent Collaboration 🟩 (minimum)

- **Goal:** visible human-agent collaboration.
- **Features:**
  - 🟩 One proposal flow: detect repeated delay, suggest, approve or reject
  - 🟩 Change history visible to the user
  - ⬜ `undo-change`
  - ⬜ Natural-language bulk changes
- **Dependencies:** Phase 3.
- **Deliverables:** a proposal that changes data only after approval.
- **Definition of done:** a rejected proposal changes nothing; an approved one is attributed correctly.
- **Risks:** approval UX. Check the framework's `needsApproval` and suggestion actions first.
- **Can be cut:** undo, if history is still visible. Undo is in the demo plan, so cut it last among optional items.

## Phase 5: Polish and Submission 🟩

- **Goal:** a truthful, working submission.
- **Features:**
  - 🟩 Three demo transcripts
  - 🟩 Run the full journey, then fix what fails
  - 🟩 Public Clips demonstration
  - 🟩 Submit, including disclosure of the template and pre-existing work, and confirm receipt
  - ⬜ Visual refinement
  - ⬜ Production deployment
- **Dependencies:** whichever critical items are finished.
- **Deliverables:** a confirmed submission.
- **Definition of done:** the Clip opens without a login and submission receipt is confirmed.
- **Risks:** last-minute failures. The rules say technical problems do not automatically extend the deadline, so submit early.
- **Can be cut:** deployment and visual refinement.

## Post-MVP ⬜

- **Goal:** extend from a demo to a daily tool.
- **Features:** advanced analytics, team collaboration and roles, external integrations, scheduling, automation, follow-up delivery, agenda generation.
- **Dependencies:** a validated MVP.
- **Deliverables:** to be scoped.
- **Definition of done:** to be defined per feature.
- **Risks:** scope creep.
- **Can be cut:** all of it. See [IDEAS.md](IDEAS.md).
