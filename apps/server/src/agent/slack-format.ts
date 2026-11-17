/**
 * Slack "mrkdwn" from the Markdown the models write. Slack needs &, < and >
 * escaped in text, uses *bold* and _italic_, <url|label> links and no headings.
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function convertInline(text: string): string {
  let result = escapeMrkdwn(text);
  // Links first, so their labels keep any emphasis.
  result = result.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    return `<${url}|${label.replace(/\|/g, "/")}>`;
  });
  const BOLD = "\u0001";
  result = result.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${BOLD}`).replace(/__(.+?)__/g, `${BOLD}$1${BOLD}`);
  result = result.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1_$2_");
  result = result.replaceAll(BOLD, "*");
  result = result.replace(/~~(.+?)~~/g, "~$1~");
  return result;
}

export function markdownToMrkdwn(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];
  let inCode = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      output.push("```");
      continue;
    }
    if (inCode) {
      output.push(escapeMrkdwn(line));
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      output.push(`*${convertInline(heading[1]!.replace(/\*\*/g, ""))}*`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      output.push(`${bullet[1]}• ${convertInline(bullet[2]!)}`);
      continue;
    }
    // Inline code keeps its content unchanged.
    const parts = line.split(/(`[^`]+`)/g);
    output.push(
      parts
        .map((part) =>
          part.startsWith("`") && part.endsWith("`") && part.length > 1
            ? escapeMrkdwn(part)
            : convertInline(part),
        )
        .join(""),
    );
  }
  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The alert channel's message about an agent that could not answer; name and error stay plain text. */
export function alertText(agentName: string, channelId: string, error: string): string {
  return `:warning: *${escapeMrkdwn(agentName)}* could not answer in <#${channelId}>: ${escapeMrkdwn(error)}`;
}

/** One line with links to the cited sources, e.g. ":page_facing_up: <url|Title> · <url|Title>". */
export function sourcesLine(sources: { title: string; url: string | null }[]): string | null {
  const seen = new Set<string>();
  const links: string[] = [];
  for (const source of sources) {
    if (!source.url || seen.has(source.url)) continue;
    seen.add(source.url);
    const label = escapeMrkdwn(source.title.replace(/[|\n]/g, " ").trim() || source.url);
    links.push(`<${source.url}|${label}>`);
  }
  return links.length > 0 ? `:page_facing_up: ${links.join(" · ")}` : null;
}

/** Removes the bot's mention and Slack's markup of mentions and links from a question. */
export function cleanSlackText(text: string, botUserId: string | null): string {
  let result = text;
  if (botUserId) result = result.replaceAll(`<@${botUserId}>`, "");
  return result
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)>/g, "@$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}
