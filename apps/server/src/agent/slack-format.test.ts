import { describe, expect, it } from "vitest";
import { alertText, cleanSlackText, linkableUrls, markdownToMrkdwn, sourcesLine } from "./slack-format";

describe("markdownToMrkdwn", () => {
  it("converts emphasis, links, headings and lists", () => {
    const markdown = [
      "## Reset your password",
      "Open **Settings** and choose *Security*.",
      "- Go to [the portal](https://it.example.org/reset)",
      "1. Done",
    ].join("\n");
    expect(markdownToMrkdwn(markdown, ["https://it.example.org/reset"])).toBe(
      [
        "*Reset your password*",
        "Open *Settings* and choose _Security_.",
        "• Go to <https://it.example.org/reset|the portal>",
        "1. Done",
      ].join("\n"),
    );
  });

  it("escapes Slack control characters and keeps code unchanged", () => {
    expect(markdownToMrkdwn("Use a < b & c > d and `**raw**`", [])).toBe(
      "Use a &lt; b &amp; c &gt; d and `**raw**`",
    );
    expect(markdownToMrkdwn("```\n**x**\n```", [])).toBe("```\n**x**\n```");
  });

  it("does not turn non-http links into Slack links", () => {
    expect(markdownToMrkdwn("[x](javascript:alert(1))", [])).toBe("[x](javascript:alert(1))");
  });

  it("keeps only links to linkable URLs; other links become their label", () => {
    expect(
      markdownToMrkdwn(
        "Open [the form](https://it.example.org/form/?a=1&b=2) or [this](https://x.example/)",
        ["https://it.example.org/form?a=1&b=2"],
      ),
    ).toBe("Open <https://it.example.org/form?a=1&amp;b=2|the form> or this");
  });

  it("compares URLs without their HTML escaping", () => {
    expect(
      markdownToMrkdwn("[portal](https://example.org/?a=1&amp;b=2)", ["https://example.org/?a=1&b=2"]),
    ).toBe("<https://example.org/?a=1&amp;b=2|portal>");
    expect(
      markdownToMrkdwn("[portal](https://example.org/?a=1&b=2)", ["https://example.org/?a=1&amp;b=2"]),
    ).toBe("<https://example.org/?a=1&amp;amp;b=2|portal>");
  });
  it("prefers exact URLs and never guesses between different trusted targets", () => {
    const url = "https://example.org/guide?next=/home";
    const other = "https://example.org/guide/?next=/home";
    const withSlashInQuery = "https://example.org/guide?next=/home/";
    expect(markdownToMrkdwn(`[guide](${url})`, [url, other, withSlashInQuery])).toBe(`<${url}|guide>`);
    expect(markdownToMrkdwn("[guide](https://example.org/guide//?next=/home)", [url, other])).toBe("guide");
    expect(markdownToMrkdwn(`[guide](${withSlashInQuery})`, [url])).toBe("guide");
  });

  it("keeps distinct approved query strings even when one resembles HTML escaping", () => {
    const literal = "https://example.org/guide?a=1&amp;b=2";
    const decoded = "https://example.org/guide?a=1&b=2";
    expect(markdownToMrkdwn(`[guide](${literal})`, [literal, decoded])).toBe(
      "<https://example.org/guide?a=1&amp;amp;b=2|guide>",
    );
    expect(markdownToMrkdwn(`[guide](${decoded})`, [literal, decoded])).toBe(
      "<https://example.org/guide?a=1&amp;b=2|guide>",
    );
    expect(markdownToMrkdwn("[guide](https://example.org/guide/?a=1&b=2)", [literal, decoded])).toBe("guide");
  });

  it("rejects a fallback shared by URLs escaped to different depths", () => {
    const decoded = "https://example.org/guide?a=1&b=2";
    const doubleEscaped = "https://example.org/guide?a=1&amp;amp;b=2";
    const candidate = "https://example.org/guide?a=1&amp;b=2";
    expect(markdownToMrkdwn(`[guide](${candidate})`, [decoded, doubleEscaped])).toBe("guide");
  });

  it("preserves the trusted target exactly when formatting an inline link", () => {
    const url = "https://it.example.org/a__b__c";
    expect(markdownToMrkdwn("[**guide**](" + url + ")", [url])).toBe("<" + url + "|*guide*>");
  });
});

describe("linkableUrls", () => {
  it("collects the passages' URLs, URLs in their texts and in the instructions", () => {
    expect(
      linkableUrls(
        [
          {
            url: "https://it.example.org/a",
            text: "See https://wiki.example.org/vpn. Or (https://it.example.org/b)",
          },
          { url: null, text: "No links." },
        ],
        "Tickets: https://help.example.org/new, please.",
      ),
    ).toEqual([
      "https://it.example.org/a",
      "https://wiki.example.org/vpn",
      "https://it.example.org/b",
      "https://help.example.org/new",
    ]);
  });

  it("leaves Markdown and Slack markup around a URL out", () => {
    expect(
      linkableUrls([], "See **https://help.example.org/new** or <https://wiki.example.org/vpn|the wiki>."),
    ).toEqual(["https://help.example.org/new", "https://wiki.example.org/vpn"]);
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
  it("only renders well-formed HTTP URLs as citation targets", () => {
    expect(
      sourcesLine([
        { title: "Malformed", url: "https://example.org/a|label" },
        { title: "Malformed", url: "https://example.org/a<text>" },
        { title: "Guide", url: "https://example.org/a?x=1&y=2" },
      ]),
    ).toBe(":page_facing_up: <https://example.org/a?x=1&amp;y=2|Guide>");
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

describe("alertText", () => {
  it("keeps the agent name and the error plain text", () => {
    expect(alertText("<!channel> IT", "C123", "Search failed: <@U1> & co")).toBe(
      ":warning: *&lt;!channel&gt; IT* could not answer in <#C123>: Search failed: &lt;@U1&gt; &amp; co",
    );
  });
});
