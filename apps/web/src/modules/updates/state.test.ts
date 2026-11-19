import { describe, expect, it } from "vitest";
import type { Update, UpdatesResponse, UpdaterStatus } from "@support-agent/shared/api/updates";
import type { Stage } from "./state";
import {
  adoptWaiting,
  afterInstallAnswer,
  buttonState,
  follow,
  installAction,
  installOutcome,
  installsAt,
  noteSummary,
  parseCooldown,
  parseWindow,
  RECONCILE_MS,
  SLOW_AFTER_MS,
  startWaiting,
  type Tracked,
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
  extra: { waiting?: Waiting; tracked?: Tracked; checking?: boolean; receivedAt?: number } = {},
) =>
  buttonState({
    response,
    receivedAt: extra.receivedAt ?? NOW,
    waiting: extra.waiting ?? null,
    tracked: extra.tracked ?? null,
    checking: extra.checking ?? false,
    failing: false,
    now: NOW,
  });

const installing = (version: string, stage: Stage = "pulling") => ({
  version,
  startedAt: "2026-11-19T09:59:00.000Z",
  manual: true,
  stage,
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
      attention: false,
    });
    // A newer version replaces the failed one.
    expect(stateOf(reachable({ available: update("0.2.2"), last }))).toMatchObject({ kind: "available" });
    // A failed attention version too.
    expect(
      stateOf(
        reachable({ attention: update("0.3.0", { failed: "x" }), last: { ...last, version: "0.3.0" } }),
      ),
    ).toMatchObject({ kind: "failed", version: "0.3.0", attention: true });
  });

  it("shows the failure this page followed from last, before the updater marks the offer", () => {
    const last = {
      version: "0.3.0",
      result: "failed" as const,
      message: "migration failed",
      finishedAt: "2026-11-19T09:58:00.000Z",
    };
    const response = reachable({ attention: update("0.3.0"), last });
    // Not followed here: the table's rule (the offer's `failed`) decides.
    expect(stateOf(response)).toMatchObject({ kind: "attention" });
    // Followed: shown with its message; trying again keeps the upgrade-steps confirmation.
    const tracked = { version: "0.3.0", finishedAt: last.finishedAt };
    expect(stateOf(response, { tracked })).toEqual({
      kind: "failed",
      version: "0.3.0",
      message: "migration failed",
      update: update("0.3.0"),
      attention: true,
    });
    // No longer offered: still shown, without anything to try again.
    expect(stateOf(reachable({ last }), { tracked })).toMatchObject({ kind: "failed", update: null });
    // A newer result replaces it.
    expect(
      stateOf(reachable({ last: { ...last, result: "installed", finishedAt: "2026-11-19T09:59:30.000Z" } }), {
        tracked,
      }),
    ).toEqual({ kind: "current" });
  });

  it("offers no install of an attention release that the deployment's tag does not reach", () => {
    const locked = status({
      mode: "platform",
      channelLocked: "The image tag 0.2 set where the app is deployed decides. Change it there.",
      available: update("0.2.1"),
      attention: update("0.3.0"),
    });
    expect(installAction(locked, true)).toBe("tag");
    expect(installAction(locked, false)).toBe("install");
    expect(installAction(status({ attention: update("0.3.0") }), true)).toBe("install");
    expect(installAction(status({ mode: "off", attention: update("0.3.0") }), true)).toBe("off");
  });

  it("keeps showing the installation the page waits for, through the restart", () => {
    const waiting = startWaiting("0.2.1", reachable(), NOW - 60_000);
    expect(stateOf(reachable({ available: update("0.2.1") }), { waiting })).toEqual({
      kind: "installing",
      version: "0.2.1",
      stage: null,
      slow: false,
    });
    const without = { response: undefined, receivedAt: 0, waiting, tracked: null, checking: false };
    expect(buttonState({ ...without, failing: true, now: NOW })).toMatchObject({
      kind: "installing",
      stage: "restarting",
    });
    expect(buttonState({ ...without, failing: false, now: waiting.since + SLOW_AFTER_MS + 1 })).toMatchObject(
      { kind: "installing", slow: true },
    );
  });

  it("keeps installing while the updater reports it, also when the app already runs the new version", () => {
    const waiting = { ...startWaiting("0.2.1", reachable(), NOW - 60_000), confirmed: true };
    expect(stateOf(reachable({ installing: installing("0.2.1", "starting") }, "0.2.1"), { waiting })).toEqual(
      { kind: "installing", version: "0.2.1", stage: "starting", slow: false },
    );
  });

  it("fails with a fresh result of the attempt, without the offer's failed", () => {
    const waiting = { ...startWaiting("0.2.1", reachable(), NOW - 60_000), confirmed: true };
    const last = {
      version: "0.2.1",
      result: "rolled-back" as const,
      message: "container web is unhealthy",
      finishedAt: "2026-11-19T09:59:50.000Z",
    };
    expect(stateOf(reachable({ available: update("0.2.1"), last }), { waiting })).toEqual({
      kind: "failed",
      version: "0.2.1",
      message: "container web is unhealthy",
      update: update("0.2.1"),
      attention: false,
    });
    // A result from before the attempt is older: still installing.
    const stale = { ...last, finishedAt: "2026-11-19T09:58:00.000Z" };
    expect(stateOf(reachable({ available: update("0.2.1"), last: stale }), { waiting })).toMatchObject({
      kind: "installing",
    });
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
  const waiting: Waiting = { ...startWaiting("0.2.1", before, NOW), confirmed: true };
  const finished = (result: "installed" | "failed" | "rolled-back" | "accepted") => ({
    version: "0.2.1",
    result,
    message: null,
    finishedAt: "2026-11-19T10:01:00.000Z",
  });
  /** The outcome of an answer received two minutes after the attempt started. */
  const outcome = (response: UpdatesResponse, attempt: Waiting = waiting, receivedAt = NOW + 120_000) =>
    installOutcome(follow(attempt, response, receivedAt), response, receivedAt, receivedAt);

  it("is done when nothing reports the installation any more and the app runs the new version", () => {
    expect(outcome(reachable({}, "0.2.1"))).toBe("done");
  });

  it("keeps waiting while the updater still installs the version the app already runs", () => {
    expect(outcome(reachable({ installing: installing("0.2.1", "starting") }, "0.2.1"))).toBe("waiting");
  });

  it("ignores answers and results from before the attempt", () => {
    expect(outcome(before)).toBe("waiting");
    const stale = reachable({ last: { ...finished("failed"), finishedAt: "2026-11-19T09:59:00.000Z" } });
    expect(outcome(stale)).toBe("waiting");
    expect(outcome(reachable({}, "0.2.1"), waiting, NOW - 1)).toBe("waiting");
  });

  it("fails with a failed or rolled-back result, also when the app answers with the version", () => {
    expect(outcome(reachable({ last: finished("failed") }))).toBe("failed");
    expect(outcome(reachable({ last: finished("rolled-back") }, "0.2.1"))).toBe("failed");
  });

  it("is done once installed; after accepted, once the new app answers", () => {
    expect(outcome(reachable({ last: finished("installed") }, "sha256:0123456789ab"))).toBe("done");
    expect(outcome(reachable({ last: finished("accepted") }))).toBe("waiting");
    expect(outcome(reachable({ last: finished("accepted") }, "0.2.1"))).toBe("done");
  });

  it("without an app version, takes installed, and accepted only after an outage", () => {
    const development = {
      ...startWaiting("0.2.1", { ...before, app: { version: null } }, NOW),
      confirmed: true,
    };
    expect(outcome(reachable({ last: finished("installed") }, null), development)).toBe("done");
    expect(outcome(reachable({ last: finished("accepted") }, null), development)).toBe("waiting");
    expect(outcome(reachable({ last: finished("accepted") }, null), { ...development, outage: true })).toBe(
      "done",
    );
  });
});

describe("the install answer", () => {
  const before = reachable({ available: update("0.2.1") });
  const attempt = startWaiting("0.2.1", before, NOW);
  const unreachable: UpdatesResponse = {
    app: { version: "0.2.0" },
    reachable: false,
    updater: null,
    error: "No update service answers at http://updater:8080.",
  };

  it("follows a 202, with the updater's start time", () => {
    const next = afterInstallAnswer(
      attempt,
      { httpStatus: 202, response: reachable({ installing: installing("0.2.1", "requested") }), error: null },
      NOW + 1_000,
    );
    expect(next).toEqual({
      waiting: { ...attempt, confirmed: true, startedAt: "2026-11-19T09:59:00.000Z" },
      error: null,
    });
  });

  it("keeps an ambiguous answer's attempt and reconciles it for 60 seconds", () => {
    for (const answer of [
      { httpStatus: 200, response: unreachable, error: null },
      { httpStatus: null, response: null, error: "Failed to fetch" },
      { httpStatus: 502, response: null, error: "Request failed (502)" },
    ]) {
      const next = afterInstallAnswer(attempt, answer, NOW + 10_000);
      expect(next.error).toBeNull();
      expect(next.waiting).toMatchObject({ version: "0.2.1", confirmed: false, reason: expect.any(String) });
    }
    const kept = afterInstallAnswer(
      attempt,
      { httpStatus: 200, response: unreachable, error: null },
      NOW,
    ).waiting!;
    expect(kept.reason).toBe("No update service answers at http://updater:8080.");
    const settle = (response: UpdatesResponse, at: number) =>
      installOutcome(follow(kept, response, at), response, at, at);
    // Nothing reports it yet: keep asking, then give up.
    expect(settle(before, NOW + 30_000)).toBe("waiting");
    expect(settle(unreachable, NOW + RECONCILE_MS)).toBe("not-started");
    expect(settle(before, NOW + RECONCILE_MS)).toBe("not-started");
    // The status reports it: follow it.
    const running = reachable({ available: update("0.2.1"), installing: installing("0.2.1") });
    expect(follow(kept, running, NOW + 30_000)).toMatchObject({ confirmed: true });
    expect(settle(running, NOW + RECONCILE_MS + 2_000)).toBe("waiting");
    // Or a fresh result of it.
    const failed = reachable({
      last: { version: "0.2.1", result: "failed", message: "x", finishedAt: "2026-11-19T10:00:20.000Z" },
    });
    expect(settle(failed, NOW + RECONCILE_MS + 2_000)).toBe("failed");
  });

  it("forgets the attempt after a refusal and shows why", () => {
    const refused = { ...before, error: "0.2.1 is not offered." };
    expect(
      afterInstallAnswer(
        attempt,
        { httpStatus: 409, response: refused, error: "0.2.1 is not offered." },
        NOW,
      ),
    ).toEqual({ waiting: null, error: "0.2.1 is not offered." });
    expect(
      afterInstallAnswer(attempt, { httpStatus: 403, response: null, error: "Admins only" }, NOW),
    ).toEqual({ waiting: null, error: "Admins only" });
  });

  it("follows the installation that a refusal reports instead", () => {
    const faster = {
      ...reachable({ installing: installing("0.2.2", "pulling") }),
      error: "An installation of 0.2.2 is running.",
    };
    const next = afterInstallAnswer(
      attempt,
      { httpStatus: 409, response: faster, error: "An installation of 0.2.2 is running." },
      NOW + 1_000,
    );
    expect(next).toEqual({ waiting: adoptWaiting(faster, NOW + 1_000), error: null });
    expect(next.waiting).toMatchObject({
      version: "0.2.2",
      confirmed: true,
      startedAt: "2026-11-19T09:59:00.000Z",
    });
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
