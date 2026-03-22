import * as cheerio from "cheerio";

export type ParsedPage = {
  title: string | null;
  text: string;
  links: string[];
  termCounts: Map<string, number>;
};

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
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim() || null;
  const bodyText = $("body").text();
  const text = bodyText.replace(/\s+/g, " ").trim();

  const links: string[] = [];
  $("a[href]").each((_, element) => {
    const href = $(element).attr("href");
    if (!href) {
      return;
    }
    const normalized = normalizeUrl(href, baseUrl);
    if (normalized) {
      links.push(normalized);
    }
  });

  const termCounts = tokenize(text);

  return {
    title,
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
