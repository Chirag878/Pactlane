# Demo plan

**Partly functional.** Deterministic beats marked **Tested** run in the local application with real actions and saved controlled data. Analysis by a live model has not been run, so extraction remains **Unverified** until a provider is connected and the result is inspected. **Deferred** beats are not built. Show only what works.

Target: 2 to 3 minutes showing the real application, centered on one commitment across three meetings.

## Scenario

A student team, Team Northstar, is preparing a project review. Members: Aarav, Priya and Meera.

## Required demo data

Three short transcripts, each with a real date. All names are fictional, and each line is written so a verbatim quote can be checked.

**Meeting 1, Kickoff**

> Aarav: I'll prepare the presentation before Friday.
> Priya: I can write the API docs.
> Meera: The demo room will be booked before Friday.

Live-model QA expectation, not a verified result: three commitments. Aarav's has an owner and a due date. Priya's has no due date. The passive room-booking promise has no responsible person and needs review.

**Meeting 2, Check-in**

> Aarav: The presentation isn't finished. Can I get two more days?
> Priya: The API docs are done.
> Meera: I'll book the room today.

Expected: no duplicates. Each statement is suggested as a mention of the existing commitment, and confirming it adds evidence. Completing the API docs and setting Meera as owner are separate edits a person makes. A request for more days is not recorded as a delay.

**Meeting 3, Review**

> Aarav: Sorry, the presentation is still incomplete.
> Meera: Room is booked.

Expected: the presentation is linked to three meetings and still open. It is called overdue only if its due date was confirmed and has passed.

## Required product behavior

| Beat | What the viewer sees | State |
| --- | --- | --- |
| 1. Process | Paste the first transcript. The agent analyzes it. | **Unverified** — needs a connected live model |
| 2. Evidence | Commitments appear with their source quotes and server-produced verification states. | **Tested deterministically** with controlled analysis; live-model extraction unverified |
| 3. Correct | The ownerless room-booking item is flagged. The user assigns it, and the change persists. | **Tested deterministically** |
| 4. Continue | Open the second meeting. Pactlane suggests the existing commitment, with its reasons. The user confirms the link, and no duplicate appears. | **Tested deterministically** |
| 5. Detect | After the third, the agent identifies the repeated delay. | **Deferred**. The deterministic ledger can show revisited and overdue from saved data |
| 6. Propose | "The presentation commitment has been linked to three meetings and is still open. Would you like to reassign part of the work or adjust the deadline?" | **Deferred** |
| 7. Decide | The user approves or corrects the proposal. | **Deferred** as an agent proposal; manual correction is tested |
| 8. History | The Commitment Trail shows the sequence and who changed what, and each quote opens its own transcript. | **Tested deterministically**, without undo |
| 9. Result | A clear final state: one commitment, its full history and a decided next step. | **Partly tested**; the decided-next-step proposal is deferred |

## Judging alignment

| Criterion | Weight | Demonstrated by |
| --- | --- | --- |
| Usefulness and Execution | 40% | A complete, working journey on realistic transcripts |
| Creativity and Design | 20% | Commitment Trail as the centerpiece |
| Innovation | 20% | Commitments tracked over time, not per-meeting summaries |
| Cleverness and Use of Agent-Native | 20% | Agent and UI using the same actions, with edits visible to both |

## Published submission requirements

From the [official rules](https://www.builder.io/hackathon/rules), checked 2026-11-08. Re-check before submitting.

- Deadline: **November 9, 2026, 11:59 PM PT** (November 10, 07:59 UTC). Pacific Time controls.
- Build a functional application using Agent-Native.
- Submit original work or meaningful new development completed from October 27, 2026. **Identify pre-existing work, templates, libraries and third-party assets, and what changed during the event.** Pactlane must disclose the Agent-Native Chat template.
- Provide a project description, creator or team details, contact information and an accessible demonstration of the working application.
- Record a **public Clips demonstration** of the actual application in use, viewable without a login or access request.
- A public repository or live deployment is encouraged but not required.
- Submit through the project form at `builder.io/hackathon/submit` and **confirm receipt**. Recording a clip alone is not a submission.
- Entrants must be 18 or the local age of majority, and teams are allowed.
- Technical problems do not automatically extend the deadline.

## Truthfulness

Show only what works. Do not stage or simulate agent behavior in the Clip. If a planned beat is unfinished, leave it out.
