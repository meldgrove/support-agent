import { describe, expect, it } from "vitest";
import type { Update, UpdatesResponse, UpdaterStatus } from "@support-agent/shared/api/updates";
import {
  buttonState,
  installOutcome,
  installsAt,
  noteSummary,
  parseCooldown,
  parseWindow,
  SLOW_AFTER_MS,
  startWaiting,
  type Waiting,
} from "./state";

const NOW = Date.parse("2026-11-19T10:00:00.000Z");

const update = (version: string, extra: Partial<Update> = {}): Update => ({
  version,
  preview: false,
  publishedAt: "2026-11-18T10:00:00.000Z",
  url: `https://github.com/meldgrove/support-agent/releases/tag/v${version}`,
  notes: ["Fix the sign-in loop"],
  changes: 1,
  installsAt: null,
  failed: null,
  ...extra,
});

const status = (extra: Partial<UpdaterStatus> = {}): UpdaterStatus => ({
  updater: "0.2.0",
  mode: "host",
  channel: "stable",
  channelLocked: null,
  installed: "0.2.0",
  available: null,
  attention: null,
  installing: null,
  last: null,
  checking: false,
  checkedAt: "2026-11-19T09:50:00.000Z",
  error: null,
  automatic: true,
  cooldown: "3d",
  window: null,
  timezone: "UTC",
  ...extra,
});

const reachable = (
  extra: Partial<UpdaterStatus> = {},
  appVersion: string | null = "0.2.0",
): UpdatesResponse => ({
  app: { version: appVersion },
  reachable: true,
  updater: status(extra),
  error: null,
});

const stateOf = (
  response: UpdatesResponse | undefined,
  extra: { waiting?: Waiting; checking?: boolean } = {},
) =>
  buttonState({
    response,
    waiting: extra.waiting ?? null,
    checking: extra.checking ?? false,
    failing: false,
    now: NOW,
  });

describe("buttonState", () => {
  it("shows nothing before the first answer", () => {
    expect(stateOf(undefined)).toBeNull();
  });

  it("derives every state of the table", () => {
    const unreachable: UpdatesResponse = {
      app: { version: null },
      reachable: false,
      updater: null,
      error: "No update service answers at http://updater:8080.",
    };
    expect(stateOf(unreachable)).toEqual({ kind: "unreachable" });
    expect(stateOf(reachable())).toEqual({ kind: "current" });
    expect(stateOf(reachable(), { checking: true })).toEqual({ kind: "checking" });
    expect(stateOf(reachable({ checking: true }))).toEqual({ kind: "checking" });
    expect(stateOf(reachable({ available: update("0.2.1") }))).toEqual({
      kind: "available",
      update: update("0.2.1"),
      attention: null,
    });
    expect(stateOf(reachable({ attention: update("0.3.0") }))).toEqual({
      kind: "attention",
      update: update("0.3.0"),
    });
    expect(
      stateOf(
        reachable({
          available: update("0.2.1"),
          installing: {
            version: "0.2.1",
            startedAt: "2026-11-19T09:59:00.000Z",
            manual: false,
            stage: "pulling",
          },
        }),
      ),
    ).toEqual({ kind: "installing", version: "0.2.1", stage: "pulling", slow: false });
    // Mode off still shows what is new; "off" only when nothing is.
    const off = { mode: "off", automatic: false } as const;
    expect(stateOf(reachable({ ...off, available: update("0.2.1") }))).toMatchObject({
      kind: "available",
      update: update("0.2.1"),
    });
    expect(stateOf(reachable({ ...off, attention: update("0.3.0") }))).toEqual({
      kind: "attention",
      update: update("0.3.0"),
    });
    expect(stateOf(reachable(off))).toEqual({ kind: "off" });
  });

  it("shows a failure while the failed version is still offered", () => {
    const failed = update("0.2.1", { failed: "container web is unhealthy" });
    const last = {
      version: "0.2.1",
      result: "rolled-back" as const,
      message: "container web is unhealthy. 0.2.0 runs again.",
      finishedAt: "2026-11-19T09:00:00.000Z",
    };
    expect(stateOf(reachable({ available: failed, last }))).toEqual({
      kind: "failed",
      version: "0.2.1",
      message: "container web is unhealthy. 0.2.0 runs again.",
      update: failed,
    });
    // A newer version replaces the failed one.
    expect(stateOf(reachable({ available: update("0.2.2"), last }))).toMatchObject({ kind: "available" });
    // A failed attention version too.
    expect(
      stateOf(
        reachable({ attention: update("0.3.0", { failed: "x" }), last: { ...last, version: "0.3.0" } }),
      ),
    ).toMatchObject({ kind: "failed", version: "0.3.0" });
  });

  it("keeps showing the installation the page waits for, through the restart", () => {
    const waiting = startWaiting("0.2.1", reachable(), NOW - 60_000);
    expect(stateOf(reachable({ available: update("0.2.1") }), { waiting })).toEqual({
      kind: "installing",
      version: "0.2.1",
      stage: null,
      slow: false,
    });
    expect(
      buttonState({ response: undefined, waiting, checking: false, failing: true, now: NOW }),
    ).toMatchObject({ kind: "installing", stage: "restarting" });
    expect(
      buttonState({
        response: undefined,
        waiting,
        checking: false,
        failing: false,
        now: waiting.since + SLOW_AFTER_MS + 1,
      }),
    ).toMatchObject({ kind: "installing", slow: true });
  });
});

describe("installOutcome", () => {
  const before = reachable({
    available: update("0.2.1"),
    last: {
      version: "0.2.1",
      result: "failed",
      message: "pull failed",
      finishedAt: "2026-11-19T08:00:00.000Z",
    },
  });
  const waiting = startWaiting("0.2.1", before, NOW);
  const finished = (result: "installed" | "failed" | "rolled-back" | "accepted") => ({
    version: "0.2.1",
    result,
    message: null,
    finishedAt: "2026-11-19T10:01:00.000Z",
  });

  it("is done when the app runs the new version", () => {
    expect(installOutcome(waiting, reachable({}, "0.2.1"))).toBe("done");
  });

  it("ignores the result of an earlier attempt", () => {
    expect(installOutcome(waiting, before)).toBe("waiting");
  });

  it("fails with a failed or rolled-back result", () => {
    expect(installOutcome(waiting, reachable({ last: finished("failed") }))).toBe("failed");
    expect(installOutcome(waiting, reachable({ last: finished("rolled-back") }))).toBe("failed");
  });

  it("waits for the new app after installed or accepted", () => {
    expect(installOutcome(waiting, reachable({ last: finished("accepted") }))).toBe("waiting");
    expect(installOutcome({ ...waiting, outage: true }, reachable({ last: finished("accepted") }))).toBe(
      "done",
    );
    expect(installOutcome(waiting, reachable({ last: finished("installed") }, "sha256:0123456789ab"))).toBe(
      "done",
    );
  });

  it("trusts installed when the app has no version (development)", () => {
    const development = startWaiting("0.2.1", { ...before, app: { version: null } }, NOW);
    expect(installOutcome(development, reachable({ last: finished("installed") }, null))).toBe("done");
    expect(installOutcome(development, reachable({ last: finished("accepted") }, null))).toBe("waiting");
  });
});

describe("popover details", () => {
  it("tells when an update installs by itself", () => {
    expect(installsAt(update("0.2.1"), NOW)).toBeNull();
    expect(installsAt(update("0.2.1", { installsAt: "2026-11-21T03:00:00.000Z" }), NOW)).toEqual({
      at: "2026-11-21T03:00:00.000Z",
    });
    expect(installsAt(update("0.2.1", { installsAt: "2026-11-19T09:00:00.000Z" }), NOW)).toBe("next-check");
  });

  it("lists up to 8 notes and counts the rest", () => {
    const notes = Array.from({ length: 15 }, (_, index) => `Change ${index + 1}`);
    expect(noteSummary(update("0.3.0", { notes, changes: 23 }))).toEqual({
      notes: notes.slice(0, 8),
      more: 15,
    });
    expect(noteSummary(update("0.2.1", { notes: ["One", "Two"], changes: 2 }))).toEqual({
      notes: ["One", "Two"],
      more: 0,
    });
  });

  it("reads the cooldown and the window", () => {
    expect(parseCooldown("3d")).toEqual({ unit: "days", count: 3 });
    expect(parseCooldown("12h")).toEqual({ unit: "hours", count: 12 });
    expect(parseCooldown("30m")).toEqual({ unit: "minutes", count: 30 });
    expect(parseCooldown("86400")).toEqual({ unit: "days", count: 1 });
    expect(parseCooldown("90s")).toEqual({ unit: "minutes", count: 2 });
    expect(parseCooldown("0")).toBeNull();
    expect(parseCooldown(null)).toBeNull();
    expect(parseWindow("02:00-05:00")).toEqual({ from: "02:00", to: "05:00" });
    expect(parseWindow("nights")).toBeNull();
  });
});
