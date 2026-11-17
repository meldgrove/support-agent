/**
 * Slack "mrkdwn" from the Markdown the models write. Slack needs &, < and >
 * escaped in text, uses *bold* and _italic_, <url|label> links and no headings.
 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** URLs in a text, without trailing punctuation. */
function urlsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>"'`()[\]]+/gi)].map((match) =>
    match[0].replace(/[.,;:!?]+$/, ""),
  );
}

/** The URLs an answer may link to: the passages' own, and those in their texts and in the instructions. */
export function linkableUrls(
  sources: { url: string | null; text: string }[],
  instructions: string,
): string[] {
  const urls = sources.flatMap((source) => [...(source.url ? [source.url] : []), ...urlsIn(source.text)]);
  return [...urls, ...urlsIn(instructions)];
}

/** Undoes HTML escaping of &, < and >, however often it was applied (Slack's, or a passage's own). */
function unescapeHtml(text: string): string {
  let result = text;
  for (let previous = ""; previous !== result;) {
    previous = result;
    result = result.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  return result;
}

/** A URL as compared with the linkable ones: unescaped, without trailing slashes. */
const linkKey = (url: string) => unescapeHtml(url).replace(/\/+$/, "");

function convertInline(text: string, linkable: ReadonlySet<string>): string {
  let result = escapeMrkdwn(text);
  // Links first, so their labels keep any emphasis. Only URLs from the
  // passages or the instructions become links; any other link the model
  // writes (made up, or asked for in a message) keeps only its label.
  result = result.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    const target = unescapeHtml(url);
    return linkable.has(linkKey(target)) ? `<${escapeMrkdwn(target)}|${label.replace(/\|/g, "/")}>` : label;
  });
  const BOLD = "\u0001";
  result = result.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${BOLD}`).replace(/__(.+?)__/g, `${BOLD}$1${BOLD}`);
  result = result.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1_$2_");
  result = result.replaceAll(BOLD, "*");
  result = result.replace(/~~(.+?)~~/g, "~$1~");
  return result;
}

/** Slack mrkdwn from the model's Markdown; links only to `linkable` URLs (see `linkableUrls`). */
export function markdownToMrkdwn(markdown: string, linkable: Iterable<string>): string {
  const allowed = new Set([...linkable].map(linkKey));
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
      output.push(`*${convertInline(heading[1]!.replace(/\*\*/g, ""), allowed)}*`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      output.push(`${bullet[1]}• ${convertInline(bullet[2]!, allowed)}`);
      continue;
    }
    // Inline code keeps its content unchanged.
    const parts = line.split(/(`[^`]+`)/g);
    output.push(
      parts
        .map((part) =>
          part.startsWith("`") && part.endsWith("`") && part.length > 1
            ? escapeMrkdwn(part)
            : convertInline(part, allowed),
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
