import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { utimes, writeFile } from "node:fs/promises";
import { SocketModeClient } from "@slack/socket-mode";
import type { WebClient } from "@slack/web-api";
import type { BotState } from "@support-agent/shared/api/status";
import { config } from "../config";
import { getDb } from "../db/client";
import { botStatus } from "../db/schema";
import { logger } from "../logger";
import type { AgentRuntime } from "../agent/pipeline";
import { alertText } from "../agent/slack-format";
import { isSlackAuthFailure, slackApiUrl, slackErrorCode, slackLogger, webClient } from "../slack/web";
import { ConfigStore, type BotConfig } from "./config-store";
import { handleMessage, handleReaction, type MessageEvent, type ReactionEvent } from "./handler";
import { webSlackPort, type SlackPort } from "./slack-port";
import { runMaintenance } from "./maintenance";

const HEARTBEAT_MS = 30_000;
const ALERT_INTERVAL_MS = 15 * 60_000;
const MAX_QUEUE = 200;

type Envelope = { ack: () => Promise<void>; event: unknown };

/**
 * The Slack bot process: one Socket Mode connection, messages handled a few
 * at a time, a heartbeat for the admin interface and a watchdog that exits
 * (so the platform restarts the process) when Slack stays unreachable.
 */
export class Bot {
  private readonly instanceId = `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  private readonly startedAt = new Date();
  private readonly store = new ConfigStore((next, previous) => this.onConfig(next, previous));
  private socket: SocketModeClient | null = null;
  private web: WebClient | null = null;
  private port: SlackPort | null = null;
  private fingerprint: string | null = null;
  /** The bot's user ID from Slack, when the connection check has not stored it (yet). */
  private ownUserId: { fingerprint: string; id: string } | null = null;
  private state: BotState = "not_configured";
  private connectedSince: Date | null = null;
  private problemSince: number | null = null;
  private lastEventAt: Date | null = null;
  private authFailed = false;
  private running = 0;
  private readonly queue: (() => Promise<void>)[] = [];
  private readonly alerts = new Map<string, number>();
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;

  async start() {
    await this.store.start();
    this.timers.push(setInterval(() => void this.heartbeat(), HEARTBEAT_MS));
    this.timers.push(setInterval(() => this.watchdog(), 15_000));
    this.timers.push(
      setInterval(
        () =>
          void runMaintenance(getDb()).catch((error: unknown) =>
            logger.warn({ err: error }, "maintenance failed"),
          ),
        60 * 60_000,
      ),
    );
    void runMaintenance(getDb()).catch((error: unknown) => logger.warn({ err: error }, "maintenance failed"));
    await this.heartbeat();
    logger.info({ instanceId: this.instanceId }, "bot started");
  }

  private onConfig(next: BotConfig, previous: BotConfig) {
    const fingerprint = next.slack?.fingerprint ?? null;
    // A reload rebuilds the configuration from the database; keep the user ID
    // the bot looked up for these tokens.
    if (next.slack && !next.slack.botUserId && this.ownUserId?.fingerprint === fingerprint) {
      next.slack.botUserId = this.ownUserId.id;
    }
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      void this.connect(next);
    } else if (this.authFailed && next.slack) {
      // Retry a rejected token on every reload, in case Slack recovered.
      void this.connect(next);
    }
    if (next.agentsByChannel.size !== previous.agentsByChannel.size) {
      logger.info({ channels: next.agentsByChannel.size }, "agents loaded");
    }
  }

  private setState(state: BotState) {
    if (state === this.state) return;
    this.state = state;
    if (state === "connected") {
      this.connectedSince = new Date();
      this.problemSince = null;
    } else {
      this.connectedSince = null;
      this.problemSince ??= Date.now();
    }
    void this.heartbeat();
  }

  private async connect(current: BotConfig) {
    const old = this.socket;
    this.socket = null;
    if (old) {
      old.removeAllListeners();
      await old.disconnect().catch(() => undefined);
    }
    if (!current.slack) {
      this.web = null;
      this.port = null;
      this.state = "not_configured";
      this.problemSince = null;
      void this.heartbeat();
      return;
    }
    const slack = current.slack;
    this.web = webClient(slack.botToken);
    this.port = webSlackPort(this.web, slack.botToken);
    if (!slack.botUserId) {
      // Normally stored by the connection check; ask Slack once otherwise.
      try {
        const auth = await this.web.auth.test();
        if (auth.user_id) {
          this.ownUserId = { fingerprint: slack.fingerprint, id: auth.user_id };
          // A reload during the lookup may have replaced the configuration.
          for (const target of [slack, this.store.current.slack]) {
            if (target?.fingerprint === slack.fingerprint && !target.botUserId)
              target.botUserId = auth.user_id;
          }
        }
      } catch {
        logger.warn("could not look up the bot's user ID");
      }
    }
    const socket = new SocketModeClient({
      appToken: slack.appToken,
      logger: slackLogger("slack-socket"),
      autoReconnectEnabled: true,
      clientOptions: slackApiUrl(),
    });
    this.socket = socket;
    socket.on("connecting", () => this.setState("connecting"));
    socket.on("reconnecting", () => this.setState("connecting"));
    socket.on("connected", () => {
      this.authFailed = false;
      this.setState("connected");
      logger.info("connected to Slack");
    });
    socket.on("disconnected", () => {
      if (this.socket === socket && !this.stopping) {
        this.setState("disconnected");
        logger.warn("disconnected from Slack");
      }
    });
    socket.on("message", (envelope: Envelope) => this.receive(envelope, "message"));
    socket.on("reaction_added", (envelope: Envelope) => this.receive(envelope, "reaction"));
    socket.on("reaction_removed", (envelope: Envelope) => this.receive(envelope, "reaction"));
    this.setState("connecting");
    try {
      await socket.start();
    } catch (error) {
      if (this.socket !== socket) return;
      const code = slackErrorCode(error);
      this.authFailed = isSlackAuthFailure(code);
      this.setState("disconnected");
      logger.error({ code }, "could not connect to Slack");
    }
  }

  private receive(envelope: Envelope, kind: "message" | "reaction") {
    // Acknowledge at once; Slack redelivers events that wait longer than three seconds.
    void envelope.ack().catch(() => undefined);
    this.lastEventAt = new Date();
    const port = this.port;
    if (!port) return;
    const deps = {
      db: getDb(),
      slack: port,
      config: () => this.store.current,
      alert: (agent: AgentRuntime, channel: string, message: string) => this.alert(agent, channel, message),
    };
    if (kind === "reaction") {
      void handleReaction(deps, envelope.event as ReactionEvent).catch((error: unknown) =>
        logger.warn({ err: error }, "could not record feedback"),
      );
      return;
    }
    const event = envelope.event as MessageEvent;
    if (!this.store.current.agentsByChannel.has(event.channel)) return;
    this.enqueue(() => handleMessage(deps, event));
  }

  private enqueue(task: () => Promise<void>) {
    if (this.queue.length >= MAX_QUEUE) {
      logger.error("too many waiting messages; dropping one");
      return;
    }
    this.queue.push(task);
    this.drain();
  }

  private drain() {
    while (this.running < config().BOT_CONCURRENCY && this.queue.length > 0) {
      const task = this.queue.shift()!;
      this.running += 1;
      void task()
        .catch((error: unknown) => logger.error({ err: error }, "message handling failed"))
        .finally(() => {
          this.running -= 1;
          this.drain();
        });
    }
  }

  /** Posts an error to the alert channel, at most every 15 minutes per agent and error. */
  private alert(agent: AgentRuntime, channel: string, message: string) {
    const target = this.store.current.slack?.alertChannelId;
    if (!target || !this.port) return;
    const key = `${agent.id}\n${message}`;
    const last = this.alerts.get(key) ?? 0;
    if (Date.now() - last < ALERT_INTERVAL_MS) return;
    this.alerts.set(key, Date.now());
    void this.port
      .postMessage({
        channel: target,
        threadTs: null,
        text: alertText(agent.name, channel, message),
        username: null,
        iconUrl: null,
      })
      .catch(() => undefined);
  }

  private async heartbeat() {
    const now = new Date();
    try {
      await getDb()
        .insert(botStatus)
        .values({
          instanceId: this.instanceId,
          state: this.state,
          version: config().APP_VERSION ?? null,
          startedAt: this.startedAt,
          connectedSince: this.connectedSince,
          lastHeartbeatAt: now,
          lastEventAt: this.lastEventAt,
        })
        .onConflictDoUpdate({
          target: botStatus.instanceId,
          set: {
            state: this.state,
            connectedSince: this.connectedSince,
            lastHeartbeatAt: now,
            lastEventAt: this.lastEventAt,
          },
        });
    } catch (error) {
      logger.warn({ err: error }, "could not record the bot status");
    }
    // Healthy: connected, or waiting for Slack to be set up in the admin interface.
    const file = config().BOT_HEARTBEAT_FILE;
    if (file && (this.state === "connected" || this.state === "not_configured")) {
      await utimes(file, now, now).catch(() => writeFile(file, "").catch(() => undefined));
    }
  }

  /** Exits when Slack stayed unreachable too long; the platform's restart policy starts a fresh process. */
  private watchdog() {
    const limit = config().BOT_WATCHDOG_SECONDS;
    if (!limit || this.stopping || this.authFailed || this.state === "not_configured") return;
    if (this.problemSince && Date.now() - this.problemSince > limit * 1000) {
      logger.fatal(
        { seconds: limit, state: this.state },
        "Slack unreachable for too long; exiting so the process restarts",
      );
      process.exitCode = 1;
      process.kill(process.pid, "SIGTERM");
    }
  }

  async stop() {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    await this.store.stop();
    const socket = this.socket;
    this.socket = null;
    await socket?.disconnect().catch(() => undefined);
    // Give running answers a moment to finish.
    const deadline = Date.now() + 20_000;
    while (this.running > 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 250));
    this.state = "disconnected";
    await this.heartbeat();
  }
}
