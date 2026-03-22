import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { WorkerPool } from "../crawler/workerPool";

test("worker pool does not exceed concurrency limit during overlapping pump intervals", async () => {
  const items = [
    { id: 1, url: "https://example.com/1", depth: 0 },
    { id: 2, url: "https://example.com/2", depth: 0 }
  ];

  const frontier = {
    async dequeue() {
      await delay(80);
      return items.shift() ?? null;
    }
  } as any;

  let inFlight = 0;
  let maxInFlight = 0;
  let processed = 0;

  const pool = new WorkerPool(
    frontier,
    { maxConcurrent: 1, ratePerSec: 100 },
    async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(60);
      processed += 1;
      inFlight -= 1;
    }
  );

  pool.start();

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && processed < 2) {
    await delay(20);
  }

  pool.stop();

  assert.equal(processed, 2);
  assert.equal(maxInFlight, 1);
});
