export type ParsedPage = {
  title: string | null;
  text: string;
  links: string[];
  termCounts: Map<string, number>;
};

const BLOCK_TAG_PATTERN = /<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi;
const COMMENT_PATTERN = /<!--[\s\S]*?-->/g;
const TAG_PATTERN = /<[^>]+>/g;
const TITLE_PATTERN = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const BODY_PATTERN = /<body\b[^>]*>([\s\S]*?)<\/body>/i;
const HREF_PATTERN = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

function decodeHtmlEntities(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === "amp") {
      return "&";
    }
    if (normalized === "lt") {
      return "<";
    }
    if (normalized === "gt") {
      return ">";
    }
    if (normalized === "quot") {
      return "\"";
    }
    if (normalized === "apos" || normalized === "#39") {
      return "'";
    }
    if (normalized === "nbsp") {
      return " ";
    }
    if (normalized.startsWith("#x")) {
      const codePoint = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
    }
    if (normalized.startsWith("#")) {
      const codePoint = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : "";
    }
    return " ";
  });
}

function stripMarkup(value: string) {
  return value
    .replace(COMMENT_PATTERN, " ")
    .replace(BLOCK_TAG_PATTERN, " ")
    .replace(TAG_PATTERN, " ");
}

function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeUrl(rawUrl: string, baseUrl?: string): string | null {
  try {
    const url = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function parseHtml(html: string, baseUrl: string): ParsedPage {
  const titleMatch = html.match(TITLE_PATTERN);
  const title = titleMatch
    ? collapseWhitespace(decodeHtmlEntities(stripMarkup(titleMatch[1])))
    : null;

  const bodyHtml = html.match(BODY_PATTERN)?.[1] ?? html;
  const text = collapseWhitespace(decodeHtmlEntities(stripMarkup(bodyHtml)));

  const links: string[] = [];
  for (const match of bodyHtml.matchAll(HREF_PATTERN)) {
    const href = match[1] ?? match[2] ?? match[3];
    if (!href) {
      continue;
    }
    const normalized = normalizeUrl(href, baseUrl);
    if (normalized) {
      links.push(normalized);
    }
  }

  const termCounts = tokenize(text);

  return {
    title: title || null,
    text,
    links,
    termCounts
  };
}

export function tokenize(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const tokens = text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? [];
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}
