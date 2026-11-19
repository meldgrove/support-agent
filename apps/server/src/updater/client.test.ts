import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdaterStatus } from "@support-agent/shared/api/updates";
import { resetConfigForTests } from "../config";
import { callUpdater, type UpdaterCall } from "./client";

const STATUS: UpdaterStatus = {
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
  checkedAt: "2026-11-19T08:00:00.000Z",
  error: null,
  automatic: true,
  cooldown: "3d",
  window: null,
  timezone: "UTC",
};

const fetchMock = vi.fn<typeof fetch>();
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  process.env.UPDATER_URL = "http://updater.test:8080/";
  resetConfigForTests();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.UPDATER_URL;
  resetConfigForTests();
});

describe("callUpdater", () => {
  it("returns the status and sends only the given body", async () => {
    fetchMock.mockResolvedValueOnce(json(202, STATUS));
    expect(await callUpdater("install", { version: "0.2.1" })).toEqual({
      kind: "ok",
      httpStatus: 202,
      status: STATUS,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://updater.test:8080/v1/install");
    expect(init).toMatchObject({ method: "POST", body: '{"version":"0.2.1"}', redirect: "error" });
  });

  it("passes on the updater's reason of an error answer", async () => {
    fetchMock.mockResolvedValueOnce(json(409, { error: "0.2.1 is being installed." }));
    expect(await callUpdater("install", { version: "0.2.1" })).toEqual({
      kind: "refused",
      httpStatus: 409,
      error: "0.2.1 is being installed.",
    });
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 500 }));
    expect(await callUpdater("check")).toEqual({
      kind: "refused",
      httpStatus: 500,
      error: "The update service refused the request (HTTP 500).",
    });
  });

  it("counts a connection failure or an answer that is no status as unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await callUpdater("status")).toEqual({
      kind: "unreachable",
      error: "No update service answers at http://updater.test:8080.",
    });
    fetchMock.mockResolvedValueOnce(new Response("<html>proxy</html>", { status: 200 }));
    expect(await callUpdater("status")).toMatchObject({ kind: "unreachable" });
    fetchMock.mockResolvedValueOnce(json(200, { ...STATUS, mode: "sideways" }));
    expect(await callUpdater("status")).toMatchObject({ kind: "unreachable" });
  });

  it("makes no call when UPDATER_URL is empty", async () => {
    process.env.UPDATER_URL = "";
    resetConfigForTests();
    expect(await callUpdater("status")).toEqual({
      kind: "unreachable",
      error: "The update button is off on this server (UPDATER_URL).",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each<[UpdaterCall, number]>([
    ["status", 3_000],
    ["check", 35_000],
    ["install", 10_000],
    ["channel", 35_000],
  ])("gives up on %s after %i ms", async (call, timeoutMs) => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))),
        ),
    );
    let settled = false;
    const pending = callUpdater(call).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({
      kind: "unreachable",
      error: `The update service did not answer within ${timeoutMs / 1000} seconds.`,
    });
  });
});
