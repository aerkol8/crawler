import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "sqlite";
import type sqlite3 from "sqlite3";
import type { CrawlerManager } from "../crawler/manager";

type MockResponse = {
  ok: boolean;
  text: () => Promise<string>;
};

function createFetchStub(pages: Record<string, string>, delaysMs?: Record<string, number>) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<MockResponse> => {
    const url = typeof input === "string" ? input : input.toString();
    const html = pages[url];
    const signal = init?.signal;

    if (delaysMs?.[url]) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, delaysMs[url]);

        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          const error = new Error("The operation was aborted.");
          error.name = "AbortError";
          reject(error);
        };

        if (signal?.aborted) {
          onAbort();
          return;
        }

        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }

    if (!html) {
      return { ok: false, text: async () => "" };
    }
    return { ok: true, text: async () => html };
  };
}

let dbPath = "";
let storagePath = "";
let db: Database<sqlite3.Database, sqlite3.Statement>;
const managers: CrawlerManager[] = [];
const serial = { concurrency: false };

function registerManager(manager: CrawlerManager) {
  managers.push(manager);
  return manager;
}

async function resetDb() {
  await db.exec("DELETE FROM crawl_jobs;");
  await db.exec("DELETE FROM pages;");
  await db.exec("DELETE FROM job_pages;");
  await db.exec("DELETE FROM terms;");
  await db.exec("DELETE FROM page_terms;");
  await db.exec("DELETE FROM frontier;");
}

before(async () => {
  dbPath = `./test-${Date.now()}.db`;
  storagePath = mkdtempSync(join(tmpdir(), "crawler-storage-test-"));
  process.env.DB_PATH = dbPath;
  process.env.RAW_STORAGE_PATH = storagePath;
  process.env.MAX_QUEUE = "10";
  process.env.MAX_CONCURRENT = "2";
  process.env.RATE_PER_SEC = "100";
  process.env.REQUEST_TIMEOUT_MS = "2000";

  const { getDb } = await import("../db");
  db = await getDb();
  await resetDb();
});

beforeEach(async () => {
  await resetDb();
  rmSync(storagePath, { recursive: true, force: true });
});

afterEach(() => {
  for (const manager of managers) {
    manager.stopAll();
  }
  managers.length = 0;
});

after(async () => {
  await db.close();
  rmSync(dbPath, { force: true });
  rmSync(storagePath, { recursive: true, force: true });
});

test("normalizeUrl handles base URLs and rejects non-http", serial, async () => {
  const { normalizeUrl } = await import("../crawler/parser");
  const result = normalizeUrl("/path", "https://example.com/root");
  assert.equal(result, "https://example.com/path");
  assert.equal(normalizeUrl("mailto:test@example.com"), null);
});

test("frontier prevents duplicate URLs", serial, async () => {
  const { FrontierQueue } = await import("../crawler/frontier");

  await db.run(
    "INSERT INTO crawl_jobs (id, origin_url, max_depth, status, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)",
    "job-dup",
    "https://example.com",
    1,
    new Date().toISOString(),
    new Date().toISOString()
  );

  const frontier = new FrontierQueue("job-dup", db, 10);
  await frontier.init();
  const first = await frontier.enqueue("https://example.com", 0);
  const second = await frontier.enqueue("https://example.com", 0);
  assert.equal(first, true);
  assert.equal(second, false);

});

test("frontier enforces max queue under concurrent enqueues", serial, async () => {
  const { FrontierQueue } = await import("../crawler/frontier");

  await db.run(
    "INSERT INTO crawl_jobs (id, origin_url, max_depth, status, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)",
    "job-cap",
    "https://example.com",
    1,
    new Date().toISOString(),
    new Date().toISOString()
  );

  const frontier = new FrontierQueue("job-cap", db, 1);
  await frontier.init();

  const results = await Promise.all([
    frontier.enqueue("https://example.com/a", 0),
    frontier.enqueue("https://example.com/b", 0)
  ]);

  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(frontier.getQueueDepth(), 1);
});

test("depth limit enforcement stops beyond max depth", serial, async () => {
  const { CrawlerManager } = await import("../crawler/manager");

  const pages = {
    "https://example.com": "<html><body>root <a href='https://example.com/a'>A</a></body></html>",
    "https://example.com/a": "<html><body>child</body></html>"
  };
  globalThis.fetch = createFetchStub(pages) as any;

  const manager = new CrawlerManager(db);
  registerManager(manager);
  const job = await manager.startJob("https://example.com", 0);

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const status = await manager.getJob(job.id);
    if (status && status.status === "completed") {
      break;
    }
    await delay(50);
  }

  const rows = await db.all<{ depth: number }[]>("SELECT depth FROM job_pages WHERE job_id = ?", job.id);
  assert.deepEqual(rows.map((row) => row.depth), [0]);

});

test("search works while indexing is active", serial, async () => {
  const { CrawlerManager } = await import("../crawler/manager");
  const { SearchService } = await import("../search/searchService");

  const pages = {
    "https://example.com": "<html><body>alpha beta <a href='https://example.com/b'>B</a></body></html>",
    "https://example.com/b": "<html><body>gamma delta</body></html>"
  };
  globalThis.fetch = createFetchStub(pages, { "https://example.com/b": 800 }) as any;

  const manager = new CrawlerManager(db);
  registerManager(manager);
  const search = new SearchService(storagePath);
  const job = await manager.startJob("https://example.com", 1);

  await delay(150);
  const status = await manager.getJob(job.id);
  const results = await search.search("alpha");

  assert.ok(status && status.status === "running");
  assert.ok(results.length > 0);

  const completionDeadline = Date.now() + 2000;
  while (Date.now() < completionDeadline) {
    const finalStatus = await manager.getJob(job.id);
    if (finalStatus?.status === "completed") {
      break;
    }
    await delay(50);
  }

});

test("reused fetched pages are searchable for later jobs", serial, async () => {
  const { CrawlerManager } = await import("../crawler/manager");
  const { SearchService } = await import("../search/searchService");

  const pages = {
    "https://example.com/root": "<html><body>root <a href='https://example.com/a'>A</a></body></html>",
    "https://example.com/a": "<html><body>alpha only</body></html>"
  };
  globalThis.fetch = createFetchStub(pages) as any;

  const manager = new CrawlerManager(db);
  registerManager(manager);
  const search = new SearchService(storagePath);

  const firstJob = await manager.startJob("https://example.com/a", 0);

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const firstStatus = await manager.getJob(firstJob.id);
    if (firstStatus?.status === "completed") {
      break;
    }
    await delay(50);
  }

  const secondJob = await manager.startJob("https://example.com/root", 1);

  const secondDeadline = Date.now() + 3000;
  while (Date.now() < secondDeadline) {
    const secondStatus = await manager.getJob(secondJob.id);
    if (secondStatus?.status === "completed") {
      break;
    }
    await delay(50);
  }

  const results = await search.search("alpha");

  assert.ok(
    results.some((result) => (
      result.relevant_url === "https://example.com/a"
      && result.origin_url === "https://example.com/a"
      && result.depth === 0
    ))
  );
  assert.ok(
    results.some((result) => (
      result.relevant_url === "https://example.com/a"
      && result.origin_url === "https://example.com/root"
      && result.depth === 1
    ))
  );
});

test("stopJob halts an active crawl and marks it stopped", serial, async () => {
  const { CrawlerManager } = await import("../crawler/manager");

  const pages = {
    "https://example.com": "<html><body>root <a href='https://example.com/slow'>slow</a></body></html>",
    "https://example.com/slow": "<html><body>slow page</body></html>"
  };
  globalThis.fetch = createFetchStub(pages, { "https://example.com/slow": 1000 }) as any;

  const manager = new CrawlerManager(db);
  registerManager(manager);
  const job = await manager.startJob("https://example.com", 1);

  const queuedDeadline = Date.now() + 2000;
  while (Date.now() < queuedDeadline) {
    const slowRow = await db.get<{ status: string }>(
      "SELECT status FROM frontier WHERE job_id = ? AND url = ?",
      job.id,
      "https://example.com/slow"
    );
    const doneRows = await db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM frontier WHERE job_id = ? AND status = 'done'",
      job.id
    );

    if (slowRow && (slowRow.status === "pending" || slowRow.status === "processing") && doneRows?.count === 1) {
      break;
    }
    await delay(25);
  }

  const stopped = await manager.stopJob(job.id);
  assert.equal(stopped?.status, "stopped");
  assert.equal(stopped?.activeWorkers, 0);

  const finalStatus = await manager.getJob(job.id);
  const doneRows = await db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM frontier WHERE job_id = ? AND status = 'done'",
    job.id
  );
  const stoppedRows = await db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM frontier WHERE job_id = ? AND error = 'stopped'",
    job.id
  );

  assert.equal(finalStatus?.status, "stopped");
  assert.equal(doneRows?.count, 1);
  assert.equal(stoppedRows?.count, 1);
});

test("stopJob leaves completed jobs unchanged", serial, async () => {
  const { CrawlerManager } = await import("../crawler/manager");

  await db.run(
    "INSERT INTO crawl_jobs (id, origin_url, max_depth, status, created_at, updated_at, queued_count, processed_count, error_count, active_workers) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?)",
    "job-stop-completed",
    "https://example.com",
    1,
    new Date().toISOString(),
    new Date().toISOString(),
    0,
    4,
    1,
    0
  );

  const manager = new CrawlerManager(db);
  registerManager(manager);
  const job = await manager.stopJob("job-stop-completed");

  assert.equal(job?.status, "completed");
  assert.equal(job?.processedCount, 4);
  assert.equal(job?.errorCount, 1);
});

test("search returns all relevant URLs by default", serial, async () => {
  const { SearchService } = await import("../search/searchService");
  const { exportRawStorageSnapshot } = await import("../storage/rawStorage");

  await db.run(
    "INSERT INTO crawl_jobs (id, origin_url, max_depth, status, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?)",
    "job-search-all",
    "https://example.com",
    1,
    new Date().toISOString(),
    new Date().toISOString()
  );

  await db.run("INSERT INTO terms (term) VALUES (?)", "alpha");
  const termRow = await db.get<{ id: number }>("SELECT id FROM terms WHERE term = ?", "alpha");
  assert.ok(termRow);

  for (let index = 0; index < 60; index += 1) {
    const url = `https://example.com/page-${index}`;
    await db.run(
      "INSERT INTO pages (url, title, fetched_at) VALUES (?, ?, ?)",
      url,
      `Page ${index}`,
      new Date().toISOString()
    );
    const pageRow = await db.get<{ id: number }>("SELECT id FROM pages WHERE url = ?", url);
    assert.ok(pageRow);
    await db.run(
      "INSERT INTO job_pages (job_id, page_id, origin_url, depth, discovered_at) VALUES (?, ?, ?, ?, ?)",
      "job-search-all",
      pageRow.id,
      "https://example.com",
      1,
      new Date().toISOString()
    );
    await db.run(
      "INSERT INTO page_terms (job_id, page_id, term_id, frequency) VALUES (?, ?, ?, ?)",
      "job-search-all",
      pageRow.id,
      termRow.id,
      1
    );
  }

  await exportRawStorageSnapshot(db, storagePath);

  const search = new SearchService(storagePath);
  const results = await search.search("alpha");

  assert.equal(results.length, 60);
});

test("deleteJob removes selected crawl data and keeps shared indexed pages", serial, async () => {
  const { CrawlerManager } = await import("../crawler/manager");
  const { SearchService } = await import("../search/searchService");

  await db.run(
    "INSERT INTO crawl_jobs (id, origin_url, max_depth, status, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?)",
    "job-delete-a",
    "https://example.com",
    1,
    new Date().toISOString(),
    new Date().toISOString()
  );
  await db.run(
    "INSERT INTO crawl_jobs (id, origin_url, max_depth, status, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?)",
    "job-delete-b",
    "https://example.org",
    1,
    new Date().toISOString(),
    new Date().toISOString()
  );

  await db.run("INSERT INTO terms (term) VALUES (?)", "alpha");
  const termRow = await db.get<{ id: number }>("SELECT id FROM terms WHERE term = ?", "alpha");
  assert.ok(termRow);

  await db.run(
    "INSERT INTO pages (url, title, fetched_at) VALUES (?, ?, ?)",
    "https://shared.example/page",
    "Shared",
    new Date().toISOString()
  );
  await db.run(
    "INSERT INTO pages (url, title, fetched_at) VALUES (?, ?, ?)",
    "https://only-a.example/page",
    "Only A",
    new Date().toISOString()
  );

  const sharedPage = await db.get<{ id: number }>("SELECT id FROM pages WHERE url = ?", "https://shared.example/page");
  const onlyAPage = await db.get<{ id: number }>("SELECT id FROM pages WHERE url = ?", "https://only-a.example/page");
  assert.ok(sharedPage);
  assert.ok(onlyAPage);

  await db.run(
    "INSERT INTO job_pages (job_id, page_id, origin_url, depth, discovered_at) VALUES (?, ?, ?, ?, ?)",
    "job-delete-a",
    sharedPage.id,
    "https://example.com",
    1,
    new Date().toISOString()
  );
  await db.run(
    "INSERT INTO job_pages (job_id, page_id, origin_url, depth, discovered_at) VALUES (?, ?, ?, ?, ?)",
    "job-delete-a",
    onlyAPage.id,
    "https://example.com",
    1,
    new Date().toISOString()
  );
  await db.run(
    "INSERT INTO job_pages (job_id, page_id, origin_url, depth, discovered_at) VALUES (?, ?, ?, ?, ?)",
    "job-delete-b",
    sharedPage.id,
    "https://example.org",
    1,
    new Date().toISOString()
  );

  await db.run(
    "INSERT INTO page_terms (job_id, page_id, term_id, frequency) VALUES (?, ?, ?, ?)",
    "job-delete-a",
    sharedPage.id,
    termRow.id,
    2
  );
  await db.run(
    "INSERT INTO page_terms (job_id, page_id, term_id, frequency) VALUES (?, ?, ?, ?)",
    "job-delete-a",
    onlyAPage.id,
    termRow.id,
    1
  );
  await db.run(
    "INSERT INTO page_terms (job_id, page_id, term_id, frequency) VALUES (?, ?, ?, ?)",
    "job-delete-b",
    sharedPage.id,
    termRow.id,
    3
  );

  const manager = new CrawlerManager(db);
  registerManager(manager);
  const deleted = await manager.deleteJob("job-delete-a");
  assert.equal(deleted, true);

  const remainingJobs = await db.all<{ id: string }[]>("SELECT id FROM crawl_jobs ORDER BY id");
  const remainingPages = await db.all<{ url: string }[]>("SELECT url FROM pages ORDER BY url");
  const remainingJobPages = await db.all<{ job_id: string; page_id: number }[]>(
    "SELECT job_id, page_id FROM job_pages ORDER BY job_id, page_id"
  );
  const remainingTerms = await db.all<{ term: string }[]>("SELECT term FROM terms");
  const search = new SearchService(storagePath);
  const results = await search.search("alpha");

  assert.deepEqual(remainingJobs.map((row) => row.id), ["job-delete-b"]);
  assert.deepEqual(remainingPages.map((row) => row.url), ["https://shared.example/page"]);
  assert.deepEqual(remainingJobPages.map((row) => row.job_id), ["job-delete-b"]);
  assert.deepEqual(remainingTerms.map((row) => row.term), ["alpha"]);
  assert.deepEqual(results, [
    {
      relevant_url: "https://shared.example/page",
      origin_url: "https://example.org",
      depth: 1,
      relevance_score: 1025
    }
  ]);
});

test("deleteJob can remove a crawl while it is still running", serial, async () => {
  const { CrawlerManager } = await import("../crawler/manager");

  const pages = {
    "https://example.com": "<html><body>root <a href='https://example.com/slow'>slow</a></body></html>",
    "https://example.com/slow": "<html><body>slow page</body></html>"
  };
  globalThis.fetch = createFetchStub(pages, { "https://example.com/slow": 1000 }) as any;

  const manager = new CrawlerManager(db);
  registerManager(manager);
  const job = await manager.startJob("https://example.com", 1);

  const queuedDeadline = Date.now() + 2000;
  while (Date.now() < queuedDeadline) {
    const slowRow = await db.get<{ status: string }>(
      "SELECT status FROM frontier WHERE job_id = ? AND url = ?",
      job.id,
      "https://example.com/slow"
    );
    if (slowRow) {
      break;
    }
    await delay(25);
  }

  const deleted = await manager.deleteJob(job.id);
  const jobRow = await manager.getJob(job.id);
  const frontierRows = await db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM frontier WHERE job_id = ?",
    job.id
  );
  const jobPageRows = await db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM job_pages WHERE job_id = ?",
    job.id
  );
  const pageRows = await db.get<{ count: number }>(
    "SELECT COUNT(*) as count FROM pages"
  );

  assert.equal(deleted, true);
  assert.equal(jobRow, null);
  assert.equal(frontierRows?.count, 0);
  assert.equal(jobPageRows?.count, 0);
  assert.equal(pageRows?.count, 0);
});

test("resume after interruption continues pending frontier", serial, async () => {
  const { CrawlerManager } = await import("../crawler/manager");

  await db.run(
    "INSERT INTO crawl_jobs (id, origin_url, max_depth, status, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)",
    "job-resume",
    "https://example.com",
    0,
    new Date().toISOString(),
    new Date().toISOString()
  );

  await db.run(
    "INSERT INTO frontier (job_id, url, depth, status, enqueued_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
    "job-resume",
    "https://example.com",
    0,
    new Date().toISOString(),
    new Date().toISOString()
  );

  globalThis.fetch = createFetchStub({
    "https://example.com": "<html><body>resume test</body></html>"
  }) as any;

  const manager = new CrawlerManager(db);
  registerManager(manager);
  await manager.resumeIncompleteJobs();

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const status = await manager.getJob("job-resume");
    if (status && status.status === "completed") {
      break;
    }
    await delay(50);
  }

  const status = await manager.getJob("job-resume");
  const pages = await db.all<any[]>("SELECT url FROM pages");
  assert.equal(status?.status, "completed");
  assert.equal(pages.length, 1);

});

test("resumeIncompleteJobs finalizes stopping jobs as stopped", serial, async () => {
  const { CrawlerManager } = await import("../crawler/manager");

  await db.run(
    "INSERT INTO crawl_jobs (id, origin_url, max_depth, status, created_at, updated_at, queued_count, active_workers) VALUES (?, ?, ?, 'stopping', ?, ?, ?, ?)",
    "job-stopping-resume",
    "https://example.com",
    1,
    new Date().toISOString(),
    new Date().toISOString(),
    2,
    1
  );

  await db.run(
    "INSERT INTO frontier (job_id, url, depth, status, enqueued_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
    "job-stopping-resume",
    "https://example.com/a",
    1,
    new Date().toISOString(),
    new Date().toISOString()
  );
  await db.run(
    "INSERT INTO frontier (job_id, url, depth, status, enqueued_at, updated_at) VALUES (?, ?, ?, 'processing', ?, ?)",
    "job-stopping-resume",
    "https://example.com/b",
    1,
    new Date().toISOString(),
    new Date().toISOString()
  );

  const manager = new CrawlerManager(db);
  registerManager(manager);
  await manager.resumeIncompleteJobs();

  const status = await manager.getJob("job-stopping-resume");
  const frontierRows = await db.all<{ status: string; error: string | null }[]>(
    "SELECT status, error FROM frontier WHERE job_id = ? ORDER BY id",
    "job-stopping-resume"
  );

  assert.equal(status?.status, "stopped");
  assert.equal(status?.queuedCount, 0);
  assert.equal(status?.activeWorkers, 0);
  assert.deepEqual(frontierRows, [
    { status: "failed", error: "stopped" },
    { status: "failed", error: "stopped" }
  ]);
});
