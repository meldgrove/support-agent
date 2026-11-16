import { describe, expect, it } from "vitest";
import { cleanSlackText, markdownToMrkdwn, sourcesLine } from "./slack-format";

describe("markdownToMrkdwn", () => {
  it("converts emphasis, links, headings and lists", () => {
    const markdown = [
      "## Reset your password",
      "Open **Settings** and choose *Security*.",
      "- Go to [the portal](https://it.example.org/reset)",
      "1. Done",
    ].join("\n");
    expect(markdownToMrkdwn(markdown)).toBe(
      [
        "*Reset your password*",
        "Open *Settings* and choose _Security_.",
        "• Go to <https://it.example.org/reset|the portal>",
        "1. Done",
      ].join("\n"),
    );
  });

  it("escapes Slack control characters and keeps code unchanged", () => {
    expect(markdownToMrkdwn("Use a < b & c > d and `**raw**`")).toBe(
      "Use a &lt; b &amp; c &gt; d and `**raw**`",
    );
    expect(markdownToMrkdwn("```\n**x**\n```")).toBe("```\n**x**\n```");
  });

  it("does not turn non-http links into Slack links", () => {
    expect(markdownToMrkdwn("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
  });
});

describe("sourcesLine", () => {
  it("links each URL once and skips sources without one", () => {
    expect(
      sourcesLine([
        { title: "Passwords | IT", url: "https://it.example.org/a" },
        { title: "Again", url: "https://it.example.org/a" },
        { title: "No link", url: null },
        { title: "Wi-Fi <guest>", url: "https://it.example.org/b" },
      ]),
    ).toBe(
      ":page_facing_up: <https://it.example.org/a|Passwords   IT> · <https://it.example.org/b|Wi-Fi &lt;guest&gt;>",
    );
    expect(sourcesLine([{ title: "x", url: null }])).toBeNull();
  });
});

describe("cleanSlackText", () => {
  it("removes the bot mention and Slack markup", () => {
    expect(
      cleanSlackText(
        "<@UBOT> how do I join <#C123|general>? See <https://x.example.org|this> &amp; <!here>",
        "UBOT",
      ),
    ).toBe("how do I join #general? See this (https://x.example.org) & @here");
  });
});
