import express from "express";
import type { Request, Response } from "express";
import { config } from "./config";
import { getDb } from "./db";
import { CrawlerManager } from "./crawler/manager";
import { SearchService } from "./search/searchService";
import { UpdateBus } from "./live/updateBus";
import { exportRawStorageSnapshot, searchRawStorage } from "./storage/rawStorage";
import { renderHome, renderSearch, renderStatus } from "./ui/templates";

function initializeEventStream(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

function writeEvent(res: Response, eventName: string, payload: unknown) {
  res.write(`event: ${eventName}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function attachHeartbeat(res: Response) {
  return setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);
}

function resolveRedirectPath(req: Request, fallback: string) {
  const candidate = String(req.body?.redirectTo || req.get("referer") || fallback);
  return candidate.startsWith("/") ? candidate : fallback;
}

function createSerializedSender<T>(send: (payload?: T) => Promise<void>) {
  let chain = Promise.resolve();
  return (payload?: T) => {
    chain = chain.then(() => send(payload)).catch(() => {
      // Keep the connection open for later updates if a single send fails.
    });
  };
}

async function main() {
  const db = await getDb();
  const updateBus = new UpdateBus();
  const manager = new CrawlerManager(db, (jobId) => updateBus.publishJob(jobId));
  const searchService = new SearchService(config.rawStoragePath);

  await manager.resumeIncompleteJobs();
  await exportRawStorageSnapshot(db, config.rawStoragePath, config.rawStorageJobId || undefined);

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.get("/", async (_req, res) => {
    const jobs = await manager.listJobs();
    res.send(renderHome(jobs, config.maxQueue));
  });

  app.post("/index", async (req, res) => {
    const origin = String(req.body.origin || "").trim();
    const maxDepth = Number.parseInt(String(req.body.maxDepth ?? "2"), 10);

    if (!origin || Number.isNaN(maxDepth)) {
      res.status(400).send("Invalid input");
      return;
    }

    const job = await manager.startJob(origin, maxDepth);
    res.redirect(`/status/${job.id}`);
  });

  app.post("/jobs/:jobId/stop", async (req, res) => {
    const job = await manager.stopJob(req.params.jobId);
    if (!job) {
      res.status(404).send("Not found");
      return;
    }
    res.redirect(resolveRedirectPath(req, `/status/${job.id}`));
  });

  app.post("/jobs/:jobId/delete", async (req, res) => {
    const deleted = await manager.deleteJob(req.params.jobId);
    if (!deleted) {
      res.status(404).send("Not found");
      return;
    }
    res.redirect(resolveRedirectPath(req, "/"));
  });

  app.get("/status", async (_req, res) => {
    const jobs = await manager.listJobs();
    res.json(jobs);
  });

  app.get("/status/:jobId", async (req, res) => {
    const job = await manager.getJobDetail(req.params.jobId);
    if (!job) {
      res.status(404).send("Not found");
      return;
    }
    res.send(renderStatus(job, config.maxQueue));
  });

  app.get("/search", async (req, res) => {
    const query = String(req.query.query ?? "").trim();
    const sortBy = String(req.query.sortBy ?? "").trim();

    if (sortBy) {
      if (sortBy !== "relevance") {
        res.status(400).json({ error: "Unsupported sortBy" });
        return;
      }

      const results = query ? await searchRawStorage(config.rawStoragePath, query) : [];
      res.json(results);
      return;
    }

    const results = query ? await searchService.search(query) : [];
    res.send(renderSearch(query, results));
  });

  app.get("/api/search", async (req, res) => {
    const query = String(req.query.query ?? "").trim();
    const sortBy = String(req.query.sortBy ?? "").trim();

    if (sortBy) {
      if (sortBy !== "relevance") {
        res.status(400).json({ error: "Unsupported sortBy" });
        return;
      }

      const results = query ? await searchRawStorage(config.rawStoragePath, query) : [];
      res.json(results);
      return;
    }

    const results = query ? await searchService.search(query) : [];
    res.json(results);
  });

  app.post("/api/index", async (req, res) => {
    const origin = String(req.body.origin || "").trim();
    const maxDepth = Number.parseInt(String(req.body.maxDepth ?? "2"), 10);

    if (!origin || Number.isNaN(maxDepth)) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }

    const job = await manager.startJob(origin, maxDepth);
    res.json(job);
  });

  app.get("/api/status/:jobId", async (req, res) => {
    const job = await manager.getJobDetail(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(job);
  });

  app.post("/api/jobs/:jobId/stop", async (req, res) => {
    const job = await manager.stopJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(job);
  });

  app.post("/api/jobs/:jobId/delete", async (req, res) => {
    const deleted = await manager.deleteJob(req.params.jobId);
    if (!deleted) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ ok: true });
  });

  app.get("/events/jobs", async (req: Request, res: Response) => {
    initializeEventStream(res);
    const heartbeat = attachHeartbeat(res);
    const sendJobs = createSerializedSender(async () => {
      const jobs = await manager.listJobs();
      writeEvent(res, "jobs", jobs);
    });

    sendJobs();
    const unsubscribe = updateBus.subscribe(() => {
      sendJobs();
    });

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  app.get("/events/job/:jobId", async (req: Request, res: Response) => {
    initializeEventStream(res);
    const { jobId } = req.params;
    const heartbeat = attachHeartbeat(res);
    const sendJob = createSerializedSender(async () => {
      const job = await manager.getJobDetail(jobId);
      if (job) {
        writeEvent(res, "job", job);
      }
    });

    sendJob();
    const unsubscribe = updateBus.subscribe((event) => {
      if (event.jobId === jobId) {
        sendJob();
      }
    });

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  app.get("/events/search", async (req: Request, res: Response) => {
    const query = String(req.query.query ?? "").trim();
    initializeEventStream(res);
    const heartbeat = attachHeartbeat(res);
    const sendResults = createSerializedSender(async () => {
      const results = query ? await searchService.search(query) : [];
      writeEvent(res, "results", results);
    });

    sendResults();
    const unsubscribe = updateBus.subscribe(() => {
      sendResults();
    });

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  });

  app.listen(config.port, () => {
    console.log(`Server listening on ${config.port}`);
  });
}

void main();
