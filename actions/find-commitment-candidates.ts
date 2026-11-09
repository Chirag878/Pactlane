import { defineAction } from "@agent-native/core/action";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { getDb, schema } from "../server/db/index.js";
import {
  authorizeMeeting,
  requireActor,
} from "../server/lib/action-context.js";
import {
  findCandidates,
  type AnalysedCommitment,
  type KnownCommitment,
} from "../server/lib/commitment-matching.js";
import { COMMITMENT_STATUSES } from "../shared/domain.js";

const settledKey = (commitmentId: string, quote: string) =>
  JSON.stringify([commitmentId, quote]);

export default defineAction({
  description:
    "Find statements in a meeting that may refer to commitments from earlier meetings of the same project. Read-only and deterministic: each result is a suggestion with plain reasons, never proof that two things are the same. Only a person can confirm a link, in the meeting page. Requires viewer access.",
  schema: z.strictObject({
    meetingId: z.string().min(1).describe("Meeting id"),
  }),
  http: { method: "GET" },
  maxResultChars: 60_000,
  outputSchema: z.object({
    meetingId: z.string(),
    statements: z.array(
      z.object({
        quote: z.string(),
        start: z.number().nullable(),
        end: z.number().nullable(),
        occurrences: z
          .number()
          .describe("Above 1 means a link would be saved as ambiguous"),
        savedFromThisMeeting: z
          .object({ id: z.string(), description: z.string() })
          .nullable()
          .describe("A possible duplicate saved by this meeting's analysis"),
        candidates: z.array(
          z.object({
            commitmentId: z.string(),
            description: z.string(),
            ownerName: z.string().nullable(),
            status: z.enum(COMMITMENT_STATUSES),
            dueDate: z.string().nullable(),
            originMeeting: z
              .object({ id: z.string(), title: z.string(), date: z.string() })
              .nullable(),
            originalQuotes: z.array(
              z.object({
                quote: z.string(),
                verificationStatus: z.string(),
              }),
            ),
            reasons: z.array(z.string()),
          }),
        ),
      }),
    ),
  }),
  run: async ({ meetingId }, ctx) => {
    requireActor(ctx);
    const meeting = await authorizeMeeting(meetingId, "viewer");
    const { projectId } = meeting;
    if (!meeting.transcript) return { meetingId, statements: [] };

    const db = getDb();
    const [commitments, evidence, dismissals, meetings, people] =
      await Promise.all([
        db
          .select()
          .from(schema.commitments)
          .where(eq(schema.commitments.projectId, projectId)),
        db
          .select()
          .from(schema.commitmentEvidence)
          .where(eq(schema.commitmentEvidence.projectId, projectId)),
        db
          .select()
          .from(schema.commitmentLinkDismissals)
          .where(
            and(
              eq(schema.commitmentLinkDismissals.projectId, projectId),
              eq(schema.commitmentLinkDismissals.meetingId, meetingId),
            ),
          ),
        db
          .select({
            id: schema.meetings.id,
            title: schema.meetings.title,
            date: schema.meetings.meetingDate,
          })
          .from(schema.meetings)
          .where(eq(schema.meetings.projectId, projectId)),
        db
          .select()
          .from(schema.people)
          .where(eq(schema.people.projectId, projectId)),
      ]);

    const meetingById = new Map(meetings.map((m) => [m.id, m]));
    const personById = new Map(people.map((p) => [p.id, p]));
    const live = commitments.filter((c) => c.reviewState !== "rejected");

    // Only commitments that already existed by this meeting can be mentioned in it.
    const earlier = live.filter((c) => {
      if (c.originMeetingId === meetingId) return false;
      const origin = c.originMeetingId
        ? meetingById.get(c.originMeetingId)
        : undefined;
      return !origin || origin.date <= meeting.meetingDate;
    });
    const known: KnownCommitment[] = earlier.map((c) => {
      const origin = c.originMeetingId
        ? meetingById.get(c.originMeetingId)
        : undefined;
      const person = c.ownerId ? personById.get(c.ownerId) : undefined;
      return {
        id: c.id,
        description: c.description,
        originMeetingId: c.originMeetingId,
        originMeetingTitle: origin?.title ?? null,
        originMeetingDate: origin?.date ?? null,
        ownerNames: [
          ...new Set(
            [
              person?.displayName,
              ...(person?.aliases ?? []),
              c.statedOwnerName,
            ].filter((name): name is string => Boolean(name)),
          ),
        ],
      };
    });
    const analysed: AnalysedCommitment[] = live
      .filter((c) => c.originMeetingId === meetingId)
      .map((c) => ({
        id: c.id,
        description: c.description,
        ranges: evidence.flatMap((e) =>
          e.commitmentId === c.id &&
          e.meetingId === meetingId &&
          e.sourceStart !== null &&
          e.sourceEnd !== null
            ? [{ start: e.sourceStart, end: e.sourceEnd }]
            : [],
        ),
      }));

    const settled = new Set([
      ...evidence
        .filter((e) => e.meetingId === meetingId)
        .map((e) => settledKey(e.commitmentId, e.sourceQuote)),
      ...dismissals.map((d) => settledKey(d.commitmentId, d.sourceQuote)),
    ]);

    const commitmentById = new Map(commitments.map((c) => [c.id, c]));
    const statements = findCandidates(
      meeting.transcript,
      known,
      analysed,
      (commitmentId, quote) => settled.has(settledKey(commitmentId, quote)),
    ).map((statement) => ({
      ...statement,
      candidates: statement.candidates.map(({ commitmentId, reasons }) => {
        const c = commitmentById.get(commitmentId)!;
        const owner = c.ownerId ? personById.get(c.ownerId) : undefined;
        return {
          commitmentId,
          description: c.description,
          ownerName: owner?.displayName ?? c.statedOwnerName,
          status: c.status,
          dueDate: c.dueDate,
          originMeeting:
            (c.originMeetingId && meetingById.get(c.originMeetingId)) || null,
          originalQuotes: evidence
            .filter(
              (e) =>
                e.commitmentId === c.id && e.meetingId === c.originMeetingId,
            )
            .slice(0, 3)
            .map((e) => ({
              quote: e.sourceQuote,
              verificationStatus: e.verificationStatus,
            })),
          reasons,
        };
      }),
    }));

    return { meetingId, statements };
  },
});
