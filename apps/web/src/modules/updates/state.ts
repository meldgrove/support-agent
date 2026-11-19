import type { Update, UpdatesResponse, UpdaterStatus } from "@support-agent/shared/api/updates";

/**
 * The update button's logic, without React: which state the button shows,
 * and when an installation the page waits for is done.
 */

/** An installation the page waits for. Kept in sessionStorage, so a reload during the restart keeps waiting. */
export type Waiting = {
  version: string;
  /** When the page started waiting (browser clock, ms). */
  since: number;
  /** `updater.last.finishedAt` before the installation, to tell its result from an older one. */
  lastBefore: string | null;
  /** `app.version` before the installation. */
  appBefore: string | null;
  /** The app stopped answering at least once since (it restarted). */
  outage: boolean;
};

/** After this long, the button suggests looking at the server. */
export const SLOW_AFTER_MS = 15 * 60_000;

export type Stage = NonNullable<UpdaterStatus["installing"]>["stage"];

export type ButtonState =
  | { kind: "unreachable" }
  | {
      kind: "installing";
      version: string;
      /** null: not known yet; "restarting": the app does not answer. */
      stage: Stage | "restarting" | null;
      slow: boolean;
    }
  | { kind: "checking" }
  | { kind: "off"; update: Update | null }
  | { kind: "failed"; version: string; message: string | null; update: Update }
  | { kind: "available"; update: Update; attention: Update | null }
  | { kind: "attention"; update: Update }
  | { kind: "current" };

export function buttonState(input: {
  response: UpdatesResponse | undefined;
  waiting: Waiting | null;
  /** A check from this page runs. */
  checking: boolean;
  /** The last request for the status failed (the app restarts). */
  failing: boolean;
  now: number;
}): ButtonState | null {
  const { response, waiting } = input;
  const status = response?.reachable ? response.updater : null;
  if (waiting) {
    const installing = status?.installing?.version === waiting.version ? status.installing : null;
    return {
      kind: "installing",
      version: waiting.version,
      stage: input.failing ? "restarting" : (installing?.stage ?? null),
      slow: input.now - waiting.since > SLOW_AFTER_MS,
    };
  }
  if (!response) return null;
  if (!status) return { kind: "unreachable" };
  if (status.installing) {
    return {
      kind: "installing",
      version: status.installing.version,
      stage: status.installing.stage,
      slow: false,
    };
  }
  if (input.checking || status.checking) return { kind: "checking" };
  if (status.mode === "off") return { kind: "off", update: status.available ?? status.attention };
  const last = status.last;
  if (last && (last.result === "failed" || last.result === "rolled-back")) {
    const update = [status.available, status.attention].find(
      (candidate) => candidate?.version === last.version && candidate.failed,
    );
    if (update)
      return { kind: "failed", version: last.version, message: last.message ?? update.failed, update };
  }
  if (status.available) return { kind: "available", update: status.available, attention: status.attention };
  if (status.attention) return { kind: "attention", update: status.attention };
  return { kind: "current" };
}

/** Whether the installation the page waits for has ended, from the latest answer. */
export function installOutcome(waiting: Waiting, response: UpdatesResponse): "done" | "failed" | "waiting" {
  if (response.app.version === waiting.version) return "done";
  const last = response.updater?.last;
  if (!last || last.version !== waiting.version || last.finishedAt === waiting.lastBefore) return "waiting";
  if (last.result === "failed" || last.result === "rolled-back") return "failed";
  // Installed (host) or accepted (platform): done once this is the new app.
  if (response.app.version !== waiting.appBefore || waiting.outage) return "done";
  // Without a version (development, images built from source) there is nothing
  // to compare; on a host, "installed" means the new version is healthy.
  if (last.result === "installed" && response.app.version === null) return "done";
  return "waiting";
}

export function startWaiting(version: string, before: UpdatesResponse | undefined, now: number): Waiting {
  return {
    version,
    since: now,
    lastBefore: before?.updater?.last?.finishedAt ?? null,
    appBefore: before?.app.version ?? null,
    outage: false,
  };
}

/** When an update installs by itself: a time, "at the next check" once that time has passed, or never. */
export function installsAt(update: Update, now: number): { at: string } | "next-check" | null {
  if (!update.installsAt) return null;
  return new Date(update.installsAt).getTime() > now ? { at: update.installsAt } : "next-check";
}

/** The notes the popover lists, and how many changes it leaves out. */
export function noteSummary(update: Update, max = 8): { notes: string[]; more: number } {
  const notes = update.notes.slice(0, max);
  return { notes, more: Math.max(update.changes, update.notes.length) - notes.length };
}

/** The updater's cooldown ("3d", "12h", "30m", "45s" or seconds) in the largest whole unit; null: none. */
export function parseCooldown(
  value: string | null,
): { unit: "days" | "hours" | "minutes"; count: number } | null {
  const match = value ? /^(\d+)\s*([dhms]?)$/.exec(value.trim()) : null;
  if (!match) return null;
  const seconds = Number(match[1]) * { d: 86_400, h: 3_600, m: 60, s: 1, "": 1 }[match[2] as "d"];
  if (seconds <= 0) return null;
  if (seconds % 86_400 === 0) return { unit: "days", count: seconds / 86_400 };
  if (seconds % 3_600 === 0) return { unit: "hours", count: seconds / 3_600 };
  return { unit: "minutes", count: Math.ceil(seconds / 60) };
}

/** "02:00-05:00" as its two times; null for anything else. */
export function parseWindow(value: string | null): { from: string; to: string } | null {
  const match = value ? /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(value.trim()) : null;
  return match ? { from: match[1]!, to: match[2]! } : null;
}

const STORAGE_KEY = "support-agent.updates.installing";

export function loadWaiting(): Waiting | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Waiting> | null;
    if (typeof value?.version !== "string" || typeof value.since !== "number") return null;
    return {
      version: value.version,
      since: value.since,
      lastBefore: typeof value.lastBefore === "string" ? value.lastBefore : null,
      appBefore: typeof value.appBefore === "string" ? value.appBefore : null,
      outage: value.outage === true,
    };
  } catch {
    return null;
  }
}

export function saveWaiting(waiting: Waiting | null) {
  try {
    if (waiting) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(waiting));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private mode: waiting still works until the page reloads.
  }
}
