import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { DEFAULT_APP_SETTINGS } from "@support-agent/shared/api/settings";
import { getDb } from "../db/client";
import { agents, exchanges } from "../db/schema";
import { resetDatabase } from "../test/helpers";
import type { AgentRuntime, PipelineResult } from "../agent/pipeline";
import type { BotConfig } from "./config-store";
import { handleMessage, handleReaction, type MessageEvent } from "./handler";
import type { SlackPort } from "./slack-port";
import { runMaintenance } from "./maintenance";
import { putSetting } from "../core/settings";

const AGENT_ID = "00000000-0000-4000-8000-0000000000a1";
const BOT = "UBOT";

function agent(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    id: AGENT_ID,
    name: "IT support",
    enabled: true,
    instructions: "",
    replyMode: "questions",
    followUpsInThreads: false,
    noAnswerMode: "escalate",
    escalationMessage: "Ask the IT team.",
    displayName: "IT Helper",
    iconUrl: null,
    readImages: true,
    channelIds: ["C0SUPPORT"],
    main: null,
    fallback: null,
    sources: [],
    ...overrides,
  };
}

function botConfig(runtime: AgentRuntime, settings = DEFAULT_APP_SETTINGS): BotConfig {
  return {
    slack: {
      botToken: "xoxb",
      appToken: "xapp",
      botUserId: BOT,
      teamUrl: null,
      alertChannelId: null,
      fingerprint: "f",
    },
    settings,
    agentsByChannel: new Map(runtime.channelIds.map((id) => [id, runtime])),
  };
}

function result(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    outcome: "answered",
    reason: "A question",
    searchQueries: ["printer"],
    sources: [
      {
        ref: "S1",
        knowledgeSourceName: "KB",
        title: "Printers",
        url: "https://it.example.org/p",
        section: null,
        text: "x",
      },
    ],
    citedRefs: ["S1"],
    slackText: "Use the printer on floor 2.",
    provider: "Main",
    model: "m",
    usedFallback: false,
    error: null,
    timings: { triageMs: 1, searchMs: 1, answerMs: 1, totalMs: 3 },
    usage: { inputTokens: 50, outputTokens: 5 },
    ...overrides,
  };
}

function fakeSlack() {
  const posted: Parameters<SlackPort["postMessage"]>[0][] = [];
  const reactions: string[] = [];
  const port: SlackPort = {
    postMessage: vi.fn(async (message) => {
      posted.push(message);
      return `17000000${posted.length}.000100`;
    }),
    addReaction: vi.fn(async (_channel, ts, name) => {
      reactions.push(`+${name}@${ts}`);
    }),
    removeReaction: vi.fn(async (_channel, ts, name) => {
      reactions.push(`-${name}@${ts}`);
    }),
    threadHistory: vi.fn(async () => [{ role: "person" as const, text: "earlier" }]),
    downloadImage: vi.fn(async () => null),
  };
  return { port, posted, reactions };
}

const nowSeconds = () => (Date.now() / 1000).toFixed(6);
const message = (overrides: Partial<MessageEvent> = {}): MessageEvent => ({
  type: "message",
  channel: "C0SUPPORT",
  user: "UPERSON",
  text: "Which printer can I use?",
  ts: nowSeconds(),
  ...overrides,
});

beforeEach(async () => {
  await resetDatabase();
  await getDb().insert(agents).values({ id: AGENT_ID, name: "IT support" });
});

describe("handleMessage", () => {
  it("answers a question in its thread and records the exchange", async () => {
    const slack = fakeSlack();
    const run = vi.fn(async () => result());
    const event = message();
    await handleMessage(
      { db: getDb(), slack: slack.port, config: () => botConfig(agent()), runPipeline: run },
      event,
    );
    expect(slack.posted).toEqual([
      {
        channel: "C0SUPPORT",
        threadTs: event.ts,
        text: "Use the printer on floor 2.",
        username: "IT Helper",
        iconUrl: null,
      },
    ]);
    expect(slack.reactions).toEqual([`+eyes@${event.ts}`, `-eyes@${event.ts}`]);
    const [row] = await getDb().select().from(exchanges);
    expect(row).toMatchObject({
      agentId: AGENT_ID,
      outcome: "answered",
      question: "Which printer can I use?",
      answer: "Use the printer on floor 2.",
      sources: [{ title: "Printers", url: "https://it.example.org/p" }],
      answerTs: "170000001.000100",
      inputTokens: 50,
    });
  });

  it("handles a redelivered event only once", async () => {
    const slack = fakeSlack();
    const run = vi.fn(async () => result());
    const event = message();
    const deps = { db: getDb(), slack: slack.port, config: () => botConfig(agent()), runPipeline: run };
    await Promise.all([handleMessage(deps, event), handleMessage(deps, event)]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(slack.posted).toHaveLength(1);
  });

  it("ignores bots, other channels, edits, old messages and its own messages", async () => {
    const slack = fakeSlack();
    const run = vi.fn(async () => result());
    const deps = { db: getDb(), slack: slack.port, config: () => botConfig(agent()), runPipeline: run };
    await handleMessage(deps, message({ bot_id: "B1" }));
    await handleMessage(deps, message({ channel: "C0OTHER" }));
    await handleMessage(deps, message({ subtype: "message_changed" }));
    await handleMessage(deps, message({ user: BOT }));
    await handleMessage(deps, message({ ts: (Date.now() / 1000 - 3600).toFixed(6) }));
    expect(run).not.toHaveBeenCalled();
    expect(await getDb().select().from(exchanges)).toHaveLength(0);
  });

  it("in mentions mode answers only when mentioned", async () => {
    const slack = fakeSlack();
    const run = vi.fn(async () => result());
    const deps = {
      db: getDb(),
      slack: slack.port,
      config: () => botConfig(agent({ replyMode: "mentions" })),
      runPipeline: run,
    };
    await handleMessage(deps, message());
    expect(run).not.toHaveBeenCalled();
    await handleMessage(deps, message({ text: `<@${BOT}> which printer?` }));
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ question: "which printer?", mentioned: true }),
    );
  });

  it("answers thread replies with a mention, and follow-ups only when enabled", async () => {
    const slack = fakeSlack();
    const run = vi.fn(async () => result());
    const root = message();
    const deps = { db: getDb(), slack: slack.port, config: () => botConfig(agent()), runPipeline: run };
    await handleMessage(deps, root);
    await handleMessage(deps, message({ thread_ts: root.ts, text: "And in colour?" }));
    expect(run).toHaveBeenCalledTimes(1);

    const followUps = { ...deps, config: () => botConfig(agent({ followUpsInThreads: true })) };
    await handleMessage(followUps, message({ thread_ts: root.ts, text: "<@UCOLLEAGUE> can you check?" }));
    expect(run).toHaveBeenCalledTimes(1);
    await handleMessage(followUps, message({ thread_ts: root.ts, text: "And in colour?" }));
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith(
      expect.objectContaining({ thread: [{ role: "person", text: "earlier" }] }),
    );
    expect(slack.posted.at(-1)?.threadTs).toBe(root.ts);
  });

  it("posts the error message, alerts, and records the error", async () => {
    const slack = fakeSlack();
    const alert = vi.fn();
    const run = vi.fn(async () =>
      result({ outcome: "error", error: "The API key was rejected", slackText: null }),
    );
    await handleMessage(
      { db: getDb(), slack: slack.port, config: () => botConfig(agent()), runPipeline: run, alert },
      message(),
    );
    expect(slack.posted[0]?.text).toBe(DEFAULT_APP_SETTINGS.errorMessage);
    expect(alert).toHaveBeenCalledWith(
      expect.objectContaining({ id: AGENT_ID }),
      "C0SUPPORT",
      "The API key was rejected",
    );
    const [row] = await getDb().select().from(exchanges);
    expect(row).toMatchObject({ outcome: "error", error: "The API key was rejected" });
  });

  it("stays silent without posting, and keeps no text when retention is 0", async () => {
    const slack = fakeSlack();
    const run = vi.fn(async () => result({ outcome: "silent", slackText: null, sources: [], citedRefs: [] }));
    const settings = { ...DEFAULT_APP_SETTINGS, retentionDays: 0, workingReaction: null };
    await handleMessage(
      { db: getDb(), slack: slack.port, config: () => botConfig(agent(), settings), runPipeline: run },
      message(),
    );
    expect(slack.posted).toHaveLength(0);
    expect(slack.reactions).toHaveLength(0);
    const [row] = await getDb().select().from(exchanges);
    expect(row).toMatchObject({ outcome: "silent", question: null, answer: null, reason: null });
  });

  it("notes images it could not read", async () => {
    const slack = fakeSlack();
    const run = vi.fn(async () => result());
    await handleMessage(
      { db: getDb(), slack: slack.port, config: () => botConfig(agent()), runPipeline: run },
      message({
        subtype: "file_share",
        files: [{ mimetype: "image/png", size: 10, url_private: "https://files.slack.com/x" }],
      }),
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [],
        imageNote: "The person attached an image that could not be read.",
      }),
    );
  });
});

describe("handleReaction", () => {
  it("records 👍 and 👎 on the bot's answers", async () => {
    const slack = fakeSlack();
    const config = () => botConfig(agent());
    await handleMessage(
      { db: getDb(), slack: slack.port, config, runPipeline: async () => result() },
      message(),
    );
    const item = { type: "message", channel: "C0SUPPORT", ts: "170000001.000100" };
    await handleReaction(
      { db: getDb(), config },
      { type: "reaction_added", user: "UPERSON", reaction: "+1", item_user: BOT, item },
    );
    expect((await getDb().select().from(exchanges))[0]?.feedback).toBe(1);
    await handleReaction(
      { db: getDb(), config },
      { type: "reaction_added", user: "UPERSON", reaction: "-1", item_user: "UOTHER", item },
    );
    expect((await getDb().select().from(exchanges))[0]?.feedback).toBe(1);
    await handleReaction(
      { db: getDb(), config },
      { type: "reaction_removed", user: "UPERSON", reaction: "+1", item_user: BOT, item },
    );
    expect((await getDb().select().from(exchanges))[0]?.feedback).toBe(0);
  });
});

describe("runMaintenance", () => {
  it("removes texts after the retention period", async () => {
    const db = getDb();
    await putSetting(db, "app", { ...DEFAULT_APP_SETTINGS, retentionDays: 30 });
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000);
    await db.insert(exchanges).values([
      {
        channelId: "C1",
        messageTs: "1.1",
        question: "old",
        answer: "a",
        reason: "r",
        outcome: "answered",
        createdAt: old,
      },
      { channelId: "C1", messageTs: "1.2", question: "new", answer: "b", outcome: "answered" },
    ]);
    await runMaintenance(db);
    const [oldRow] = await db.select().from(exchanges).where(eq(exchanges.messageTs, "1.1"));
    const [newRow] = await db.select().from(exchanges).where(eq(exchanges.messageTs, "1.2"));
    expect(oldRow).toMatchObject({ question: null, answer: null, reason: null, outcome: "answered" });
    expect(oldRow?.textRemovedAt).not.toBeNull();
    expect(newRow).toMatchObject({ question: "new", answer: "b" });
  });
});
