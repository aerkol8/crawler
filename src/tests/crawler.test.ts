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

test("normalizeUrl handles base URLs and rejects non-http", async () => {
  const { normalizeUrl } = await import("../crawler/parser");
  const result = normalizeUrl("/path", "https://example.com/root");
  assert.equal(result, "https://example.com/path");
  assert.equal(normalizeUrl("mailto:test@example.com"), null);
});

test("frontier prevents duplicate URLs", async () => {
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

test("depth limit enforcement stops beyond max depth", async () => {
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

test("search works while indexing is active", async () => {
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

});

test("resume after interruption continues pending frontier", async () => {
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
