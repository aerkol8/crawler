import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Database } from "sqlite";
import sqlite3 from "sqlite3";
import { tokenize } from "../crawler/parser";

export type RawStorageEntry = {
  word: string;
  url: string;
  origin: string;
  depth: number;
  frequency: number;
};

export type RawStorageSearchResult = {
  relevant_url: string;
  origin_url: string;
  depth: number;
  matched_frequency: number;
  relevance_score: number;
};

let cachedPath = "";
let cachedMtimeMs = -1;
let cachedEntries: RawStorageEntry[] = [];

function parseRawStorageLine(line: string): RawStorageEntry | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) {
    return null;
  }

  const [word, url, origin, depth, frequency] = parts;
  const parsedDepth = Number.parseInt(depth, 10);
  const parsedFrequency = Number.parseInt(frequency, 10);

  if (Number.isNaN(parsedDepth) || Number.isNaN(parsedFrequency)) {
    return null;
  }

  return {
    word,
    url,
    origin,
    depth: parsedDepth,
    frequency: parsedFrequency
  };
}

async function loadRawStorageEntries(storagePath: string) {
  const fileStats = await stat(storagePath);
  if (cachedPath === storagePath && cachedMtimeMs === fileStats.mtimeMs) {
    return cachedEntries;
  }

  const contents = await readFile(storagePath, "utf8");
  const entries = contents
    .split(/\r?\n/)
    .map((line) => parseRawStorageLine(line))
    .filter((entry): entry is RawStorageEntry => entry !== null);

  cachedPath = storagePath;
  cachedMtimeMs = fileStats.mtimeMs;
  cachedEntries = entries;

  return entries;
}

export function computeRelevanceScore(frequency: number, depth: number, exactMatch: boolean) {
  const exactMatchBonus = exactMatch ? 1000 : 0;
  return (frequency * 10) + exactMatchBonus - (depth * 5);
}

export async function searchRawStorage(storagePath: string, query: string): Promise<RawStorageSearchResult[]> {
  const queryTerms = Array.from(tokenize(query).keys());
  if (queryTerms.length === 0) {
    return [];
  }

  const entries = await loadRawStorageEntries(storagePath);
  const grouped = new Map<string, {
    relevant_url: string;
    origin_url: string;
    depth: number;
    matched_frequency: number;
    matched_terms: Set<string>;
  }>();

  for (const entry of entries) {
    if (!queryTerms.includes(entry.word)) {
      continue;
    }

    const key = `${entry.url}\n${entry.origin}\n${entry.depth}`;
    let group = grouped.get(key);
    if (!group) {
      group = {
        relevant_url: entry.url,
        origin_url: entry.origin,
        depth: entry.depth,
        matched_frequency: 0,
        matched_terms: new Set<string>()
      };
      grouped.set(key, group);
    }

    group.matched_frequency += entry.frequency;
    group.matched_terms.add(entry.word);
  }

  return Array.from(grouped.values())
    .map((group) => ({
      relevant_url: group.relevant_url,
      origin_url: group.origin_url,
      depth: group.depth,
      matched_frequency: group.matched_frequency,
      relevance_score: computeRelevanceScore(
        group.matched_frequency,
        group.depth,
        group.matched_terms.size === queryTerms.length
      )
    }))
    .sort((left, right) => {
      if (right.relevance_score !== left.relevance_score) {
        return right.relevance_score - left.relevance_score;
      }
      if (right.matched_frequency !== left.matched_frequency) {
        return right.matched_frequency - left.matched_frequency;
      }
      return left.relevant_url.localeCompare(right.relevant_url);
    });
}

async function resolveExportJobId(
  db: Database<sqlite3.Database, sqlite3.Statement>,
  preferredJobId?: string
) {
  if (preferredJobId) {
    const preferred = await db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM page_terms WHERE job_id = ?",
      preferredJobId
    );
    if ((preferred?.count ?? 0) > 0) {
      return preferredJobId;
    }
  }

  const row = await db.get<{ job_id: string }>(`
    SELECT pt.job_id as job_id
    FROM page_terms pt
    JOIN crawl_jobs cj ON cj.id = pt.job_id
    WHERE cj.status IN ('completed', 'stopped')
    GROUP BY pt.job_id
    HAVING COUNT(*) > 0
    ORDER BY COUNT(*) ASC, MAX(cj.created_at) DESC
    LIMIT 1
  `);

  return row?.job_id ?? null;
}

export async function exportRawStorageSnapshot(
  db: Database<sqlite3.Database, sqlite3.Statement>,
  storagePath: string,
  preferredJobId?: string
) {
  const jobId = await resolveExportJobId(db, preferredJobId);
  await mkdir(dirname(storagePath), { recursive: true });

  if (!jobId) {
    await writeFile(storagePath, "", "utf8");
    cachedPath = "";
    cachedEntries = [];
    cachedMtimeMs = -1;
    return { jobId: null, lineCount: 0 };
  }

  const rows = await db.all<{
    word: string;
    url: string;
    origin: string;
    depth: number;
    frequency: number;
  }[]>(
    `
      SELECT t.term as word,
             p.url as url,
             jp.origin_url as origin,
             jp.depth as depth,
             pt.frequency as frequency
      FROM page_terms pt
      JOIN terms t ON t.id = pt.term_id
      JOIN pages p ON p.id = pt.page_id
      JOIN job_pages jp ON jp.job_id = pt.job_id AND jp.page_id = pt.page_id
      WHERE pt.job_id = ?
      ORDER BY t.term, p.url, jp.origin_url, jp.depth
    `,
    jobId
  );

  const contents = rows
    .map((row) => `${row.word} ${row.url} ${row.origin} ${row.depth} ${row.frequency}`)
    .join("\n");

  await writeFile(storagePath, contents.length > 0 ? `${contents}\n` : "", "utf8");
  cachedPath = "";
  cachedEntries = [];
  cachedMtimeMs = -1;
  return { jobId, lineCount: rows.length };
}

export async function ensureRawStorageSnapshot(
  db: Database<sqlite3.Database, sqlite3.Statement>,
  storagePath: string,
  preferredJobId?: string
) {
  try {
    const existing = await stat(storagePath);
    if (existing.size > 0) {
      return { created: false };
    }
  } catch {
    // Create the file from the database if it does not exist yet.
  }

  const result = await exportRawStorageSnapshot(db, storagePath, preferredJobId);
  return {
    created: true,
    ...result
  };
}
