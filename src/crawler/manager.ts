import { Database } from "sqlite";
import sqlite3 from "sqlite3";
import { threadId } from "node:worker_threads";
import { config } from "../config";
import {
  CrawlerArtifactsStore,
  CrawlerArtifactLogEntry,
  CrawlerArtifactQueueEntry
} from "../storage/jobArtifacts";
import { exportRawStorageSnapshot } from "../storage/rawStorage";
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

export type JobDetail = JobStatus & {
  createdAt: string;
  createdAtEpoch: number;
  threadId: number;
  currentUrl: string | null;
  lastError: string | null;
  queuedUrls: CrawlerArtifactQueueEntry[];
  logs: CrawlerArtifactLogEntry[];
};

type FetchResult =
  | {
      ok: true;
      html: string;
      status: number;
    }
  | {
      ok: false;
      reason: "http_error" | "body_too_large" | "request_failed";
      status: number;
    };

export class CrawlerManager {
  private readonly pools = new Map<string, WorkerPool>();
  private readonly frontiers = new Map<string, FrontierQueue>();
  private readonly stoppingJobs = new Set<string>();
  private readonly fetchControllers = new Map<string, Set<AbortController>>();
  private readonly artifacts = new CrawlerArtifactsStore();

  constructor(
    private readonly db: Database<sqlite3.Database, sqlite3.Statement>,
    private readonly onJobUpdated?: (jobId: string) => void
  ) {}

  async startJob(originUrl: string, maxDepth: number): Promise<CrawlJob> {
    await this.artifacts.syncVisitedUrlsFromDb(this.db);

    const threadToken = threadId || process.pid;
    let createdAtEpoch = Date.now();
    let jobId = `${createdAtEpoch}_${threadToken}`;
    while (await this.db.get("SELECT id FROM crawl_jobs WHERE id = ?", jobId)) {
      createdAtEpoch += 1;
      jobId = `${createdAtEpoch}_${threadToken}`;
    }

    const now = new Date(createdAtEpoch).toISOString();

    await this.db.run(
      "INSERT INTO crawl_jobs (id, origin_url, max_depth, status, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)",
      jobId,
      originUrl,
      maxDepth,
      now,
      now
    );

    await this.artifacts.initializeJob({
      jobId,
      originUrl,
      maxDepth,
      createdAt: now,
      createdAtEpoch,
      threadId: threadToken
    });

    const frontier = new FrontierQueue(jobId, this.db, config.maxQueue);
    await frontier.init();
    await frontier.enqueue(originUrl, 0);

    this.frontiers.set(jobId, frontier);
    await this.artifacts.updateJob(this.db, jobId, {
      log: this.createArtifactLog("info", "Seed URL queued", {
        url: originUrl,
        depth: 0
      })
    });
    this.startPool(jobId, frontier, originUrl, maxDepth);

    return { id: jobId, originUrl, maxDepth };
  }

  async resumeIncompleteJobs() {
    await this.artifacts.syncVisitedUrlsFromDb(this.db);

    await this.db.run(
      "UPDATE frontier SET status = 'pending' WHERE status = 'processing'"
    );

    const stoppingJobs = await this.db.all<{
      id: string;
      origin_url: string;
      max_depth: number;
      created_at: string;
    }[]>(
      "SELECT id, origin_url, max_depth, created_at FROM crawl_jobs WHERE status = 'stopping'"
    );

    for (const job of stoppingJobs) {
      await this.initializeArtifactsForExistingJob(
        job.id,
        job.origin_url,
        job.max_depth,
        job.created_at
      );
      const frontier = new FrontierQueue(job.id, this.db, config.maxQueue);
      await frontier.init();
      await frontier.markStopped();
      await this.db.run(
        "UPDATE crawl_jobs SET status = 'stopped', queued_count = 0, active_workers = 0, updated_at = ? WHERE id = ?",
        new Date().toISOString(),
        job.id
      );
      await this.artifacts.updateJob(this.db, job.id, {
        status: "stopped",
        queuedCount: 0,
        activeWorkers: 0,
        currentUrl: null,
        log: this.createArtifactLog("info", "Crawler job recovered in stopped state after restart")
      });
      this.onJobUpdated?.(job.id);
    }

    const jobs = await this.db.all<{
      id: string;
      origin_url: string;
      max_depth: number;
      created_at: string;
    }[]>(
      "SELECT id, origin_url, max_depth, created_at FROM crawl_jobs WHERE status = 'running'"
    );

    for (const job of jobs) {
      await this.initializeArtifactsForExistingJob(
        job.id,
        job.origin_url,
        job.max_depth,
        job.created_at
      );
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

  async getJobDetail(jobId: string): Promise<JobDetail | null> {
    const job = await this.getJob(jobId);
    if (!job) {
      return null;
    }

    const artifact = await this.artifacts.getJob(jobId);
    const match = /^(\d+)_(\d+)$/.exec(jobId);
    const createdAtEpoch = artifact?.createdAtEpoch
      ?? (match ? Number.parseInt(match[1], 10) : Date.parse(job.updatedAt));
    const parsedThreadId = artifact?.threadId
      ?? (match ? Number.parseInt(match[2], 10) : 0);

    return {
      ...job,
      createdAt: artifact?.createdAt ?? job.updatedAt,
      createdAtEpoch: Number.isNaN(createdAtEpoch) ? Date.now() : createdAtEpoch,
      threadId: parsedThreadId,
      currentUrl: artifact?.currentUrl ?? null,
      lastError: artifact?.lastError ?? null,
      queuedUrls: artifact?.queuedUrls ?? [],
      logs: artifact?.logs ?? []
    };
  }

  async stopJob(jobId: string): Promise<JobStatus | null> {
    const job = await this.getJob(jobId);
    if (!job) {
      return null;
    }

    if (job.status === "completed" || job.status === "stopped") {
      return job;
    }

    await this.requestStop(jobId);
    await this.waitForJobToSettle(jobId);
    await this.finalizeStop(jobId);
    return this.getJob(jobId);
  }

  async deleteJob(jobId: string): Promise<boolean> {
    const job = await this.getJob(jobId);
    if (!job) {
      return false;
    }

    if (job.status !== "completed" && job.status !== "stopped") {
      await this.requestStop(jobId);
      await this.waitForJobToSettle(jobId);
      await this.finalizeStop(jobId);
    } else {
      this.cleanupJobRuntime(jobId);
    }

    await this.db.exec("BEGIN TRANSACTION;");
    try {
      await this.db.run("DELETE FROM page_terms WHERE job_id = ?", jobId);
      await this.db.run("DELETE FROM job_pages WHERE job_id = ?", jobId);
      await this.db.run("DELETE FROM frontier WHERE job_id = ?", jobId);
      await this.db.run("DELETE FROM crawl_jobs WHERE id = ?", jobId);
      await this.db.run("DELETE FROM pages WHERE id NOT IN (SELECT DISTINCT page_id FROM job_pages)");
      await this.db.run("DELETE FROM terms WHERE id NOT IN (SELECT DISTINCT term_id FROM page_terms)");
      await this.db.exec("COMMIT;");
    } catch (error) {
      await this.db.exec("ROLLBACK;");
      throw error;
    }

    this.cleanupJobRuntime(jobId);
    await this.refreshRawStorageSnapshot();
    await this.artifacts.removeJob(jobId);
    this.onJobUpdated?.(jobId);
    return true;
  }

  stopAll() {
    for (const pool of this.pools.values()) {
      pool.stop();
    }
    this.pools.clear();
    this.frontiers.clear();
    this.stoppingJobs.clear();
    this.abortAllFetches();
    this.fetchControllers.clear();
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
      await this.artifacts.updateJob(this.db, jobId, {
        currentUrl: item.url,
        lastError: null,
        log: this.createArtifactLog("info", "Processing URL", {
          url: item.url,
          depth: item.depth
        })
      });

      if (this.isStopRequested(jobId)) {
        await frontier.markFailed(item.id, "stopped");
        await this.artifacts.updateJob(this.db, jobId, {
          currentUrl: null,
          log: this.createArtifactLog("info", "Skipped queued URL because stop was requested", {
            url: item.url
          })
        });
        return;
      }

      if (item.depth > maxDepth) {
        await frontier.markDone(item.id);
        await this.artifacts.updateJob(this.db, jobId, {
          currentUrl: null,
          log: this.createArtifactLog("info", "Skipped URL beyond max depth", {
            url: item.url,
            depth: item.depth,
            maxDepth
          })
        });
        return;
      }

      const pageRow = await this.db.get<{ id: number; fetched_at: string | null }>(
        "SELECT id, fetched_at FROM pages WHERE url = ?",
        item.url
      );
      const alreadyVisited = await this.artifacts.hasVisitedUrl(item.url);

      if (pageRow?.fetched_at) {
        if (!alreadyVisited) {
          await this.artifacts.markVisitedUrl(item.url);
        }
        await this.insertJobPage(jobId, pageRow.id, originUrl, item.depth);
        await this.copyIndexedTermsToJob(jobId, pageRow.id);
        await this.refreshRawStorageSnapshot();
        await frontier.markDone(item.id);
        await this.incrementProcessed(jobId);
        await this.artifacts.updateJob(this.db, jobId, {
          currentUrl: null,
          log: this.createArtifactLog("info", "Reused previously visited page", {
            url: item.url,
            depth: item.depth
          })
        });
        return;
      }

      const fetched = await this.fetchPage(jobId, item.url);
      if (!fetched.ok) {
        if (this.isStopRequested(jobId)) {
          await frontier.markFailed(item.id, "stopped");
          await this.artifacts.updateJob(this.db, jobId, {
            currentUrl: null,
            log: this.createArtifactLog("info", "Stopped while fetching URL", {
              url: item.url
            })
          });
          return;
        }
        await frontier.markFailed(item.id, "fetch_failed");
        await this.incrementError(jobId);
        await this.artifacts.updateJob(this.db, jobId, {
          currentUrl: null,
          lastError: fetched.reason,
          log: this.createArtifactLog("error", "Fetch failed", {
            url: item.url,
            status: fetched.status,
            reason: fetched.reason
          })
        });
        return;
      }

      const parsed = parseHtml(fetched.html, item.url);
      const pageId = await this.upsertPage(item.url, parsed.title);
      await this.artifacts.markVisitedUrl(item.url);

      await this.insertJobPage(jobId, pageId, originUrl, item.depth);
      await this.indexTerms(jobId, pageId, parsed.termCounts);
      await this.refreshRawStorageSnapshot();

      let enqueuedChildren = 0;
      if (!this.isStopRequested(jobId) && item.depth < maxDepth) {
        for (const link of parsed.links) {
          const normalized = normalizeUrl(link);
          if (!normalized) {
            continue;
          }
          const childDepth = item.depth + 1;
          await this.ensurePageRow(normalized);
          await this.insertJobPageByUrl(jobId, normalized, originUrl, childDepth);
          const enqueued = await frontier.enqueue(normalized, childDepth);
          if (enqueued) {
            enqueuedChildren += 1;
          }
        }
      }

      await frontier.markDone(item.id);
      await this.incrementProcessed(jobId);
      await this.artifacts.updateJob(this.db, jobId, {
        currentUrl: null,
        log: this.createArtifactLog("info", "Fetched and indexed page", {
          url: item.url,
          status: fetched.status,
          depth: item.depth,
          uniqueTerms: parsed.termCounts.size,
          discoveredLinks: parsed.links.length,
          queuedChildren: enqueuedChildren
        })
      });
    } catch (error) {
      if (this.isStopRequested(jobId)) {
        await frontier.markFailed(item.id, "stopped");
        await this.artifacts.updateJob(this.db, jobId, {
          currentUrl: null,
          log: this.createArtifactLog("info", "Stopped while processing URL", {
            url: item.url
          })
        });
        return;
      }
      await frontier.markFailed(item.id, "exception");
      await this.incrementError(jobId);
      const message = error instanceof Error ? error.message : "Unexpected crawler exception";
      await this.artifacts.updateJob(this.db, jobId, {
        currentUrl: null,
        lastError: message,
        log: this.createArtifactLog("error", "Unhandled crawler exception", {
          url: item.url,
          message
        })
      });
    } finally {
      await this.updateJobStats(jobId, frontier, this.pools.get(jobId));
    }
  }

  private async refreshRawStorageSnapshot() {
    await exportRawStorageSnapshot(
      this.db,
      config.rawStoragePath,
      config.rawStorageJobId || undefined
    );
  }

  private async fetchPage(jobId: string, url: string): Promise<FetchResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    this.registerFetchController(jobId, controller);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": config.userAgent
        }
      });
      const status = typeof response.status === "number" ? response.status : (response.ok ? 200 : 0);

      if (!response.ok) {
        return {
          ok: false,
          status,
          reason: "http_error"
        };
      }

      const text = await response.text();
      if (text.length > config.maxBodyBytes) {
        return {
          ok: false,
          status,
          reason: "body_too_large"
        };
      }

      return {
        ok: true,
        html: text,
        status
      };
    } catch {
      return {
        ok: false,
        status: 0,
        reason: "request_failed"
      };
    } finally {
      clearTimeout(timeout);
      this.unregisterFetchController(jobId, controller);
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

  private async copyIndexedTermsToJob(jobId: string, pageId: number) {
    await this.db.run(
      `
        INSERT INTO page_terms (job_id, page_id, term_id, frequency)
        SELECT ?, ?, pt.term_id, MAX(pt.frequency)
        FROM page_terms pt
        WHERE pt.page_id = ?
        GROUP BY pt.term_id
        ON CONFLICT(job_id, page_id, term_id) DO UPDATE SET frequency = excluded.frequency
      `,
      jobId,
      pageId,
      pageId
    );
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
    const existing = await this.db.get<{ status: string }>(
      "SELECT status FROM crawl_jobs WHERE id = ?",
      jobId
    );
    if (!existing) {
      this.cleanupJobRuntime(jobId);
      return;
    }

    const queuedCount = frontier.getQueueDepth();
    const activeWorkers = pool ? pool.getActiveCount() : 0;
    let status = queuedCount === 0 && activeWorkers === 0 ? "completed" : "running";

    if (existing.status === "stopping" || this.stoppingJobs.has(jobId)) {
      status = activeWorkers === 0 ? "stopped" : "stopping";
    } else if (existing.status === "stopped") {
      status = "stopped";
    }

    await this.db.run(
      "UPDATE crawl_jobs SET queued_count = ?, active_workers = ?, status = ?, updated_at = ? WHERE id = ?",
      queuedCount,
      activeWorkers,
      status,
      new Date().toISOString(),
      jobId
    );

    await this.artifacts.updateJob(this.db, jobId, {
      status,
      queuedCount,
      activeWorkers,
      currentUrl: status === "completed" || status === "stopped" ? null : undefined,
      log: status !== existing.status
        ? this.createArtifactLog(
            "info",
            status === "completed" ? "Crawler job completed"
              : status === "stopped" ? "Crawler job stopped"
                : status === "stopping" ? "Crawler job stopping"
                  : "Crawler job running"
          )
        : undefined
    });

    if (status === "completed") {
      this.cleanupJobRuntime(jobId);
    }

    this.onJobUpdated?.(jobId);
  }

  private isStopRequested(jobId: string) {
    return this.stoppingJobs.has(jobId);
  }

  private async requestStop(jobId: string) {
    this.stoppingJobs.add(jobId);
    this.pools.get(jobId)?.stop();
    this.abortFetchesForJob(jobId);

    const frontier = this.frontiers.get(jobId);
    const pool = this.pools.get(jobId);
    const queuedCount = frontier ? frontier.getQueueDepth() : 0;
    const activeWorkers = pool ? pool.getActiveCount() : 0;

    await this.db.run(
      "UPDATE crawl_jobs SET status = 'stopping', queued_count = ?, active_workers = ?, updated_at = ? WHERE id = ?",
      queuedCount,
      activeWorkers,
      new Date().toISOString(),
      jobId
    );

    await this.artifacts.updateJob(this.db, jobId, {
      status: "stopping",
      queuedCount,
      activeWorkers,
      log: this.createArtifactLog("info", "Stop requested for crawler job")
    });

    this.onJobUpdated?.(jobId);
  }

  private async waitForJobToSettle(jobId: string) {
    const deadline = Date.now() + Math.max(config.requestTimeoutMs, 1000) + 1000;

    while (Date.now() < deadline) {
      const pool = this.pools.get(jobId);
      if (!pool || pool.getActiveCount() === 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private async finalizeStop(jobId: string) {
    const job = await this.getJob(jobId);
    if (!job) {
      this.cleanupJobRuntime(jobId);
      return;
    }

    const pool = this.pools.get(jobId);
    const frontier = this.frontiers.get(jobId);
    const activeWorkers = pool ? pool.getActiveCount() : 0;
    if (frontier && activeWorkers === 0) {
      await frontier.markStopped();
    }
    const queuedCount = frontier ? frontier.getQueueDepth() : job.queuedCount;
    const status = activeWorkers === 0 ? "stopped" : "stopping";

    await this.db.run(
      "UPDATE crawl_jobs SET status = ?, queued_count = ?, active_workers = ?, updated_at = ? WHERE id = ?",
      status,
      queuedCount,
      activeWorkers,
      new Date().toISOString(),
      jobId
    );

    await this.artifacts.updateJob(this.db, jobId, {
      status,
      queuedCount,
      activeWorkers,
      currentUrl: status === "stopped" ? null : undefined,
      log: status === "stopped" && job.status !== "stopped"
        ? this.createArtifactLog("info", "Crawler job stopped")
        : undefined
    });

    if (status === "stopped") {
      this.cleanupJobRuntime(jobId);
    }

    this.onJobUpdated?.(jobId);
  }

  private cleanupJobRuntime(jobId: string) {
    this.pools.get(jobId)?.stop();
    this.pools.delete(jobId);
    this.frontiers.delete(jobId);
    this.abortFetchesForJob(jobId);
    this.fetchControllers.delete(jobId);
    this.stoppingJobs.delete(jobId);
  }

  private registerFetchController(jobId: string, controller: AbortController) {
    let controllers = this.fetchControllers.get(jobId);
    if (!controllers) {
      controllers = new Set<AbortController>();
      this.fetchControllers.set(jobId, controllers);
    }
    controllers.add(controller);
  }

  private unregisterFetchController(jobId: string, controller: AbortController) {
    const controllers = this.fetchControllers.get(jobId);
    if (!controllers) {
      return;
    }

    controllers.delete(controller);
    if (controllers.size === 0) {
      this.fetchControllers.delete(jobId);
    }
  }

  private abortFetchesForJob(jobId: string) {
    const controllers = this.fetchControllers.get(jobId);
    if (!controllers) {
      return;
    }

    for (const controller of controllers) {
      controller.abort();
    }
  }

  private abortAllFetches() {
    for (const jobId of this.fetchControllers.keys()) {
      this.abortFetchesForJob(jobId);
    }
  }

  private async initializeArtifactsForExistingJob(
    jobId: string,
    originUrl: string,
    maxDepth: number,
    createdAt: string
  ) {
    const match = /^(\d+)_(\d+)$/.exec(jobId);
    const createdAtEpoch = match ? Number.parseInt(match[1], 10) : Date.parse(createdAt);
    const parsedThreadId = match ? Number.parseInt(match[2], 10) : 0;

    await this.artifacts.initializeJob({
      jobId,
      originUrl,
      maxDepth,
      createdAt,
      createdAtEpoch: Number.isNaN(createdAtEpoch) ? Date.now() : createdAtEpoch,
      threadId: parsedThreadId || threadId || process.pid
    });
  }

  private createArtifactLog(
    level: "info" | "error",
    message: string,
    data?: Record<string, unknown>
  ) {
    return {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...(data ? { data } : {})
    };
  }
}
