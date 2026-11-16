import { LogLevel, WebClient, type Logger } from "@slack/web-api";
import { OPTIONAL_BOT_SCOPES, REQUIRED_BOT_SCOPES } from "@support-agent/shared/api/slack";
import { getDb } from "../db/client";
import { decryptSecret } from "../core/crypto";
import { getStoredSlack } from "../core/settings";
import { logger } from "../logger";
import { config } from "../config";

/** The Slack SDK's log lines, through the app's logger (warnings and errors only). */
export function slackLogger(name: string): Logger {
  const child = logger.child({ component: name });
  let level = LogLevel.WARN;
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: (...messages: unknown[]) =>
      child.warn({ detail: messages.map(String).join(" ").slice(0, 500) }, "slack"),
    // Brief disconnects are normal; the bot logs real failures itself, at error level.
    error: (...messages: unknown[]) =>
      child.warn({ detail: messages.map(String).join(" ").slice(0, 500) }, "slack"),
    setLevel: (next: LogLevel) => {
      level = next;
    },
    getLevel: () => level,
    setName: () => undefined,
  };
}

/** The Web API base URL, when SLACK_API_URL replaces Slack (tests). */
export function slackApiUrl(): { slackApiUrl?: string } {
  const url = config().SLACK_API_URL;
  return url ? { slackApiUrl: url } : {};
}

export function webClient(botToken: string): WebClient {
  return new WebClient(botToken, {
    logger: slackLogger("slack-web"),
    ...slackApiUrl(),
    // Answers should arrive within a minute or not at all.
    retryConfig: { retries: 2, factor: 2, minTimeout: 1000, maxTimeout: 10_000 },
    timeout: 20_000,
  });
}

/** A client with the stored bot token, or null when Slack is not set up. */
export async function storedWebClient(): Promise<WebClient | null> {
  const stored = await getStoredSlack(getDb());
  return stored.botTokenEncrypted ? webClient(decryptSecret(stored.botTokenEncrypted)) : null;
}

/** Channel names for display, best effort (unknown ones are left out). */
export async function channelNames(ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const client = await storedWebClient().catch(() => null);
  if (!client) return names;
  await Promise.all(
    ids.map(async (id) => {
      try {
        const info = await client.conversations.info({ channel: id });
        if (info.channel?.name) names.set(id, info.channel.name);
      } catch {
        // The bot may not see the channel yet; the name stays empty.
      }
    }),
  );
  return names;
}

export type SlackCheck = {
  ok: boolean;
  message: string;
  teamId: string | null;
  teamName: string | null;
  teamUrl: string | null;
  botUserId: string | null;
  botName: string | null;
  missingScopes: string[];
  missingOptionalScopes: string[];
};

function slackErrorCode(error: unknown): string {
  const data = (error as { data?: { error?: unknown } }).data;
  return typeof data?.error === "string" ? data.error : "request_failed";
}

/** Checks both tokens: the bot token with auth.test and its scopes, the app token by opening a connection URL. */
export async function checkSlackTokens(botToken: string, appToken: string | null): Promise<SlackCheck> {
  const empty = { teamId: null, teamName: null, teamUrl: null, botUserId: null, botName: null };
  let result: SlackCheck;
  try {
    const auth = await webClient(botToken).auth.test();
    const scopes = new Set(auth.response_metadata?.scopes ?? []);
    const missingScopes = REQUIRED_BOT_SCOPES.filter((scope) => !scopes.has(scope));
    const missingOptionalScopes = OPTIONAL_BOT_SCOPES.filter((scope) => !scopes.has(scope));
    result = {
      ok: missingScopes.length === 0,
      message:
        missingScopes.length === 0
          ? `Connected to ${auth.team ?? "the workspace"} as ${auth.user ?? "the bot"}`
          : `The bot token lacks scopes: ${missingScopes.join(", ")}. Add them and reinstall the app.`,
      teamId: auth.team_id ?? null,
      teamName: auth.team ?? null,
      teamUrl: auth.url ?? null,
      botUserId: auth.user_id ?? null,
      botName: auth.user ?? null,
      missingScopes,
      missingOptionalScopes,
    };
  } catch (error) {
    const code = slackErrorCode(error);
    return {
      ok: false,
      message:
        code === "invalid_auth" || code === "not_authed" || code === "token_revoked"
          ? "Slack rejected the bot token"
          : `Could not reach Slack (${code})`,
      ...empty,
      missingScopes: [],
      missingOptionalScopes: [],
    };
  }
  if (!appToken) {
    return { ...result, ok: false, message: "Enter the app-level token (xapp-…) as well" };
  }
  try {
    await new WebClient(undefined, {
      logger: slackLogger("slack-web"),
      timeout: 20_000,
      ...slackApiUrl(),
    }).apps.connections.open({
      token: appToken,
    });
  } catch (error) {
    const code = slackErrorCode(error);
    return {
      ...result,
      ok: false,
      message:
        code === "not_allowed_token_type" || code === "invalid_auth"
          ? "Slack rejected the app-level token; it needs the connections:write scope"
          : `The app-level token does not work (${code}). Is Socket Mode turned on?`,
    };
  }
  return result;
}
