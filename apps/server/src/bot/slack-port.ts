import type { WebClient } from "@slack/web-api";
import type { ImageInput } from "../llm";
import { cleanSlackText } from "../agent/slack-format";
import type { ThreadMessage } from "../agent/pipeline";

/** What the bot does in Slack. An interface, so the message handling can be tested without Slack. */
export interface SlackPort {
  postMessage(message: {
    channel: string;
    /** Null posts a new message instead of a thread reply. */
    threadTs: string | null;
    text: string;
    username: string | null;
    iconUrl: string | null;
  }): Promise<string | null>;
  addReaction(channel: string, ts: string, name: string): Promise<void>;
  removeReaction(channel: string, ts: string, name: string): Promise<void>;
  /** Earlier messages of a thread, oldest first, without the message `beforeTs` and later ones. */
  threadHistory(
    channel: string,
    threadTs: string,
    beforeTs: string,
    botUserId: string | null,
  ): Promise<ThreadMessage[]>;
  downloadImage(file: SlackFile): Promise<ImageInput | null>;
}

export type SlackFile = {
  mimetype?: string;
  size?: number;
  url_private?: string;
  url_private_download?: string;
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function slackError(error: unknown): string {
  const data = (error as { data?: { error?: unknown } }).data;
  return typeof data?.error === "string" ? data.error : "";
}

export function isReadableImage(file: SlackFile): boolean {
  return Boolean(file.mimetype && IMAGE_TYPES.has(file.mimetype) && (file.size ?? 0) <= MAX_IMAGE_BYTES);
}

export function webSlackPort(client: WebClient, botToken: string): SlackPort {
  return {
    async postMessage({ channel, threadTs, text, username, iconUrl }) {
      const base = {
        channel,
        text,
        unfurl_links: false,
        unfurl_media: false,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      };
      try {
        const response = await client.chat.postMessage({
          ...base,
          ...(username ? { username } : {}),
          ...(iconUrl ? { icon_url: iconUrl } : {}),
        });
        return response.ts ?? null;
      } catch (error) {
        // Without chat:write.customize, post under the app's own name.
        if ((username || iconUrl) && slackError(error) === "missing_scope") {
          const response = await client.chat.postMessage(base);
          return response.ts ?? null;
        }
        throw error;
      }
    },
    async addReaction(channel, ts, name) {
      await client.reactions.add({ channel, timestamp: ts, name }).catch(() => undefined);
    },
    async removeReaction(channel, ts, name) {
      await client.reactions.remove({ channel, timestamp: ts, name }).catch(() => undefined);
    },
    async threadHistory(channel, threadTs, beforeTs, botUserId) {
      const response = await client.conversations.replies({ channel, ts: threadTs, limit: 50 });
      return (response.messages ?? [])
        .filter((message) => message.ts && Number(message.ts) < Number(beforeTs))
        .slice(-15)
        .map((message) => ({
          role:
            message.bot_id || (botUserId && message.user === botUserId)
              ? ("agent" as const)
              : ("person" as const),
          text: cleanSlackText(message.text ?? "", botUserId).slice(0, 2000),
        }))
        .filter((message) => message.text !== "");
    },
    async downloadImage(file) {
      const url = file.url_private_download ?? file.url_private;
      if (!url || !isReadableImage(file)) return null;
      try {
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${botToken}` },
          signal: AbortSignal.timeout(20_000),
        });
        const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
        // Without files:read Slack answers with its sign-in page instead of the file.
        if (!response.ok || !IMAGE_TYPES.has(type)) return null;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) return null;
        return { mediaType: type as ImageInput["mediaType"], data: bytes.toString("base64") };
      } catch {
        return null;
      }
    },
  };
}
