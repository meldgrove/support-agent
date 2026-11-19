import type { Update, UpdatesResponse, UpdaterStatus } from "@support-agent/shared/api/updates";

/**
 * The update button's logic, without React: which state the button shows,
 * and how the page follows an installation until the updater reports its
 * result (the install flow every Meldgrove app shares).
 */

/**
 * An installation the page follows. Kept in sessionStorage from before the
 * install request on, so a reload during the restart keeps following it.
 */
export type Waiting = {
  version: string;
  /** When the attempt started (browser clock, ms). Only answers received since count. */
  since: number;
  /** The updater took it: a 202, or a status that reports it. Until then the page reconciles. */
  confirmed: boolean;
  /** `installing.startedAt` as the updater reported it (its clock); earlier results are older. */
  startedAt: string | null;
  /** `updater.last.finishedAt` before the attempt: that result is older. */
  lastBefore: string | null;
  /** The app stopped answering at least once since (it restarted). */
  outage: boolean;
  /** Why the install answer was ambiguous; said when the installation did not start. */
  reason: string | null;
};

/** A failed installation the page followed: shown from `updater.last`, also before the offer says so. */
export type Tracked = { version: string; finishedAt: string };

/** After this long, the button suggests looking at the server. */
export const SLOW_AFTER_MS = 15 * 60_000;
/** How long an ambiguous install answer is reconciled with the status. */
export const RECONCILE_MS = 60_000;

export type Stage = NonNullable<UpdaterStatus["installing"]>["stage"];

export type ButtonState =
  | { kind: "unreachable" }
  | {
      kind: "installing";
      version: string;
      /** null: not known yet; "restarting": the app or the updater does not answer. */
      stage: Stage | "restarting" | null;
      slow: boolean;
    }
  | { kind: "checking" }
  /** Mode off with nothing new; with something new, mode off shows it without installing. */
  | { kind: "off" }
  | {
      kind: "failed";
      version: string;
      message: string | null;
      /** The offer to try again; null once the version is no longer offered. */
      update: Update | null;
      /** The offer needs upgrade steps: trying again asks as **Install anyway…** does. */
      attention: boolean;
    }
  | { kind: "available"; update: Update; attention: Update | null }
  | { kind: "attention"; update: Update }
  | { kind: "current" };

export function buttonState(input: {
  response: UpdatesResponse | undefined;
  /** When `response` arrived (ms). */
  receivedAt: number;
  waiting: Waiting | null;
  tracked: Tracked | null;
  /** A check from this page runs. */
  checking: boolean;
  /** The last request for the status failed (the app restarts). */
  failing: boolean;
  now: number;
}): ButtonState | null {
  const { response, waiting } = input;
  const status = response?.reachable ? response.updater : null;
  if (waiting) {
    const followed = response ? follow(waiting, response, input.receivedAt) : waiting;
    if (
      status?.last &&
      response &&
      installOutcome(followed, response, input.receivedAt, input.now) === "failed"
    ) {
      return failedState(status, status.last.version, status.last.message);
    }
    const installing = status?.installing?.version === waiting.version ? status.installing : null;
    const restarting = input.failing || (followed.confirmed && response !== undefined && !status);
    return {
      kind: "installing",
      version: waiting.version,
      stage: restarting ? "restarting" : (installing?.stage ?? null),
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
  const last = status.last;
  if (last && (last.result === "failed" || last.result === "rolled-back")) {
    const tracked = input.tracked?.version === last.version && input.tracked.finishedAt === last.finishedAt;
    if (tracked || offered(status, last.version)?.failed)
      return failedState(status, last.version, last.message);
  }
  if (status.available) return { kind: "available", update: status.available, attention: status.attention };
  if (status.attention) return { kind: "attention", update: status.attention };
  return status.mode === "off" ? { kind: "off" } : { kind: "current" };
}

/** The available or attention offer of a version. */
function offered(status: UpdaterStatus, version: string): Update | null {
  return [status.available, status.attention].find((update) => update?.version === version) ?? null;
}

function failedState(status: UpdaterStatus, version: string, message: string | null): ButtonState {
  const update = offered(status, version);
  return {
    kind: "failed",
    version,
    message: message ?? update?.failed ?? null,
    update,
    attention: update !== null && update === status.attention,
  };
}

/**
 * What the popover offers for an update: install it; nothing (mode off); or,
 * for a release with upgrade steps that the image tag set where the app is
 * deployed does not reach (`channelLocked`), to change that tag.
 */
export function installAction(status: UpdaterStatus, attention: boolean): "install" | "off" | "tag" {
  if (status.mode === "off") return "off";
  return attention && status.channelLocked !== null ? "tag" : "install";
}

/** A new attempt, remembered before the install request is sent. */
export function startWaiting(version: string, before: UpdatesResponse | undefined, now: number): Waiting {
  return {
    version,
    since: now,
    confirmed: false,
    startedAt: null,
    lastBefore: before?.updater?.last?.finishedAt ?? null,
    outage: false,
    reason: null,
  };
}

/** Follows the installation a status reports (another admin, an automatic install); null: none. */
export function adoptWaiting(response: UpdatesResponse, now: number): Waiting | null {
  const installing = response.updater?.installing;
  if (!installing) return null;
  return {
    version: installing.version,
    since: now,
    confirmed: true,
    startedAt: installing.startedAt,
    lastBefore: response.updater?.last?.finishedAt ?? null,
    outage: false,
    reason: null,
  };
}

/** The answer of the install route: its HTTP status (null: no answer), its body, and the error. */
export type InstallAnswer = {
  httpStatus: number | null;
  response: UpdatesResponse | null;
  error: string | null;
};

/**
 * What the install answer means for the attempt. 202: follow it. A refusal
 * (4xx): forget it and show why, unless its status reports an installation
 * (someone was faster): follow that one. Anything else (no updater, a
 * network error, a timeout, a 5xx) is ambiguous: keep it and reconcile.
 */
export function afterInstallAnswer(
  waiting: Waiting,
  answer: InstallAnswer,
  now: number,
): { waiting: Waiting | null; error: string | null } {
  const { httpStatus, response } = answer;
  if (httpStatus === 202 && response?.reachable) {
    return { waiting: follow({ ...waiting, confirmed: true }, response, now), error: null };
  }
  if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500) {
    const adopted = response ? adoptWaiting(response, now) : null;
    return adopted ? { waiting: adopted, error: null } : { waiting: null, error: answer.error };
  }
  return { waiting: { ...waiting, reason: answer.error ?? response?.error ?? null }, error: null };
}

/** `updater.last` when it is the attempt's result: its version, finished at or after the attempt's start. */
function attemptResult(waiting: Waiting, status: UpdaterStatus) {
  const last = status.last;
  if (!last || last.version !== waiting.version || last.finishedAt === waiting.lastBefore) return null;
  // The updater's times have whole seconds.
  const start = waiting.startedAt ? Date.parse(waiting.startedAt) : Math.floor(waiting.since / 1000) * 1000;
  return Date.parse(last.finishedAt) >= start ? last : null;
}

/** The attempt with what a fresh answer tells: the updater took it (it reports it, or its result). */
export function follow(waiting: Waiting, response: UpdatesResponse, receivedAt: number): Waiting {
  const status = response.updater;
  if (receivedAt < waiting.since || !status) return waiting;
  const installing = status.installing?.version === waiting.version ? status.installing : null;
  if (!installing && !attemptResult(waiting, status)) return waiting;
  const startedAt = waiting.startedAt ?? installing?.startedAt ?? null;
  return waiting.confirmed && startedAt === waiting.startedAt
    ? waiting
    : { ...waiting, confirmed: true, startedAt };
}

/**
 * Where the attempt stands after an answer, first match wins: a failed
 * result; still installing (also when the app already runs the new version:
 * the server reports only once every service is healthy, and may still roll
 * back); installed; accepted by a platform, once the new app answers;
 * nothing reports it any more and the app runs the version. An unconfirmed
 * attempt without any of these is given up after RECONCILE_MS.
 */
export function installOutcome(
  waiting: Waiting,
  response: UpdatesResponse,
  receivedAt: number,
  now: number,
): "waiting" | "done" | "failed" | "not-started" {
  if (receivedAt < waiting.since) return "waiting";
  const status = response.reachable ? response.updater : null;
  const app = response.app.version;
  if (status) {
    const result = attemptResult(waiting, status);
    if (result?.result === "failed" || result?.result === "rolled-back") return "failed";
    if (status.installing?.version === waiting.version) return "waiting";
    if (result?.result === "installed") return "done";
    if (result?.result === "accepted") {
      return app === waiting.version || (app === null && waiting.outage) ? "done" : "waiting";
    }
    if (!status.installing && app === waiting.version) return "done";
  }
  return !waiting.confirmed && now - waiting.since >= RECONCILE_MS ? "not-started" : "waiting";
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
      confirmed: value.confirmed !== false,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
      lastBefore: typeof value.lastBefore === "string" ? value.lastBefore : null,
      outage: value.outage === true,
      reason: typeof value.reason === "string" ? value.reason : null,
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
