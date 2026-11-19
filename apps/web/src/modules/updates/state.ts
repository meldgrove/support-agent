import type { Update, UpdatesResponse, UpdaterStatus } from "@support-agent/shared/api/updates";

/**
 * The update button's logic, without React: which state the button shows,
 * and how the page follows an installation until the updater reports its
 * result (the install flow every Meldgrove app shares).
 */

/** A result of the updater (`updater.last`), without its message. */
export type Result = Pick<NonNullable<UpdaterStatus["last"]>, "version" | "result" | "finishedAt">;

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
  /** `installing.startedAt` as the updater reported it (its clock): with `version`, the installation's identity. */
  startedAt: string | null;
  /** `updater.last` of the newest status before the attempt (the earlier result): never the attempt's. */
  earlier: Result | null;
  /** The app or the updater stopped answering at least once since (it restarted). */
  outage: boolean;
  /** A reachable status answered since the attempt started, without reporting it. */
  answered: boolean;
  /** Why the install answer was ambiguous; said when the installation did not start. */
  reason: string | null;
  /** The last error since the attempt started (a failed status request, no updater). */
  error: string | null;
};

/** A failed installation the page followed: shown from `updater.last`, also before the offer says so. */
export type Tracked = { version: string; finishedAt: string };

/** An installation the admin stopped waiting for: not followed again. */
export type Ignored = { version: string; startedAt: string | null; since: number };

/** After this long, the button suggests looking at the server. */
export const SLOW_AFTER_MS = 15 * 60_000;
/** How long an ambiguous install answer is reconciled with the status, from the attempt's start. */
export const RECONCILE_MS = 60_000;

export type Stage = NonNullable<UpdaterStatus["installing"]>["stage"];

export type ButtonState =
  | { kind: "unreachable" }
  | {
      kind: "installing";
      version: string;
      /** null: not known yet; "restarting": the app or the updater does not answer. */
      stage: Stage | "restarting" | null;
      /** This page follows it (and reloads when it is done). */
      following: boolean;
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
  | { kind: "available"; update: Update; attention: Update | null; failure?: Failure }
  | { kind: "attention"; update: Update; failure?: Failure }
  | { kind: "current" };

/** A followed installation that failed, shown as a line once a newer version is offered. */
export type Failure = { version: string; message: string | null };

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
    if (status?.last && response && installOutcome(followed, response, input.receivedAt) === "failed") {
      return failedState(status, status.last.version, status.last.message);
    }
    const installing = status?.installing?.version === waiting.version ? status.installing : null;
    const restarting = input.failing || (followed.confirmed && response !== undefined && !status);
    return {
      kind: "installing",
      version: waiting.version,
      stage: restarting ? "restarting" : (installing?.stage ?? null),
      following: true,
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
      following: false,
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

/**
 * A failure the page followed: the failed state, with **Try again** while the
 * version is offered. Once a newer version is offered instead, that offer,
 * with the failure as a line in it.
 */
function failedState(status: UpdaterStatus, version: string, message: string | null): ButtonState {
  const update = offered(status, version);
  if (!update && (status.available || status.attention)) {
    const failure = { version, message };
    return status.available
      ? { kind: "available", update: status.available, attention: status.attention, failure }
      : { kind: "attention", update: status.attention!, failure };
  }
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

/** A new attempt, remembered before the install request is sent, with the newest status's result. */
export function startWaiting(version: string, before: UpdatesResponse | undefined, now: number): Waiting {
  const last = before?.updater?.last;
  return {
    version,
    since: now,
    confirmed: false,
    startedAt: null,
    earlier: last ? { version: last.version, result: last.result, finishedAt: last.finishedAt } : null,
    outage: false,
    answered: false,
    reason: null,
    error: null,
  };
}

/** Follows the installation a status reports (another admin, an automatic install); null: none. */
export function adoptWaiting(response: UpdatesResponse, now: number): Waiting | null {
  const installing = response.updater?.installing;
  if (!installing) return null;
  return {
    ...startWaiting(installing.version, response, now),
    confirmed: true,
    startedAt: installing.startedAt,
  };
}

/** The answer of the install route: its HTTP status (null: no answer), its body, and the error. */
export type InstallAnswer = {
  httpStatus: number | null;
  response: UpdatesResponse | null;
  error: string | null;
};

/**
 * What the install answer means for the attempt. 202: follow it, also when
 * its body cannot be read. A refusal (4xx): forget it and show why, unless
 * its status reports an installation (someone was faster): follow that one.
 * Anything else (no updater, a network error, a timeout, an unreadable
 * answer, a 5xx) is ambiguous: keep it and reconcile until RECONCILE_MS.
 */
export function afterInstallAnswer(
  waiting: Waiting,
  answer: InstallAnswer,
  now: number,
): { waiting: Waiting | null; error: string | null } {
  const { httpStatus, response } = answer;
  if (httpStatus === 202) {
    const confirmed = { ...waiting, confirmed: true };
    return { waiting: response ? follow(confirmed, response, now) : confirmed, error: null };
  }
  if (httpStatus !== null && httpStatus >= 400 && httpStatus < 500) {
    const adopted = response ? adoptWaiting(response, now) : null;
    return adopted ? { waiting: adopted, error: null } : { waiting: null, error: answer.error };
  }
  return { waiting: { ...waiting, reason: answer.error ?? response?.error ?? null }, error: null };
}

/**
 * `updater.last` when it is the attempt's result: its version, not the
 * earlier result, and finished at or after the installation's start (the
 * updater's `startedAt` when seen, else the attempt's start cut to whole
 * seconds: the updater writes whole seconds).
 */
function attemptResult(waiting: Waiting, status: UpdaterStatus) {
  const last = status.last;
  if (!last || last.version !== waiting.version) return null;
  const earlier = waiting.earlier;
  if (
    earlier?.version === last.version &&
    earlier.result === last.result &&
    earlier.finishedAt === last.finishedAt
  ) {
    return null;
  }
  const start = waiting.startedAt ? Date.parse(waiting.startedAt) : Math.floor(waiting.since / 1000) * 1000;
  return Date.parse(last.finishedAt) >= start ? last : null;
}

/**
 * The attempt with what a fresh answer tells: the updater took it (it
 * reports it, or its result), with the installation's identity; a reachable
 * status answered without it; or no updater answered (an outage, and why).
 */
export function follow(waiting: Waiting, response: UpdatesResponse, receivedAt: number): Waiting {
  if (receivedAt < waiting.since) return waiting;
  if (!response.reachable) {
    const error = response.error ?? waiting.error;
    return waiting.outage && waiting.error === error ? waiting : { ...waiting, outage: true, error };
  }
  const status = response.updater;
  if (!status) return waiting;
  const installing = status.installing?.version === waiting.version ? status.installing : null;
  if (!installing && !attemptResult(waiting, status)) {
    return waiting.confirmed || waiting.answered ? waiting : { ...waiting, answered: true };
  }
  const startedAt = waiting.startedAt ?? installing?.startedAt ?? null;
  return waiting.confirmed && startedAt === waiting.startedAt
    ? waiting
    : { ...waiting, confirmed: true, startedAt };
}

/** A failed status request while following: an outage (the app restarts), and why. */
export function afterStatusError(waiting: Waiting, error: string): Waiting {
  return waiting.outage && waiting.error === error ? waiting : { ...waiting, outage: true, error };
}

/**
 * Where the attempt stands after an answer, first match wins: a failed
 * result; still installing (also when the app already runs the new version:
 * the server reports only once every service is healthy, and may still roll
 * back); installed; accepted by a platform, once the new app answers (or,
 * without an app version, a reachable answer after an outage); nothing
 * reports it any more and the app runs the version. An unconfirmed attempt
 * ends by its own timer (`unconfirmedEnd`), not here.
 */
export function installOutcome(
  waiting: Waiting,
  response: UpdatesResponse,
  receivedAt: number,
): "waiting" | "done" | "failed" {
  if (receivedAt < waiting.since) return "waiting";
  const status = response.reachable ? response.updater : null;
  if (!status) return "waiting";
  const app = response.app.version;
  const result = attemptResult(waiting, status);
  if (result?.result === "failed" || result?.result === "rolled-back") return "failed";
  if (status.installing?.version === waiting.version) return "waiting";
  if (result?.result === "installed") return "done";
  if (result?.result === "accepted") {
    return app === waiting.version || (app === null && waiting.outage) ? "done" : "waiting";
  }
  return !status.installing && app === waiting.version ? "done" : "waiting";
}

/** When an unconfirmed attempt is given up (ms, browser clock); null: it is confirmed. */
export function reconcileDeadline(waiting: Waiting | null): number | null {
  return waiting && !waiting.confirmed ? waiting.since + RECONCILE_MS : null;
}

/**
 * What the page says when it gives up an unconfirmed attempt at its
 * deadline: it did not start, with the install answer's reason, when a
 * reachable status answered without it; otherwise it could not be confirmed,
 * with the last error.
 */
export function unconfirmedEnd(waiting: Waiting): {
  message: "notStarted" | "notConfirmed";
  detail: string | null;
} {
  return waiting.answered
    ? { message: "notStarted", detail: waiting.reason }
    : { message: "notConfirmed", detail: waiting.error ?? waiting.reason };
}

/** Stop waiting: the installation to ignore from then on, by its identity (or its version and the attempt's start). */
export function ignoreWaiting(waiting: Waiting): Ignored {
  return { version: waiting.version, startedAt: waiting.startedAt, since: waiting.since };
}

/** Whether a reported installation is the one the admin stopped waiting for. */
export function isIgnored(
  ignored: Ignored | null,
  installing: { version: string; startedAt: string },
): boolean {
  if (ignored?.version !== installing.version) return false;
  if (ignored.startedAt !== null) return installing.startedAt === ignored.startedAt;
  return Date.parse(installing.startedAt) >= Math.floor(ignored.since / 1000) * 1000;
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
const IGNORED_KEY = "support-agent.updates.ignored";

const text = (value: unknown) => (typeof value === "string" ? value : null);

function readResult(value: unknown): Result | null {
  const result = value as Partial<Result> | null | undefined;
  return typeof result?.version === "string" &&
    typeof result.result === "string" &&
    typeof result.finishedAt === "string"
    ? { version: result.version, result: result.result, finishedAt: result.finishedAt }
    : null;
}

function load(key: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? "null") as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function save(key: string, value: object | null) {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    // Private mode: it still works until the page reloads.
  }
}

export function loadWaiting(): Waiting | null {
  const value = load(STORAGE_KEY);
  if (typeof value?.version !== "string" || typeof value.since !== "number") return null;
  return {
    version: value.version,
    since: value.since,
    confirmed: value.confirmed !== false,
    startedAt: text(value.startedAt),
    earlier: readResult(value.earlier),
    outage: value.outage === true,
    answered: value.answered === true,
    reason: text(value.reason),
    error: text(value.error),
  };
}

export function saveWaiting(waiting: Waiting | null) {
  save(STORAGE_KEY, waiting);
}

export function loadIgnored(): Ignored | null {
  const value = load(IGNORED_KEY);
  if (typeof value?.version !== "string" || typeof value.since !== "number") return null;
  return { version: value.version, startedAt: text(value.startedAt), since: value.since };
}

export function saveIgnored(ignored: Ignored | null) {
  save(IGNORED_KEY, ignored);
}
