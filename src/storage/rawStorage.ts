import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "sqlite";
import sqlite3 from "sqlite3";
import { tokenize } from "../crawler/parser";
import { AsyncMutex } from "../utils/asyncMutex";

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

const bucketFilePattern = /^[a-z0-9]\.data$/;
const rawStorageMutex = new AsyncMutex();

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

function resolveBucketKey(word: string) {
  const initial = word.trim().charAt(0).toLowerCase();
  return /^[a-z0-9]$/.test(initial) ? initial : null;
}

function resolveStorageDirectory(storagePath: string) {
  return storagePath.endsWith(".data") ? dirname(storagePath) : storagePath;
}

function resolveBucketPath(storagePath: string, bucketKey: string) {
  return join(resolveStorageDirectory(storagePath), `${bucketKey}.data`);
}

async function readBucketEntries(bucketPath: string) {
  try {
    const contents = await readFile(bucketPath, "utf8");
    return contents
      .split(/\r?\n/)
      .map((line) => parseRawStorageLine(line))
      .filter((entry): entry is RawStorageEntry => entry !== null);
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function loadQueryEntries(storagePath: string, queryTerms: string[]) {
  const bucketKeys = Array.from(
    new Set(
      queryTerms
        .map((term) => resolveBucketKey(term))
        .filter((bucketKey): bucketKey is string => bucketKey !== null)
    )
  );

  const buckets = await Promise.all(
    bucketKeys.map((bucketKey) => readBucketEntries(resolveBucketPath(storagePath, bucketKey)))
  );

  return buckets.flat();
}

async function clearExistingBucketFiles(storageDir: string) {
  try {
    const entries = await readdir(storageDir, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isFile() || !bucketFilePattern.test(entry.name)) {
        return;
      }
      await unlink(join(storageDir, entry.name));
    }));
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

async function hasBucketSnapshot(storagePath: string) {
  const storageDir = resolveStorageDirectory(storagePath);

  try {
    const entries = await readdir(storageDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !bucketFilePattern.test(entry.name)) {
        continue;
      }

      const fileStats = await stat(join(storageDir, entry.name));
      if (fileStats.size > 0) {
        return true;
      }
    }

    return false;
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function computeRelevanceScore(frequency: number, depth: number, exactMatch: boolean) {
  const exactMatchBonus = exactMatch ? 1000 : 0;
  return (frequency * 10) + exactMatchBonus - (depth * 5);
}

export async function searchRawStorage(storagePath: string, query: string): Promise<RawStorageSearchResult[]> {
  return rawStorageMutex.runExclusive(async () => {
    const queryTerms = Array.from(tokenize(query).keys());
    if (queryTerms.length === 0) {
      return [];
    }

    const queryTermsSet = new Set(queryTerms);
    const entries = await loadQueryEntries(storagePath, queryTerms);
    const grouped = new Map<string, {
      relevant_url: string;
      origin_url: string;
      depth: number;
      matched_frequency: number;
      matched_terms: Set<string>;
    }>();

    for (const entry of entries) {
      if (!queryTermsSet.has(entry.word)) {
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
  });
}

export async function exportRawStorageSnapshot(
  db: Database<sqlite3.Database, sqlite3.Statement>,
  storagePath: string,
  preferredJobId?: string
) {
  return rawStorageMutex.runExclusive(async () => {
    const storageDir = resolveStorageDirectory(storagePath);
    await mkdir(storageDir, { recursive: true });

    const rows = await db.all<{
      job_id: string;
      word: string;
      url: string;
      origin: string;
      depth: number;
      frequency: number;
    }[]>(
      `
        SELECT pt.job_id as job_id,
               t.term as word,
               p.url as url,
               jp.origin_url as origin,
               jp.depth as depth,
               pt.frequency as frequency
        FROM page_terms pt
        JOIN terms t ON t.id = pt.term_id
        JOIN pages p ON p.id = pt.page_id
        JOIN job_pages jp ON jp.job_id = pt.job_id AND jp.page_id = pt.page_id
        ${preferredJobId ? "WHERE pt.job_id = ?" : ""}
        ORDER BY t.term, p.url, jp.origin_url, jp.depth
      `,
      ...(preferredJobId ? [preferredJobId] : [])
    );

    const buckets = new Map<string, string[]>();
    const jobIds = new Set<string>();

    for (const row of rows) {
      const bucketKey = resolveBucketKey(row.word);
      if (!bucketKey) {
        continue;
      }

      let lines = buckets.get(bucketKey);
      if (!lines) {
        lines = [];
        buckets.set(bucketKey, lines);
      }

      lines.push(`${row.word} ${row.url} ${row.origin} ${row.depth} ${row.frequency}`);
      jobIds.add(row.job_id);
    }

    await clearExistingBucketFiles(storageDir);

    const bucketEntries = Array.from(buckets.entries()).sort(([left], [right]) => left.localeCompare(right));
    for (const [bucketKey, lines] of bucketEntries) {
      const bucketPath = resolveBucketPath(storageDir, bucketKey);
      const contents = `${lines.join("\n")}\n`;
      await writeFile(bucketPath, contents, "utf8");
    }

    return {
      jobId: preferredJobId ?? null,
      jobCount: jobIds.size,
      lineCount: rows.length,
      bucketCount: bucketEntries.length,
      storageDir
    };
  });
}

export async function ensureRawStorageSnapshot(
  db: Database<sqlite3.Database, sqlite3.Statement>,
  storagePath: string,
  preferredJobId?: string
) {
  const existing = await rawStorageMutex.runExclusive(async () => hasBucketSnapshot(storagePath));
  if (existing) {
    return { created: false };
  }

  const result = await exportRawStorageSnapshot(db, storagePath, preferredJobId);
  return {
    created: true,
    ...result
  };
}
