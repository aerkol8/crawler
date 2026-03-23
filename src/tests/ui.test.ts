import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHome, renderSearch, renderStatus } from "../ui/templates";
import type { JobStatus } from "../crawler/manager";

const sampleJob: JobStatus = {
  id: "job-1",
  originUrl: "https://example.com",
  maxDepth: 2,
  status: "running",
  queuedCount: 3,
  processedCount: 4,
  errorCount: 0,
  activeWorkers: 1,
  updatedAt: "2026-03-22T00:00:00.000Z"
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
});

test("renderStatus disables stop button for completed jobs", () => {
  const html = renderStatus({ ...sampleJob, status: "completed", activeWorkers: 0 }, 10);

  assert.match(html, /id="stop-button" type="submit" disabled/);
});

test("renderSearch includes live polling when a query is present", () => {
  const html = renderSearch("alpha", [
    {
      relevant_url: "https://example.com/result",
      origin_url: "https://example.com",
      depth: 1
    }
  ]);

  assert.match(html, /new EventSource\("\/events\/search\?query="/);
  assert.match(html, /Live search updates through a server event stream/);
});
