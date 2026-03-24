import { join } from "node:path";

const crawlerDataDir = process.env.CRAWLER_DATA_DIR ?? "./data";

export const config = {
  port: Number.parseInt(process.env.PORT ?? "3600", 10),
  dbPath: process.env.DB_PATH ?? "./crawler.db",
  crawlerDataDir,
  crawlerJobDataPath: process.env.CRAWLER_JOB_DATA_PATH ?? join(crawlerDataDir, "jobs"),
  visitedUrlsPath: process.env.VISITED_URLS_PATH ?? join(crawlerDataDir, "visited_urls.data"),
  maxQueue: Number.parseInt(process.env.MAX_QUEUE ?? "2000", 10),
  maxConcurrent: Number.parseInt(process.env.MAX_CONCURRENT ?? "6", 10),
  ratePerSec: Number.parseFloat(process.env.RATE_PER_SEC ?? "2"),
  requestTimeoutMs: Number.parseInt(process.env.REQUEST_TIMEOUT_MS ?? "10000", 10),
  userAgent: process.env.USER_AGENT ?? "LocalCrawler/0.1",
  maxBodyBytes: Number.parseInt(process.env.MAX_BODY_BYTES ?? "2000000", 10),
  rawStoragePath: process.env.RAW_STORAGE_PATH ?? "./data/storage",
  rawStorageJobId: process.env.RAW_STORAGE_JOB_ID ?? ""
};
