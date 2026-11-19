import { updaterStatusSchema, type UpdaterStatus } from "@support-agent/shared/api/updates";
import { config } from "../config";
import { readLimited } from "../core/read-limited";
import { logger } from "../logger";

/**
 * The Meldgrove Updater's HTTP API at UPDATER_URL
 * (https://github.com/meldgrove/updater#the-apps-update-button). It has no
 * authentication and only answers inside the Compose network; only admin
 * routes call it.
 */
const CALLS = {
  status: { method: "GET", path: "/v1/status", timeoutMs: 3_000 },
  // A check asks the registry and GitHub; it may take up to 30 seconds.
  check: { method: "POST", path: "/v1/check", timeoutMs: 35_000 },
  install: { method: "POST", path: "/v1/install", timeoutMs: 10_000 },
  // Saving a channel checks again.
  channel: { method: "POST", path: "/v1/channel", timeoutMs: 35_000 },
} as const;

export type UpdaterCall = keyof typeof CALLS;

/** A status is a few kilobytes; anything far larger is not the updater. */
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ERROR_LENGTH = 500;

export type UpdaterResult =
  /** 2xx with a status. */
  | { kind: "ok"; httpStatus: number; status: UpdaterStatus }
  /** An error answer (4xx, 5xx) with the updater's reason for admins. */
  | { kind: "refused"; httpStatus: number; error: string }
  /** UPDATER_URL is empty, nothing answers there, it took too long, or the answer is not a status. */
  | { kind: "unreachable"; error: string };

export async function callUpdater(call: UpdaterCall, body?: Record<string, unknown>): Promise<UpdaterResult> {
  const base = config().UPDATER_URL;
  if (!base) return { kind: "unreachable", error: "The update button is off on this server (UPDATER_URL)." };
  const { method, path, timeoutMs } = CALLS[call];
  // A timer rather than AbortSignal.timeout: it also covers reading the body.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      method,
      headers:
        body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: controller.signal,
    });
    const data = parseJson(await readLimited(response, MAX_RESPONSE_BYTES));
    if (!response.ok) {
      return {
        kind: "refused",
        httpStatus: response.status,
        error: errorText(data) ?? `The update service refused the request (HTTP ${response.status}).`,
      };
    }
    const status = updaterStatusSchema.safeParse(data);
    if (status.success) return { kind: "ok", httpStatus: response.status, status: status.data };
    logger.warn({ call, httpStatus: response.status }, "unexpected answer from the updater");
    return {
      kind: "unreachable",
      error: "The update service sent an answer this version of the app does not understand.",
    };
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        kind: "unreachable",
        error: `The update service did not answer within ${timeoutMs / 1000} seconds.`,
      };
    }
    logger.debug({ call, err: error }, "updater unreachable");
    return { kind: "unreachable", error: `No update service answers at ${base}.` };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(raw: Buffer | null): unknown {
  if (!raw?.length) return null;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

/** The updater's `{"error": "<sentence for admins>"}`. */
function errorText(data: unknown): string | null {
  const error = (data as { error?: unknown } | null)?.error;
  if (typeof error !== "string" || !error.trim()) return null;
  const text = error.trim();
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}
