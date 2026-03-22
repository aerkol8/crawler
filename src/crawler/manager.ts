import { Database } from "sqlite";
import sqlite3 from "sqlite3";
import { randomUUID } from "crypto";
import { config } from "../config";
import { FrontierQueue, FrontierItem } from "./frontier";
import { WorkerPool } from "./workerPool";
import { normalizeUrl, parseHtml } from "./parser";

export type CrawlJob = {
  id: string;
  originUrl: string;
  maxDepth: number;
};

export type JobStatus = {
  id: string;
  originUrl: string;
  maxDepth: number;
  status: string;
  queuedCount: number;
  processedCount: number;
  errorCount: number;
  activeWorkers: number;
  updatedAt: string;
};

export class CrawlerManager {
  private readonly pools = new Map<string, WorkerPool>();
  private readonly frontiers = new Map<string, FrontierQueue>();

  constructor(
    private readonly db: Database<sqlite3.Database, sqlite3.Statement>,
    private readonly onJobUpdated?: (jobId: string) => void
  ) {}

  async startJob(originUrl: string, maxDepth: number): Promise<CrawlJob> {
    const jobId = randomUUID();
    const now = new Date().toISOString();

    await this.db.run(
      "INSERT INTO crawl_jobs (id, origin_url, max_depth, status, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)",
      jobId,
      originUrl,
      maxDepth,
      now,
      now
    );

    const frontier = new FrontierQueue(jobId, this.db, config.maxQueue);
    await frontier.init();
    await frontier.enqueue(originUrl, 0);

    this.frontiers.set(jobId, frontier);
    this.startPool(jobId, frontier, originUrl, maxDepth);

    return { id: jobId, originUrl, maxDepth };
  }

  async resumeIncompleteJobs() {
    await this.db.run(
      "UPDATE frontier SET status = 'pending' WHERE status = 'processing'"
    );

    const jobs = await this.db.all<{ id: string; origin_url: string; max_depth: number }[]>(
      "SELECT id, origin_url, max_depth FROM crawl_jobs WHERE status = 'running'"
    );

    for (const job of jobs) {
      const frontier = new FrontierQueue(job.id, this.db, config.maxQueue);
      await frontier.init();
      await frontier.refillPendingFromProcessing();
      this.frontiers.set(job.id, frontier);
      this.startPool(job.id, frontier, job.origin_url, job.max_depth);
    }
  }

  async listJobs(): Promise<JobStatus[]> {
    const rows = await this.db.all<any[]>(
      "SELECT id, origin_url, max_depth, status, queued_count, processed_count, error_count, active_workers, updated_at FROM crawl_jobs ORDER BY created_at DESC"
    );
    return rows.map((row) => ({
      id: row.id,
      originUrl: row.origin_url,
      maxDepth: row.max_depth,
      status: row.status,
      queuedCount: row.queued_count,
      processedCount: row.processed_count,
      errorCount: row.error_count,
      activeWorkers: row.active_workers,
      updatedAt: row.updated_at
    }));
  }

  async getJob(jobId: string): Promise<JobStatus | null> {
    const row = await this.db.get<any>(
      "SELECT id, origin_url, max_depth, status, queued_count, processed_count, error_count, active_workers, updated_at FROM crawl_jobs WHERE id = ?",
      jobId
    );

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      originUrl: row.origin_url,
      maxDepth: row.max_depth,
      status: row.status,
      queuedCount: row.queued_count,
      processedCount: row.processed_count,
      errorCount: row.error_count,
      activeWorkers: row.active_workers,
      updatedAt: row.updated_at
    };
  }

  stopAll() {
    for (const pool of this.pools.values()) {
      pool.stop();
    }
    this.pools.clear();
    this.frontiers.clear();
  }

  private startPool(jobId: string, frontier: FrontierQueue, originUrl: string, maxDepth: number) {
    const pool = new WorkerPool(
      frontier,
      { maxConcurrent: config.maxConcurrent, ratePerSec: config.ratePerSec },
      async (item) => this.processItem(jobId, originUrl, maxDepth, frontier, item),
      () => {
        if (!this.pools.has(jobId)) {
          return;
        }
        void this.updateJobStats(jobId, frontier, this.pools.get(jobId)).catch(() => {
          // Teardown can close the DB while in-flight tasks settle.
        });
      }
    );

    this.pools.set(jobId, pool);
    pool.start();
    void this.updateJobStats(jobId, frontier, pool);
  }

  private async processItem(
    jobId: string,
    originUrl: string,
    maxDepth: number,
    frontier: FrontierQueue,
    item: FrontierItem
  ) {
    try {
      if (item.depth > maxDepth) {
        await frontier.markDone(item.id);
        return;
      }

      const pageRow = await this.db.get<{ id: number; fetched_at: string | null }>(
        "SELECT id, fetched_at FROM pages WHERE url = ?",
        item.url
      );

      if (pageRow?.fetched_at) {
        await this.insertJobPage(jobId, pageRow.id, originUrl, item.depth);
        await frontier.markDone(item.id);
        await this.incrementProcessed(jobId);
        return;
      }

      const fetched = await this.fetchPage(item.url);
      if (!fetched) {
        await frontier.markFailed(item.id, "fetch_failed");
        await this.incrementError(jobId);
        return;
      }

      const parsed = parseHtml(fetched.html, item.url);
      const pageId = await this.upsertPage(item.url, parsed.title);

      await this.insertJobPage(jobId, pageId, originUrl, item.depth);
      await this.indexTerms(jobId, pageId, parsed.termCounts);

      if (item.depth < maxDepth) {
        for (const link of parsed.links) {
          const normalized = normalizeUrl(link);
          if (!normalized) {
            continue;
          }
          const childDepth = item.depth + 1;
          await this.ensurePageRow(normalized);
          await this.insertJobPageByUrl(jobId, normalized, originUrl, childDepth);
          await frontier.enqueue(normalized, childDepth);
        }
      }

      await frontier.markDone(item.id);
      await this.incrementProcessed(jobId);
    } catch (error) {
      await frontier.markFailed(item.id, "exception");
      await this.incrementError(jobId);
    } finally {
      await this.updateJobStats(jobId, frontier, this.pools.get(jobId));
    }
  }

  private async fetchPage(url: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": config.userAgent
        }
      });

      if (!response.ok) {
        return null;
      }

      const text = await response.text();
      if (text.length > config.maxBodyBytes) {
        return null;
      }

      return { html: text };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async upsertPage(url: string, title: string | null) {
    const now = new Date().toISOString();
    await this.db.run(
      "INSERT OR IGNORE INTO pages (url) VALUES (?)",
      url
    );
    await this.db.run(
      "UPDATE pages SET title = ?, fetched_at = ? WHERE url = ?",
      title,
      now,
      url
    );
    const row = await this.db.get<{ id: number }>("SELECT id FROM pages WHERE url = ?", url);
    return row!.id;
  }

  private async ensurePageRow(url: string) {
    await this.db.run("INSERT OR IGNORE INTO pages (url) VALUES (?)", url);
  }

  private async insertJobPage(jobId: string, pageId: number, originUrl: string, depth: number) {
    const now = new Date().toISOString();
    await this.db.run(
      "INSERT OR IGNORE INTO job_pages (job_id, page_id, origin_url, depth, discovered_at) VALUES (?, ?, ?, ?, ?)",
      jobId,
      pageId,
      originUrl,
      depth,
      now
    );
  }

  private async insertJobPageByUrl(jobId: string, url: string, originUrl: string, depth: number) {
    const row = await this.db.get<{ id: number }>("SELECT id FROM pages WHERE url = ?", url);
    if (!row) {
      return;
    }
    await this.insertJobPage(jobId, row.id, originUrl, depth);
  }

  private async indexTerms(jobId: string, pageId: number, termCounts: Map<string, number>) {
    await this.db.exec("BEGIN TRANSACTION;");
    try {
      for (const [term, frequency] of termCounts.entries()) {
        await this.db.run("INSERT OR IGNORE INTO terms (term) VALUES (?)", term);
        const termRow = await this.db.get<{ id: number }>(
          "SELECT id FROM terms WHERE term = ?",
          term
        );
        if (!termRow) {
          continue;
        }
        await this.db.run(
          "INSERT INTO page_terms (job_id, page_id, term_id, frequency) VALUES (?, ?, ?, ?) ON CONFLICT(job_id, page_id, term_id) DO UPDATE SET frequency = excluded.frequency",
          jobId,
          pageId,
          termRow.id,
          frequency
        );
      }
      await this.db.exec("COMMIT;");
    } catch (error) {
      await this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  private async incrementProcessed(jobId: string) {
    await this.db.run(
      "UPDATE crawl_jobs SET processed_count = processed_count + 1, updated_at = ? WHERE id = ?",
      new Date().toISOString(),
      jobId
    );
  }

  private async incrementError(jobId: string) {
    await this.db.run(
      "UPDATE crawl_jobs SET error_count = error_count + 1, updated_at = ? WHERE id = ?",
      new Date().toISOString(),
      jobId
    );
  }

  private async updateJobStats(jobId: string, frontier: FrontierQueue, pool?: WorkerPool | null) {
    const queuedCount = frontier.getQueueDepth();
    const activeWorkers = pool ? pool.getActiveCount() : 0;
    const status = queuedCount === 0 && activeWorkers === 0 ? "completed" : "running";

    await this.db.run(
      "UPDATE crawl_jobs SET queued_count = ?, active_workers = ?, status = ?, updated_at = ? WHERE id = ?",
      queuedCount,
      activeWorkers,
      status,
      new Date().toISOString(),
      jobId
    );

    this.onJobUpdated?.(jobId);
  }
}
