import { Database } from "sqlite";
import sqlite3 from "sqlite3";

export type FrontierItem = {
  id: number;
  url: string;
  depth: number;
};

export class FrontierQueue {
  private readonly maxQueue: number;
  private readonly maxInMemory: number;
  private readonly inMemory: FrontierItem[] = [];
  private pendingCount = 0;

  constructor(
    private readonly jobId: string,
    private readonly db: Database<sqlite3.Database, sqlite3.Statement>,
    maxQueue: number
  ) {
    this.maxQueue = maxQueue;
    this.maxInMemory = Math.min(200, maxQueue);
  }

  async init() {
    const row = await this.db.get<{ count: number }>(
      "SELECT COUNT(*) as count FROM frontier WHERE job_id = ? AND status = 'pending'",
      this.jobId
    );
    this.pendingCount = row?.count ?? 0;
  }

  getQueueDepth() {
    return this.pendingCount;
  }

  async enqueue(url: string, depth: number): Promise<boolean> {
    if (this.pendingCount >= this.maxQueue) {
      return false;
    }

    const now = new Date().toISOString();
    const result = await this.db.run(
      "INSERT OR IGNORE INTO frontier (job_id, url, depth, status, enqueued_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)",
      this.jobId,
      url,
      depth,
      now,
      now
    );

    if (result.changes && result.changes > 0) {
      this.pendingCount += 1;
      if (this.inMemory.length < this.maxInMemory) {
        const inserted = await this.db.get<{ id: number }>(
          "SELECT id FROM frontier WHERE job_id = ? AND url = ?",
          this.jobId,
          url
        );
        if (inserted) {
          const now = new Date().toISOString();
          await this.db.run(
            "UPDATE frontier SET status = 'processing', updated_at = ? WHERE id = ?",
            now,
            inserted.id
          );
          this.inMemory.push({ id: inserted.id, url, depth });
        }
      }
      return true;
    }

    return false;
  }

  async dequeue(): Promise<FrontierItem | null> {
    if (this.inMemory.length === 0) {
      await this.fillFromDb();
    }
    const item = this.inMemory.shift() ?? null;
    return item;
  }

  async markDone(itemId: number) {
    const now = new Date().toISOString();
    await this.db.run(
      "UPDATE frontier SET status = 'done', updated_at = ? WHERE id = ?",
      now,
      itemId
    );
    this.pendingCount = Math.max(0, this.pendingCount - 1);
  }

  async markFailed(itemId: number, error: string) {
    const now = new Date().toISOString();
    await this.db.run(
      "UPDATE frontier SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
      error,
      now,
      itemId
    );
    this.pendingCount = Math.max(0, this.pendingCount - 1);
  }

  async refillPendingFromProcessing() {
    const now = new Date().toISOString();
    await this.db.run(
      "UPDATE frontier SET status = 'pending', updated_at = ? WHERE job_id = ? AND status = 'processing'",
      now,
      this.jobId
    );
  }

  private async fillFromDb() {
    const batch = await this.db.all<FrontierItem[]>(
      "SELECT id, url, depth FROM frontier WHERE job_id = ? AND status = 'pending' ORDER BY id LIMIT ?",
      this.jobId,
      this.maxInMemory
    );

    if (batch.length === 0) {
      return;
    }

    const ids = batch.map((item) => item.id);
    const now = new Date().toISOString();
    await this.db.run(
      `UPDATE frontier SET status = 'processing', updated_at = ? WHERE id IN (${ids.map(() => "?").join(",")})`,
      now,
      ...ids
    );

    this.inMemory.push(...batch);
  }
}
