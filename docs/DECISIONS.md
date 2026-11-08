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
