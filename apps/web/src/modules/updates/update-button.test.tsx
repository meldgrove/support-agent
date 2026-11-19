import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { focusManager, onlineManager } from "@tanstack/react-query";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdatesResponse, UpdaterStatus } from "@support-agent/shared/api/updates";
import { TooltipProvider } from "@/components/ui/tooltip";
import { renderWithProviders, stubFetch } from "@/test-utils";
import { RECONCILE_MS, startWaiting, type Waiting } from "./state";
import { UpdateButton } from "./update-button";

vi.mock("@/hooks/use-me", () => ({ useIsAdmin: () => true }));
vi.mock("@/lib/auth-config", () => ({ useAuthConfig: () => ({ appName: "Support Agent" }) }));

/** Mode off: Updater 0.2 refuses every install. */
function off(overrides: Partial<UpdaterStatus> = {}): UpdatesResponse {
  return {
    app: { version: "0.2.0" },
    reachable: true,
    updater: {
      updater: "0.2.0",
      mode: "off",
      channel: "stable",
      channelLocked: null,
      installed: "0.2.0",
      available: {
        version: "0.2.1",
        preview: false,
        publishedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        url: "https://github.com/meldgrove/support-agent/releases/tag/v0.2.1",
        notes: ["Answer in threads"],
        changes: 1,
        installsAt: null,
        failed: null,
      },
      attention: null,
      installing: null,
      last: null,
      checking: false,
      checkedAt: new Date().toISOString(),
      error: null,
      automatic: false,
      cooldown: "3d",
      window: null,
      timezone: "UTC",
      ...overrides,
    },
    error: null,
  };
}

function renderButton(locale: "en" | "de" = "en") {
  return renderWithProviders(
    <TooltipProvider>
      <UpdateButton />
    </TooltipProvider>,
    { locale },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

const STORAGE_KEY = "support-agent.updates.installing";
const stored = () => JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "null") as Waiting | null;

/** An attempt from before a reload, still unconfirmed after an ambiguous install answer. */
function storeAttempt(extra: Partial<Waiting> = {}) {
  const attempt = { ...startWaiting("0.2.1", undefined, Date.now()), reason: "Failed to fetch", ...extra };
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(attempt));
  return attempt;
}

/** Fetch answers from a function of the request; returns the mock to count requests. */
function answerFetch(reply: (url: string) => Response | Error) {
  const mock = vi.fn(async (url: string) => {
    const answer = reply(url);
    if (answer instanceof Error) throw answer;
    return answer;
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("UpdateButton while automatic updates are off", () => {
  it("shows a new release without installing it", async () => {
    stubFetch({ body: off() });
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Update available · 0.2.1" }));
    const popover = await screen.findByRole("dialog");
    expect(popover).toHaveTextContent("Answer in threads");
    expect(within(popover).getByRole("link", { name: /Release notes/ })).toBeInTheDocument();
    expect(within(popover).queryByRole("button", { name: /Install now/ })).not.toBeInTheDocument();
    expect(popover).toHaveTextContent(
      "Automatic updates are off on this server, so it cannot install from here. See the deployment guide.",
    );
    expect(within(popover).getByRole("link", { name: "deployment guide" })).toHaveAttribute(
      "href",
      expect.stringContaining("docs/deployment.md"),
    );
  });

  it("says so in German", async () => {
    stubFetch({ body: off() });
    renderButton("de");

    await userEvent.click(await screen.findByRole("button", { name: "Update verfügbar · 0.2.1" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Automatische Updates sind auf diesem Server aus, daher kann es hier nicht installiert werden. Siehe Anleitung zum Deployment.",
    );
  });

  it("is off when nothing is new", async () => {
    stubFetch({ body: off({ available: null }) });
    renderButton();

    expect(
      await screen.findByRole("button", { name: "Automatic updates are off on this server" }),
    ).toBeInTheDocument();
  });
});

/** Host mode with an update and a release that needs upgrade steps. */
function host(overrides: Partial<UpdaterStatus> = {}): UpdatesResponse {
  return off({ mode: "host", automatic: true, ...overrides });
}

const attention = {
  version: "0.3.0",
  preview: false,
  publishedAt: null,
  url: "https://github.com/meldgrove/support-agent/releases/tag/v0.3.0",
  notes: [],
  changes: 0,
  installsAt: null,
  failed: null,
};

async function confirmInstall() {
  await userEvent.click(await screen.findByRole("button", { name: "Update available · 0.2.1" }));
  await userEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: /Install now/ }),
  );
  await userEvent.click(await screen.findByRole("button", { name: "Install" }));
}

describe("UpdateButton installs", () => {
  it("offers no Install anyway… when the deployment's tag decides", async () => {
    stubFetch({
      body: host({
        mode: "platform",
        channelLocked: "The image tag 0.2 set where the app is deployed decides. Change it there.",
        attention,
      }),
    });
    renderButton();

    await userEvent.click(await screen.findByRole("button", { name: "Update available · 0.2.1" }));
    const popover = await screen.findByRole("dialog");
    expect(within(popover).getByRole("button", { name: /Install now/ })).toBeInTheDocument();
    expect(within(popover).queryByRole("button", { name: /Install anyway/ })).not.toBeInTheDocument();
    expect(popover).toHaveTextContent(
      "The image tag set where Support Agent is deployed does not reach 0.3.0. Take the upgrade steps, then change the tag there.",
    );
  });

  it("keeps the attempt when the answer is ambiguous", async () => {
    const unreachable = { app: { version: "0.2.0" }, reachable: false, updater: null, error: "No answer" };
    const fetch = stubFetch({ body: host() }, { body: unreachable });
    renderButton();

    await confirmInstall();
    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/v1/updates/install");
    expect(JSON.parse(sessionStorage.getItem("support-agent.updates.installing") ?? "null")).toMatchObject({
      version: "0.2.1",
      confirmed: false,
      reason: "No answer",
    });
  });

  it("forgets the attempt after a refusal", async () => {
    const refused = { ...host(), error: "0.2.1 is not offered." };
    stubFetch({ body: host() }, { status: 409, body: refused });
    renderButton();

    await confirmInstall();
    expect(await screen.findByRole("button", { name: "Update available · 0.2.1" })).toBeInTheDocument();
    expect(sessionStorage.getItem("support-agent.updates.installing")).toBeNull();
  });

  it("follows an accepted installation", async () => {
    const running = host({
      installing: { version: "0.2.1", startedAt: new Date().toISOString(), manual: true, stage: "requested" },
    });
    stubFetch({ body: host() }, { status: 202, body: running });
    renderButton();

    await confirmInstall();
    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem("support-agent.updates.installing") ?? "null")).toMatchObject({
      version: "0.2.1",
      confirmed: true,
    });
  });
});

describe("UpdateButton reconciles an unconfirmed attempt for 60 seconds", () => {
  it("gives up at the deadline while every status request fails: could not be confirmed", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(toast, "error");
    storeAttempt();
    const fetch = answerFetch(() => new TypeError("Failed to fetch"));
    renderButton();

    await advance(RECONCILE_MS - 1_000);
    // Polled every 2 seconds, every request failed, still waiting.
    expect(fetch.mock.calls.length).toBeGreaterThan(20);
    expect(stored()).toMatchObject({ version: "0.2.1", confirmed: false, outage: true });
    expect(error).not.toHaveBeenCalled();

    await advance(1_000);
    expect(error).toHaveBeenCalledWith("The installation could not be confirmed", {
      description: "Failed to fetch",
    });
    expect(stored()).toBeNull();
    // Back to normal polling.
    const calls = fetch.mock.calls.length;
    await advance(60_000);
    expect(fetch.mock.calls.length).toBe(calls);
  });

  it("gives up at the deadline while a request hangs", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(toast, "error");
    storeAttempt();
    // The first request never answers.
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
          ),
      ),
    );
    renderButton();

    await advance(RECONCILE_MS);
    expect(error).toHaveBeenCalledWith("The installation could not be confirmed", {
      description: expect.stringContaining("did not answer"),
    });
    expect(stored()).toBeNull();
  });

  it("gives up at the deadline when no status request could run (offline)", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(toast, "error");
    storeAttempt();
    const fetch = answerFetch(() => json(host()));
    onlineManager.setOnline(false);
    try {
      renderButton();
      await advance(RECONCILE_MS);
      // The query waits for the network: no request ran, the timer ended the attempt anyway.
      expect(fetch).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith("The installation could not be confirmed", {
        description: "Failed to fetch",
      });
      expect(stored()).toBeNull();
    } finally {
      act(() => onlineManager.setOnline(true));
    }
  });

  it("says that the installation did not start when the updater answered without it", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(toast, "error");
    storeAttempt({ reason: "The updater is busy. Try again in a minute." });
    answerFetch(() => json(host()));
    renderButton();

    await advance(RECONCILE_MS);
    expect(error).toHaveBeenCalledWith("The installation did not start", {
      description: "The updater is busy. Try again in a minute.",
    });
    expect(stored()).toBeNull();
  });

  it("follows the attempt once the status reports it, past the deadline", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(toast, "error");
    storeAttempt();
    const running = host({
      installing: { version: "0.2.1", startedAt: new Date().toISOString(), manual: true, stage: "pulling" },
    });
    let polls = 0;
    answerFetch(() => (++polls < 5 ? new TypeError("Failed to fetch") : json(running)));
    renderButton();

    await advance(RECONCILE_MS + 10_000);
    expect(error).not.toHaveBeenCalled();
    expect(stored()).toMatchObject({ version: "0.2.1", confirmed: true });
  });
});

describe("UpdateButton after the session ended", () => {
  it("stops every automatic status request on a sign-in page and keeps the attempt", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(toast, "error");
    storeAttempt();
    const fetch = answerFetch(
      () =>
        new Response("<!doctype html><title>Sign in</title>", { headers: { "content-type": "text/html" } }),
    );
    renderButton();

    await advance(RECONCILE_MS + 30_000);
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });
    await advance(10_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(stored()).toMatchObject({ version: "0.2.1", confirmed: false });
    expect(error).not.toHaveBeenCalled();
    act(() => focusManager.setFocused(undefined));
  });
});

describe("UpdateButton install answers through the app", () => {
  it("follows a 202 whose body breaks off", async () => {
    answerFetch((url) =>
      url === "/api/v1/updates/install"
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new TypeError("network error"));
              },
            }),
            { status: 202, headers: { "content-type": "application/json" } },
          )
        : json(host()),
    );
    renderButton();

    await confirmInstall();
    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    expect(stored()).toMatchObject({ version: "0.2.1", confirmed: true });
  });

  it("keeps the attempt when the updater answers 503", async () => {
    const busy = { ...host(), error: "The updater is busy. Try again in a minute." };
    stubFetch({ body: host() }, { status: 503, body: busy });
    renderButton();

    await confirmInstall();
    expect(await screen.findByRole("button", { name: "Installing 0.2.1…" })).toBeInTheDocument();
    expect(stored()).toMatchObject({
      version: "0.2.1",
      confirmed: false,
      reason: "The updater is busy. Try again in a minute.",
    });
  });
});

describe("UpdateButton after a failed installation", () => {
  it("shows a newer offer with the failure as a line in it", async () => {
    const attempt = storeAttempt({ confirmed: true, since: Date.now() - 10_000 });
    const failed = host({
      available: { ...host().updater!.available!, version: "0.2.2", notes: ["Fix the rollback"] },
      last: {
        version: "0.2.1",
        result: "rolled-back",
        message: "container web is unhealthy",
        finishedAt: new Date(attempt.since + 5_000).toISOString(),
      },
    });
    stubFetch({ body: failed }, { body: failed });
    renderButton();

    const popover = await screen.findByRole("dialog");
    expect(popover).toHaveTextContent("0.2.1 failed: container web is unhealthy");
    expect(popover).toHaveTextContent("Fix the rollback");
    expect(within(popover).getByRole("button", { name: /Install now/ })).toBeInTheDocument();
    expect(stored()).toBeNull();
  });
});
