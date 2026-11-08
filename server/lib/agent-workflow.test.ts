import { getDbExec } from "@agent-native/core/db";
import {
  actionsToEngineTools,
  loadActionsFromStaticRegistry,
  runAgentLoop,
} from "@agent-native/core/server";
import { runWithRequestContext } from "@agent-native/core/server/request-context";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import createMeeting from "../../actions/create-meeting.js";
import createProject from "../../actions/create-project.js";
import getMeeting from "../../actions/get-meeting.js";
import saveAnalysis from "../../actions/save-analysis.js";
import { getDb, schema } from "../db/index.js";
import { migrations } from "../db/migrations.js";

/**
 * Exercises the framework's real agent loop and tool dispatch with a scripted
 * stand-in for the model. It proves the actions are callable as agent tools and
 * that identity comes from the run. It says nothing about extraction quality.
 */

const OWNER = "owner@example.test";
const TRANSCRIPT =
  "Priya will finish the landing page by Friday. Aarav will prepare the presentation.";

const actions = loadActionsFromStaticRegistry({
  "get-meeting": { default: getMeeting },
  "save-analysis": { default: saveAnalysis },
});

type Script = (opts: {
  messages: { role: string; content: unknown[] }[];
}) => object[];

function scriptedEngine(script: Script) {
  return {
    name: "scripted",
    label: "Scripted",
    defaultModel: "scripted",
    supportedModels: ["scripted"],
    capabilities: {
      thinking: false,
      promptCaching: false,
      vision: false,
      computerUse: false,
      parallelToolCalls: false,
    },
    async *stream(opts: { messages: { role: string; content: unknown[] }[] }) {
      for (const event of script(opts)) yield event;
    },
  };
}

const lastToolResult = (messages: { role: string; content: unknown[] }[]) => {
  for (const message of [...messages].reverse()) {
    const part = message.content.find(
      (p) => (p as { type: string }).type === "tool-result",
    ) as { content: string; isError?: boolean } | undefined;
    if (part) return part;
  }
  return undefined;
};

function toolCall(id: string, name: string, input: unknown) {
  return [
    { type: "tool-call", id, name, input },
    { type: "stop", reason: "tool_use" },
  ];
}

async function setUpMeeting() {
  const asOwner = {
    userEmail: OWNER,
    orgId: null,
    caller: "frontend",
  } as const;
  return runWithRequestContext({ userEmail: OWNER }, async () => {
    const project = await createProject.run(
      { name: "Launch", description: null },
      asOwner,
    );
    return createMeeting.run(
      {
        projectId: project.id,
        title: "Sync",
        meetingDate: "2026-11-02",
        transcript: TRANSCRIPT,
      },
      asOwner,
    );
  });
}

function runLoop(script: Script, userEmail = OWNER) {
  const events: { type: string; [key: string]: unknown }[] = [];
  return Promise.resolve(
    runWithRequestContext({ userEmail }, () =>
      runAgentLoop({
        engine: scriptedEngine(script) as never,
        model: "scripted",
        systemPrompt: "test",
        tools: actionsToEngineTools(actions),
        messages: [{ role: "user", content: [{ type: "text", text: "Go" }] }],
        actions,
        send: (event) => {
          events.push(event as never);
        },
        signal: new AbortController().signal,
        ownerEmail: userEmail,
        orgId: null,
        actionCaller: "tool",
      }),
    ),
  ).then(() => events);
}

beforeAll(async () => {
  const exec = getDbExec();
  for (const { sql } of migrations) {
    for (const statement of (sql as string).split(/;\s*\n/)) {
      if (statement.trim()) await exec.execute(statement);
    }
  }
}, 60_000);

describe("agent tool exposure", () => {
  it("offers the analysis actions as tools with usable schemas", () => {
    const tools = actionsToEngineTools(actions);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "get-meeting",
      "save-analysis",
    ]);
    const save = tools.find((t) => t.name === "save-analysis")!;
    expect(Object.keys(save.inputSchema.properties ?? {}).sort()).toEqual([
      "commitments",
      "decisions",
      "meetingId",
      "summary",
    ]);
  });
});

describe("agent loop", () => {
  it("reads the transcript and saves analysis through actions", async () => {
    const meeting = await setUpMeeting();
    let readTranscript = "";

    await runLoop(({ messages }) => {
      const result = lastToolResult(messages);
      if (!result) {
        return toolCall("call-1", "get-meeting", { id: meeting.id });
      }
      if (!readTranscript) {
        readTranscript = (JSON.parse(result.content) as { transcript: string })
          .transcript;
        return toolCall("call-2", "save-analysis", {
          meetingId: meeting.id,
          summary: "Two tasks were assigned.",
          decisions: [],
          commitments: [
            {
              description: "Prepare the presentation",
              ownerName: "Aarav",
              ownerBasis: "explicit",
              dueDate: null,
              dueDateText: null,
              dueDateBasis: null,
              priority: null,
              evidence: [
                {
                  quote: readTranscript.slice(readTranscript.indexOf("Aarav")),
                },
                { quote: "Meera owns the deployment" },
              ],
              reviewNote: null,
            },
          ],
        });
      }
      return [
        { type: "text-delta", text: "Saved." },
        { type: "stop", reason: "end_turn" },
      ];
    });

    expect(readTranscript).toBe(TRANSCRIPT);

    const [saved] = await getDb()
      .select()
      .from(schema.commitments)
      .where(eq(schema.commitments.originMeetingId, meeting.id));
    expect(saved).toMatchObject({
      statedOwnerName: "Aarav",
      dueDate: null,
      needsReview: true,
    });

    const evidence = await getDb()
      .select()
      .from(schema.commitmentEvidence)
      .where(eq(schema.commitmentEvidence.commitmentId, saved!.id));
    expect(
      Object.fromEntries(
        evidence.map((e) => [e.sourceQuote, e.verificationStatus]),
      ),
    ).toEqual({
      "Aarav will prepare the presentation.": "verified",
      "Meera owns the deployment": "missing",
    });

    const [change] = await getDb()
      .select()
      .from(schema.changes)
      .where(eq(schema.changes.entityId, saved!.id));
    expect(change).toMatchObject({ actorType: "agent", actorId: OWNER });
  }, 60_000);

  it("denies a tool call from another user's run", async () => {
    const meeting = await setUpMeeting();
    let denial: { content: string; isError?: boolean } | undefined;

    await runLoop(({ messages }) => {
      const result = lastToolResult(messages);
      if (!result) {
        return toolCall("call-1", "get-meeting", { id: meeting.id });
      }
      denial = result;
      return [{ type: "stop", reason: "end_turn" }];
    }, "other@example.test");

    expect(denial?.isError).toBe(true);
    expect(denial?.content).toContain("access_denied");
    expect(denial?.content).not.toContain(TRANSCRIPT);
  }, 60_000);
});
