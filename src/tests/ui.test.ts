import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHome, renderSearch, renderStatus } from "../ui/templates";
import type { JobDetail } from "../crawler/manager";

const sampleJob: JobDetail = {
  id: "job-1",
  originUrl: "https://example.com",
  maxDepth: 2,
  status: "running",
  queuedCount: 3,
  processedCount: 4,
  errorCount: 0,
  activeWorkers: 1,
  updatedAt: "2026-03-22T00:00:00.000Z",
  createdAt: "2026-03-22T00:00:00.000Z",
  createdAtEpoch: 1774137600000,
  threadId: 1234,
  currentUrl: "https://example.com/page",
  lastError: null,
  queuedUrls: [
    {
      url: "https://example.com/queued",
      depth: 2,
      status: "pending"
    }
  ],
  logs: [
    {
      timestamp: "2026-03-22T00:00:00.000Z",
      level: "info",
      message: "Fetched and indexed page",
      data: {
        url: "https://example.com/page"
      }
    }
  ]
};

test("renderHome includes live dashboard polling", () => {
  const html = renderHome([sampleJob], 10);

  assert.match(html, /new EventSource\("\/events\/jobs"\)/);
  assert.match(html, /Live event stream connected/);
  assert.match(html, /\/jobs\/job-1\/stop/);
  assert.match(html, /Delete/);
});

test("renderStatus includes live job polling", () => {
  const html = renderStatus(sampleJob, 10);

  assert.match(html, /new EventSource\("\/events\/job\/"/);
  assert.match(html, /Live dashboard updates through a server event stream/);
  assert.match(html, /id="stop-button"/);
  assert.match(html, /\/jobs\/job-1\/delete/);
  assert.match(html, /State Logs/);
  assert.match(html, /Fetched and indexed page/);
  assert.match(html, /Queued URLs/);
});

test("renderStatus disables stop button for completed jobs", () => {
  const html = renderStatus({ ...sampleJob, status: "completed", activeWorkers: 0 }, 10);

  assert.match(html, /id="stop-button" type="submit" disabled/);
  assert.match(html, /Crawler completed successfully\./);
});

test("renderSearch includes live polling when a query is present", () => {
  const html = renderSearch("alpha", [
    {
      relevant_url: "https://example.com/result",
      origin_url: "https://example.com",
      depth: 1,
      relevance_score: 1005
    }
  ]);

  assert.match(html, /new EventSource\("\/events\/search\?query="/);
  assert.match(html, /Live search updates through a server event stream/);
  assert.match(html, /Relevance Score/);
  assert.match(html, /1005/);
});
