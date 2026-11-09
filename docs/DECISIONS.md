# Architecture decisions

Lightweight records. Add new entries at the end. To reverse a decision, add a new entry and mark the old one superseded.

## ADR-001: Build on Agent-Native

- **Context:** The hackathon requires Agent-Native, and framework use is verified before rankings. Our product needs an agent and a UI working on the same data.
- **Decision:** Use the official standalone Chat template and its agent runtime, actions, auth and sync.
- **Alternatives:** A custom agent runtime, which is ineligible and slow to build; a general SaaS starter with an LLM SDK.
- **Consequences:** We inherit its conventions and a large dependency set. We must verify against the installed version.
- **Status:** Accepted

## ADR-002: Framework's React architecture, not Next.js

- **Context:** The template provides React Router and Nitro.
- **Decision:** Keep them. Do not introduce Next.js.
- **Alternatives:** Next.js, which would mean replacing framework entry points and taking on compatibility risk for no product benefit.
- **Consequences:** Most routes render on the client through action hooks.
- **Status:** Accepted

## ADR-003: Cloudflare Workers as primary host, Vercel as fallback

- **Context:** The framework documents a Workers build, and we want global serverless hosting.
- **Decision:** Target Workers through the `cloudflare_module` preset, with Vercel documented as the fallback.
- **Alternatives:** Vercel first; a long-running Node host.
- **Consequences:** Workers Paid is effectively required. Build and dry run pass, but runtime behavior including startup time is unproven. See [DEPLOYMENT.md](DEPLOYMENT.md).
- **Status:** Accepted, runtime unverified

## ADR-004: Supabase PostgreSQL

- **Context:** Workers have no persistent storage, so the database must be external. The framework uses PostgreSQL.
- **Decision:** Use Supabase purely as managed PostgreSQL.
- **Alternatives:** Cloudflare D1, explicitly rejected and not the framework's dialect; Neon, a viable equivalent.
- **Consequences:** Requires pooler discipline and separate runtime and migration connections.
- **Status:** Accepted, connection untested

## ADR-005: Drizzle, with hand-written migrations

- **Context:** The framework's data layer is Drizzle. The Chat template has no Drizzle Kit step and its guide specifies `runMigrations`. Having two migration owners is prohibited.
- **Decision:** Drizzle provides typed queries. `server/db/migrations.ts` owns all DDL. A test fails on drift between them.
- **Alternatives:** Add Drizzle Kit, a second owner the template warns against; raw SQL queries, losing type safety.
- **Consequences:** Column changes must be written in two places. The test catches omissions.
- **Status:** Accepted

## ADR-006: Modular monolith

- **Context:** A small team, a deadline and one product.
- **Decision:** One deployable application with logical domain boundaries.
- **Alternatives:** Microservices, or separate packages per domain.
- **Consequences:** Boundaries are upheld by convention, which is acceptable at this size.
- **Status:** Accepted

## ADR-007: One shared action layer

- **Context:** The product's value depends on the agent and UI having the same capabilities and rules.
- **Decision:** All product reads and writes go through `defineAction` operations used by both.
- **Alternatives:** A separate REST backend, or agent-only tools alongside UI endpoints, which would duplicate business rules.
- **Consequences:** Actions must be small, carefully validated and described well enough for a model to use.
- **Status:** Accepted

## ADR-008: No Supabase Auth

- **Context:** The framework ships Better Auth, integrated with action identity and sharing.
- **Decision:** Keep Better Auth. Use no Supabase Auth, Realtime or Edge Functions.
- **Alternatives:** Supabase Auth, which would create a second identity system.
- **Consequences:** Supabase row-level security is not the access boundary. Actions enforce access.
- **Status:** Accepted

## ADR-009: No dedicated realtime service

- **Context:** The framework invalidates queries after agent tool calls and offers polling or server-sent events.
- **Decision:** Use framework synchronization only.
- **Alternatives:** Supabase Realtime, WebSockets, Redis.
- **Consequences:** Multi-user liveness is limited on serverless, which is acceptable for the MVP.
- **Status:** Accepted

## ADR-010: Evidence must be server-verified

- **Context:** Language models can fabricate plausible quotes. A trust product cannot show those as fact.
- **Decision:** Evidence defaults to `unverified`. Only exact server comparison against the stored transcript may set a verified result. Quotes are never altered to pass.
- **Alternatives:** Trust model output, or use fuzzy matching, which can mark altered text as verified.
- **Consequences:** Paraphrased quotes will fail and go to review. Prompts must ask for verbatim quotes.
- **Status:** Accepted, implemented in Phase 1

## ADR-011: Commitments have stable identities

- **Context:** Commitment Trail requires one record to accumulate history over meetings.
- **Decision:** A commitment has one permanent id. Later meetings add evidence and changes. `commitment_evidence` also serves as the link to meetings, avoiding a separate join table.
- **Alternatives:** One record per meeting, linked afterward; a commitment-meetings join table, redundant with evidence.
- **Consequences:** Matching accuracy becomes critical. Uncertain matches go to review.
- **Status:** Accepted

## ADR-012: Human approval for sensitive changes

- **Context:** Silent reassignment or a deadline change damages trust, and transcripts are untrusted input.
- **Decision:** The agent explains proposals. Sensitive or externally visible actions need approval. Follow-ups remain drafts until approved. Approval is never treated as authorization: access checks are separate.
- **Alternatives:** Full automation, or approval on every edit, which is exhausting.
- **Consequences:** More interface work. It is also the product's main differentiator.
- **Status:** Accepted

## ADR-013: Scoped data integrity through composite foreign keys

- **Context:** A bug or a manipulated request could link a commitment to another project's meeting or person.
- **Decision:** Child tables reference `(project_id, id)`, so the database rejects cross-project links. Historical relationships use `ON DELETE RESTRICT`.
- **Alternatives:** Application checks only; soft deletes on every table.
- **Consequences:** Extra `project_id` columns and unique constraints. Hard deletes of records with history are blocked, and an archive feature is needed later.
- **Status:** Accepted

## ADR-014: First saved analysis wins

- **Context:** An agent can retry a save, and models do not repeat their output exactly. Replacing a saved analysis could discard evidence, which must be preserved.
- **Decision:** `save-analysis` stores a SHA-256 of its input in `meetings.analysis_hash` by compare-and-set inside its transaction. An identical retry returns the saved result. A different analysis of the same meeting is refused.
- **Alternatives:** A separate analyses table with versions, more than this phase needs; replacing rows on every save, which loses history.
- **Consequences:** A poor first analysis cannot be redone until an edit or re-analysis flow exists.
- **Status:** Accepted

## ADR-015: Analysis never creates people

- **Context:** Names in a transcript are not confirmed identities, and owners are `people` rows.
- **Decision:** A name verified in a quote is kept in `commitments.stated_owner_name`. `owner_id` is set only when it matches exactly one existing person in the project, and an inferred owner is never assigned.
- **Alternatives:** Creating a person for each stated name, which risks duplicates and silent assignment.
- **Consequences:** In a project with no people, commitments show the stated name without an owner link until people can be managed.
- **Status:** Accepted

## ADR-016: Human confirmation is separate from evidence verification

- **Context:** A person can accept a commitment whose quotation is not in the transcript, and an agent can propose changes. Merging the two ideas would let approval quietly turn unsupported text into verified evidence.
- **Decision:** Evidence verification stays server-set and is never touched by editing or review. A person's verdict is `commitments.review_state` with who and when. Reasons for review are structured `review_flags`, and a person accepts them one code at a time. `review-commitment` is refused to agent callers and hidden from the agent, and an agent's edit neither settles a flag nor keeps a confirmation.
- **Alternatives:** One `needs_review` boolean, which clears every reason at once; letting confirmation upgrade evidence, which breaks ADR-010; a review table with its own state machine, which is more than this needs.
- **Consequences:** A confirmed commitment can still show "Not found in transcript". Decisions have flags but no review action yet.
- **Status:** Accepted

## ADR-017: A version column guards commitment edits

- **Context:** A person and an agent can edit the same commitment, and a form can be open for a long time. Last write wins would discard work silently.
- **Decision:** `commitments.version` is sent back as `expectedVersion`, and the write is a compare-and-set in the same transaction as its `changes` row. A stale write gets `version_conflict` with the current commitment. A no-op neither writes history nor bumps the version.
- **Alternatives:** The framework's `saveIfCurrent` over a derived revision, which avoids a column but hides the version from the agent; row locks, which hold a connection while a person thinks.
- **Consequences:** Every writer of a commitment must bump the version. The browser does not merge field by field; it offers the latest version and asks the person to apply the change again.
- **Status:** Accepted

## ADR-018: A later mention is evidence, confirmed by a person

- **Context:** Pactlane's core promise is one commitment tracked across meetings. A wrong automatic match would corrupt that history, and keyword overlap cannot prove two statements mean the same thing.
- **Decision:** A later mention is a `commitment_evidence` row on the existing commitment, marked with `linked_by` and `linked_at`. Only a person can create one: `link-commitment-evidence` is `uiOnly` and hidden from the agent. Suggestions are computed on read, with reasons and no score, and only dismissals are stored.
- **Alternatives:** A separate timeline table, which would duplicate evidence and `changes`; automatic matching above a threshold, which fabricates certainty; vector search, which adds infrastructure without removing the need for a person; storing every suggestion, which adds state that goes stale.
- **Consequences:** Trails are only as complete as people's review. Paraphrases with no shared word need a manual link. A meeting dated before a commitment's origin cannot be linked.
- **Status:** Accepted

## ADR-019: Commitment health is derived, not stored or inferred

- **Context:** "Overdue" and "carried over" are claims people act on. A model or a repeated mention can make them sound true when the data does not support them.
- **Decision:** Health is computed in code from persisted status, due date, flags and evidence, against a reference date. A date counts as confirmed only when no review flag questions it. A date an agent sets gets a `deadline` flag. Delays are never counted.
- **Alternatives:** Storing health columns, which can drift; asking the model, which is not reproducible; counting repeated mentions as slippage, which fabricates history.
- **Consequences:** No slippage score exists. A past due date under an open flag is not called overdue until a person settles it.
- **Status:** Accepted
