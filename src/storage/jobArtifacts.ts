import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Database } from "sqlite";
import sqlite3 from "sqlite3";
import { config } from "../config";
import { AsyncMutex } from "../utils/asyncMutex";

type JobRow = {
  origin_url: string;
  max_depth: number;
  status: string;
  queued_count: number;
  processed_count: number;
  error_count: number;
  active_workers: number;
  created_at: string;
  updated_at: string;
};

export type CrawlerArtifactLogEntry = {
  timestamp: string;
  level: "info" | "error";
  message: string;
  data?: Record<string, unknown>;
};

export type CrawlerArtifactQueueEntry = {
  url: string;
  depth: number;
  status: string;
};

export type CrawlerArtifactState = {
  id: string;
  createdAt: string;
  createdAtEpoch: number;
  threadId: number;
  originUrl: string;
  maxDepth: number;
  status: string;
  queuedCount: number;
  processedCount: number;
  errorCount: number;
  activeWorkers: number;
  updatedAt: string;
  currentUrl: string | null;
  lastError: string | null;
  visitedUrlsPath: string;
  storagePath: string;
  queuedUrls: CrawlerArtifactQueueEntry[];
  logs: CrawlerArtifactLogEntry[];
};

type UpdateJobOptions = {
  status?: string;
  queuedCount?: number;
  processedCount?: number;
  errorCount?: number;
  activeWorkers?: number;
  updatedAt?: string;
  currentUrl?: string | null;
  lastError?: string | null;
  queuedUrls?: CrawlerArtifactQueueEntry[];
  log?: CrawlerArtifactLogEntry;
};

export class CrawlerArtifactsStore {
  private readonly mutex = new AsyncMutex();
  private visitedLoaded = false;
  private visitedUrls = new Set<string>();

  constructor(
    private readonly jobsPath = config.crawlerJobDataPath,
    private readonly visitedUrlsPath = config.visitedUrlsPath,
    private readonly storagePath = config.rawStoragePath
  ) {}

  async initializeJob(params: {
    jobId: string;
    originUrl: string;
    maxDepth: number;
    createdAt: string;
    createdAtEpoch: number;
    threadId: number;
  }) {
    await this.mutex.runExclusive(async () => {
      await this.ensurePaths();
      const existing = await this.readJobState(params.jobId);
      if (existing) {
        return;
      }

      const state: CrawlerArtifactState = {
        id: params.jobId,
        createdAt: params.createdAt,
        createdAtEpoch: params.createdAtEpoch,
        threadId: params.threadId,
        originUrl: params.originUrl,
        maxDepth: params.maxDepth,
        status: "running",
        queuedCount: 0,
        processedCount: 0,
        errorCount: 0,
        activeWorkers: 0,
        updatedAt: params.createdAt,
        currentUrl: null,
        lastError: null,
        visitedUrlsPath: this.visitedUrlsPath,
        storagePath: this.storagePath,
        queuedUrls: [],
        logs: [
          {
            timestamp: params.createdAt,
            level: "info",
            message: "Crawler job created"
          }
        ]
      };

      await this.writeJobState(params.jobId, state);
    });
  }

  async updateJob(
    db: Database<sqlite3.Database, sqlite3.Statement>,
    jobId: string,
    options: UpdateJobOptions = {}
  ) {
    await this.mutex.runExclusive(async () => {
      await this.ensurePaths();
      const existing = await this.readJobState(jobId);
      if (!existing) {
        return;
      }

      const row = await db.get<JobRow>(
        `
          SELECT origin_url,
                 max_depth,
                 status,
                 queued_count,
                 processed_count,
                 error_count,
                 active_workers,
                 created_at,
                 updated_at
          FROM crawl_jobs
          WHERE id = ?
        `,
        jobId
      );

      const queuedUrls = options.queuedUrls ?? (row ? await this.loadQueuedUrls(db, jobId) : existing.queuedUrls);
      const hasCurrentUrl = Object.prototype.hasOwnProperty.call(options, "currentUrl");
      const hasLastError = Object.prototype.hasOwnProperty.call(options, "lastError");

      const next: CrawlerArtifactState = {
        ...existing,
        originUrl: row?.origin_url ?? existing.originUrl,
        maxDepth: row?.max_depth ?? existing.maxDepth,
        status: options.status ?? row?.status ?? existing.status,
        queuedCount: options.queuedCount ?? row?.queued_count ?? queuedUrls.length,
        processedCount: options.processedCount ?? row?.processed_count ?? existing.processedCount,
        errorCount: options.errorCount ?? row?.error_count ?? existing.errorCount,
        activeWorkers: options.activeWorkers ?? row?.active_workers ?? existing.activeWorkers,
        updatedAt: options.updatedAt ?? row?.updated_at ?? new Date().toISOString(),
        currentUrl: hasCurrentUrl
          ? (options.currentUrl === undefined ? existing.currentUrl : options.currentUrl)
          : existing.currentUrl,
        lastError: hasLastError
          ? (options.lastError === undefined ? existing.lastError : options.lastError)
          : existing.lastError,
        queuedUrls,
        logs: options.log ? [...existing.logs, options.log] : existing.logs
      };

      await this.writeJobState(jobId, next);
    });
  }

  async hasVisitedUrl(url: string) {
    return this.mutex.runExclusive(async () => {
      await this.ensureVisitedUrlsLoaded();
      return this.visitedUrls.has(url);
    });
  }

  async markVisitedUrl(url: string) {
    await this.mutex.runExclusive(async () => {
      await this.ensureVisitedUrlsLoaded();
      if (this.visitedUrls.has(url)) {
        return;
      }

      await appendFile(this.visitedUrlsPath, `${url}\n`, "utf8");
      this.visitedUrls.add(url);
    });
  }

  async syncVisitedUrlsFromDb(db: Database<sqlite3.Database, sqlite3.Statement>) {
    await this.mutex.runExclusive(async () => {
      await this.ensurePaths();
      const rows = await db.all<{ url: string }[]>(
        "SELECT url FROM pages WHERE fetched_at IS NOT NULL ORDER BY url"
      );

      const contents = rows.map((row) => row.url).join("\n");
      await writeFile(this.visitedUrlsPath, contents ? `${contents}\n` : "", "utf8");
      this.visitedUrls = new Set(rows.map((row) => row.url));
      this.visitedLoaded = true;
    });
  }

  async removeJob(jobId: string) {
    await this.mutex.runExclusive(async () => {
      await rm(this.resolveJobPath(jobId), { force: true });
    });
  }

  async getJob(jobId: string) {
    return this.mutex.runExclusive(async () => {
      await this.ensurePaths();
      return this.readJobState(jobId);
    });
  }

  private async ensurePaths() {
    await mkdir(this.jobsPath, { recursive: true });
    await mkdir(dirname(this.visitedUrlsPath), { recursive: true });

    try {
      await readFile(this.visitedUrlsPath, "utf8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await writeFile(this.visitedUrlsPath, "", "utf8");
    }
  }

  private async ensureVisitedUrlsLoaded() {
    await this.ensurePaths();
    if (this.visitedLoaded) {
      return;
    }

    const contents = await readFile(this.visitedUrlsPath, "utf8");
    this.visitedUrls = new Set(
      contents
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    );
    this.visitedLoaded = true;
  }

  private async loadQueuedUrls(
    db: Database<sqlite3.Database, sqlite3.Statement>,
    jobId: string
  ): Promise<CrawlerArtifactQueueEntry[]> {
    return db.all<CrawlerArtifactQueueEntry[]>(
      `
        SELECT url, depth, status
        FROM frontier
        WHERE job_id = ? AND status IN ('pending', 'processing')
        ORDER BY id
      `,
      jobId
    );
  }

  private async readJobState(jobId: string) {
    try {
      const contents = await readFile(this.resolveJobPath(jobId), "utf8");
      return JSON.parse(contents) as CrawlerArtifactState;
    } catch (error: any) {
      if (error?.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async writeJobState(jobId: string, state: CrawlerArtifactState) {
    await writeFile(this.resolveJobPath(jobId), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  private resolveJobPath(jobId: string) {
    return join(this.jobsPath, `${jobId}.data`);
  }
}
