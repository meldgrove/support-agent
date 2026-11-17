import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebClient } from "@slack/web-api";
import { isSlackFileUrl, webSlackPort } from "./slack-port";

describe("isSlackFileUrl", () => {
  it("accepts Slack's own https hosts only", () => {
    expect(isSlackFileUrl("https://files.slack.com/files-pri/T1-F1/download/a.png")).toBe(true);
    expect(isSlackFileUrl("https://example.slack.com/files/U1/F1/a.png")).toBe(true);
    expect(isSlackFileUrl("http://files.slack.com/files-pri/T1-F1/a.png")).toBe(false);
    expect(isSlackFileUrl("https://files.slack.com.attacker.example/a.png")).toBe(false);
    expect(isSlackFileUrl("https://files.slack.com@attacker.example/a.png")).toBe(false);
    expect(isSlackFileUrl("https://notslack.com/a.png")).toBe(false);
    expect(isSlackFileUrl("not a url")).toBe(false);
  });
});

describe("downloadImage", () => {
  const fetchMock = vi.fn<typeof fetch>();
  const port = webSlackPort({} as WebClient, "xoxb-test-token");
  const image = { mimetype: "image/png", size: 4 };

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends the bot token to Slack's file host", async () => {
    fetchMock.mockResolvedValueOnce(new Response("abcd", { headers: { "content-type": "image/png" } }));
    const result = await port.downloadImage({
      ...image,
      url_private_download: "https://files.slack.com/files-pri/T1-F1/download/a.png",
    });
    expect(result).toEqual({ mediaType: "image/png", data: Buffer.from("abcd").toString("base64") });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://files.slack.com/files-pri/T1-F1/download/a.png");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer xoxb-test-token");
  });

  it("does not fetch files hosted outside Slack", async () => {
    expect(await port.downloadImage({ ...image, url_private: "https://attacker.example/a.png" })).toBeNull();
    expect(
      await port.downloadImage({
        ...image,
        is_external: true,
        url_private: "https://files.slack.com/files-pri/T1-F1/a.png",
      }),
    ).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops reading an image larger than 5 MB", async () => {
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(1024 * 1024)),
    });
    fetchMock.mockResolvedValueOnce(new Response(endless, { headers: { "content-type": "image/png" } }));
    const result = await port.downloadImage({
      ...image,
      url_private: "https://files.slack.com/files-pri/T1-F1/a.png",
    });
    expect(result).toBeNull();
  });
});
