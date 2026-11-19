import { and, eq, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { exchanges } from "../db/schema";
import { cleanSlackText } from "../agent/slack-format";
import {
  runPipeline as defaultRunPipeline,
  type AgentRuntime,
  type PipelineInput,
  type PipelineResult,
  type ThreadMessage,
} from "../agent/pipeline";
import type { ImageInput } from "../llm";
import { logger } from "../logger";
import type { BotConfig } from "./config-store";
import type { SlackFile, SlackPort } from "./slack-port";

/** The parts of a Slack message event the bot reads. */
export type MessageEvent = {
  type: "message";
  subtype?: string;
  channel: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  files?: SlackFile[];
};

export type ReactionEvent = {
  type: "reaction_added" | "reaction_removed";
  user?: string;
  reaction: string;
  item_user?: string;
  item?: { type?: string; channel?: string; ts?: string };
};

/** Message subtypes that carry a person's question. */
const HANDLED_SUBTYPES = new Set([undefined, "file_share", "thread_broadcast"]);
/** Events older than this are skipped (a backlog after downtime gets no late answers). */
const MAX_EVENT_AGE_MS = 15 * 60_000;
const MAX_IMAGES = 3;

export type HandlerDeps = {
  db: Db;
  slack: SlackPort;
  config: () => BotConfig;
  runPipeline?: (input: PipelineInput) => Promise<PipelineResult>;
  alert?: (agent: AgentRuntime, channel: string, message: string) => void;
  now?: () => number;
};

const mentionsOf = (text: string) => [...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((match) => match[1]!);

/** Whether the agent should consider the message at all (before any model call). */
export async function shouldConsider(
  deps: Pick<HandlerDeps, "db">,
  agent: AgentRuntime,
  event: MessageEvent,
  botUserId: string | null,
): Promise<{ consider: boolean; mentioned: boolean }> {
  const text = event.text ?? "";
  const mentions = mentionsOf(text);
  const mentioned = Boolean(botUserId && mentions.includes(botUserId));
  const isReply = Boolean(event.thread_ts && event.thread_ts !== event.ts);
  if (!isReply) return { consider: mentioned || agent.replyMode === "questions", mentioned };
  if (mentioned) return { consider: true, mentioned };
  if (!agent.followUpsInThreads || !agent.id) return { consider: false, mentioned };
  // Replies addressed to someone else are for people.
  if (mentions.some((id) => id !== botUserId)) return { consider: false, mentioned };
  const [answered] = await deps.db
    .select({ id: exchanges.id })
    .from(exchanges)
    .where(
      and(
        eq(exchanges.channelId, event.channel),
        eq(exchanges.agentId, agent.id),
        eq(exchanges.outcome, "answered"),
        or(eq(exchanges.threadTs, event.thread_ts!), eq(exchanges.messageTs, event.thread_ts!)),
      ),
    )
    .limit(1);
  return { consider: Boolean(answered), mentioned };
}

/** Handles one Slack message: decide, answer in the thread, record the exchange. */
export async function handleMessage(deps: HandlerDeps, event: MessageEvent): Promise<void> {
  const { slack } = deps;
  const current = deps.config();
  if (!HANDLED_SUBTYPES.has(event.subtype)) return;
  if (!event.user || event.bot_id) return;
  const agent = current.agentsByChannel.get(event.channel);
  if (!agent || !current.slack) return;
  const botUserId = current.slack.botUserId;
  if (event.user === botUserId) return;
  const now = deps.now?.() ?? Date.now();
  if (now - Number(event.ts) * 1000 > MAX_EVENT_AGE_MS) {
    logger.info({ channelId: event.channel }, "skipping an old message");
    return;
  }

  const { consider, mentioned } = await shouldConsider(deps, agent, event, botUserId);
  if (!consider) return;

  const question = cleanSlackText(event.text ?? "", botUserId).slice(0, 4000);
  const keepText = current.settings.retentionDays > 0;
  // One row per Slack message: a redelivered event finds it and stops here.
  const [row] = await deps.db
    .insert(exchanges)
    .values({
      agentId: agent.id,
      agentName: agent.name,
      channelId: event.channel,
      slackUserId: event.user,
      messageTs: event.ts,
      threadTs: event.thread_ts ?? null,
      question: keepText ? question : null,
    })
    .onConflictDoNothing()
    .returning({ id: exchanges.id });
  if (!row) return;

  const started = Date.now();
  const threadTs = event.thread_ts ?? event.ts;
  const reaction = current.settings.workingReaction;
  let reacted = false;
  let result: PipelineResult | null = null;
  let answerTs: string | null = null;
  let postError: string | null = null;
  try {
    let thread: ThreadMessage[] = [];
    if (event.thread_ts && event.thread_ts !== event.ts) {
      thread = await slack.threadHistory(event.channel, event.thread_ts, event.ts, botUserId).catch(() => []);
    }
    const images: ImageInput[] = [];
    let imageNote: string | null = null;
    const files = (event.files ?? []).filter((file) => file.mimetype?.startsWith("image/"));
    if (files.length > 0 && agent.readImages) {
      for (const file of files.slice(0, MAX_IMAGES)) {
        const image = await slack.downloadImage(file);
        if (image) images.push(image);
      }
      if (images.length < Math.min(files.length, MAX_IMAGES)) {
        imageNote = "The person attached an image that could not be read.";
      }
    } else if (files.length > 0) {
      imageNote = "The person attached an image.";
    }
    if (reaction) {
      await slack.addReaction(event.channel, event.ts, reaction);
      reacted = true;
    }
    result = await (deps.runPipeline ?? defaultRunPipeline)({
      agent,
      question: question || "(no text)",
      thread,
      images,
      mentioned,
      imageNote,
    });
    const text = result.outcome === "error" ? current.settings.errorMessage : result.slackText;
    if (text) {
      answerTs = await slack.postMessage({
        channel: event.channel,
        threadTs,
        text,
        // Only these outcomes use configured text rather than a model answer.
        ...(result.outcome === "error" || result.outcome === "no_answer" ? { autoLinkUrls: true } : {}),
        username: agent.displayName,
        iconUrl: agent.iconUrl,
      });
    }
    if (result.outcome === "error") deps.alert?.(agent, event.channel, result.error ?? "Unknown error");
  } catch (error) {
    postError = "Could not post the answer to Slack";
    logger.error(
      { err: error, agentId: agent.id, channelId: event.channel },
      "could not handle a Slack message",
    );
    deps.alert?.(agent, event.channel, postError);
  } finally {
    if (reacted && reaction) await slack.removeReaction(event.channel, event.ts, reaction);
  }

  const outcome = postError ? "error" : (result?.outcome ?? "error");
  const cited = result ? result.sources.filter((source) => result!.citedRefs.includes(source.ref)) : [];
  await deps.db
    .update(exchanges)
    .set({
      outcome,
      answer: keepText ? (result?.slackText ?? null) : null,
      reason: keepText ? (result?.reason ?? null) : null,
      searchQueries: keepText ? (result?.searchQueries ?? []) : [],
      sources: cited.map((source) => ({ title: source.title, url: source.url })),
      provider: result?.provider ?? null,
      model: result?.model ?? null,
      usedFallback: result?.usedFallback ?? false,
      error: postError ?? result?.error ?? null,
      answerTs,
      latencyMs: Date.now() - started,
      inputTokens: result?.usage.inputTokens ?? 0,
      outputTokens: result?.usage.outputTokens ?? 0,
      updatedAt: sql`now()`,
    })
    .where(eq(exchanges.id, row.id));
}

const HELPFUL = new Set(["+1", "thumbsup", "white_check_mark", "heavy_check_mark"]);
const NOT_HELPFUL = new Set(["-1", "thumbsdown"]);

/** 👍 / 👎 on an answer of the bot becomes feedback on its exchange. */
export async function handleReaction(
  deps: Pick<HandlerDeps, "db" | "config">,
  event: ReactionEvent,
): Promise<void> {
  const botUserId = deps.config().slack?.botUserId;
  if (!botUserId || event.item_user !== botUserId || event.user === botUserId) return;
  const channel = event.item?.channel;
  const ts = event.item?.ts;
  if (!channel || !ts) return;
  const value = HELPFUL.has(event.reaction) ? 1 : NOT_HELPFUL.has(event.reaction) ? -1 : 0;
  if (value === 0) return;
  const feedback = event.type === "reaction_added" ? value : 0;
  const condition = and(eq(exchanges.channelId, channel), eq(exchanges.answerTs, ts));
  await deps.db
    .update(exchanges)
    .set({ feedback, updatedAt: sql`now()` })
    .where(event.type === "reaction_added" ? condition : and(condition, eq(exchanges.feedback, value)));
}
