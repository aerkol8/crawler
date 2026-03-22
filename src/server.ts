import express from "express";
import { config } from "./config";
import { getDb } from "./db";
import { CrawlerManager } from "./crawler/manager";
import { SearchService } from "./search/searchService";
import { renderHome, renderSearch, renderStatus } from "./ui/templates";

async function main() {
  const db = await getDb();
  const manager = new CrawlerManager(db);
  const searchService = new SearchService(db);

  await manager.resumeIncompleteJobs();

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

  app.get("/status", async (_req, res) => {
    const jobs = await manager.listJobs();
    res.json(jobs);
  });

  app.get("/status/:jobId", async (req, res) => {
    const job = await manager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).send("Not found");
      return;
    }
    res.send(renderStatus(job, config.maxQueue));
  });

  app.get("/search", async (req, res) => {
    const query = String(req.query.query ?? "").trim();
    const results = query ? await searchService.search(query) : [];
    res.send(renderSearch(query, results));
  });

  app.get("/api/search", async (req, res) => {
    const query = String(req.query.query ?? "").trim();
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
    const job = await manager.getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(job);
  });

  app.listen(config.port, () => {
    console.log(`Server listening on ${config.port}`);
  });
}

void main();
