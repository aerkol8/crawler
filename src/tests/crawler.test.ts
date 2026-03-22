import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "sqlite";
import type sqlite3 from "sqlite3";
import type { CrawlerManager } from "../crawler/manager";

type MockResponse = {
  ok: boolean;
  text: () => Promise<string>;
};

function createFetchStub(pages: Record<string, string>, delaysMs?: Record<string, number>) {
  return async (input: RequestInfo | URL): Promise<MockResponse> => {
    const url = typeof input === "string" ? input : input.toString();
    const html = pages[url];
    if (delaysMs?.[url]) {
      await delay(delaysMs[url]);
    }
    if (!html) {
      return { ok: false, text: async () => "" };
    }
    return { ok: true, text: async () => html };
  };
}

let dbPath = "";
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
  process.env.DB_PATH = dbPath;
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
  const search = new SearchService(db);
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

test("search returns all relevant URLs by default", serial, async () => {
  const { SearchService } = await import("../search/searchService");

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

  const search = new SearchService(db);
  const results = await search.search("alpha");

  assert.equal(results.length, 60);
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
