# Web Crawler and Search (Local)

This project is a localhost web crawler and real-time search engine built for the ITU "Google in a day" systems exercise. It indexes from an origin URL to a maximum depth, supports searching while indexing is active, and exposes a live dashboard for crawl status, queue depth, and backpressure visibility.

The implementation is intentionally biased toward simple, inspectable building blocks instead of full crawler frameworks. Crawling uses native `fetch`, HTML parsing uses low-level string/regex extraction, frontier coordination is backed by SQLite plus explicit async mutexes, and live UI updates are delivered through Server-Sent Events.

## Submission Summary

- Localhost runnable with a local SQLite database.
- Includes `index`, `search`, live system visibility, and backpressure controls.
- Supports searching while indexing is active.
- Includes interruption recovery as a bonus capability.
- Submission artifacts are included in this repository:
  - `README.md`
  - `product_prd.md`
  - `recommendation.md`

## Quick Start

1. Install dependencies with `npm install`.
2. Start the app with `npm run dev`.
3. Open `http://localhost:3600`.
4. Create a crawl job, watch status update live, and run searches while indexing is still active.

## Commands

- npm install
- npm run dev
- npm run build
- npm start
- npm test
- npm run export:storage

## Features

- Crawl with depth limit and global de-duplication.
- Backpressure via max queue depth and max concurrent fetches.
- Low-level HTML parsing and link extraction without full-featured crawler/search frameworks.
- Explicit async-mutex coordination for worker/frontier state updates under concurrent activity.
- Search while indexing is active and returns all matching URL/origin/depth triples.
- Live dashboard updates over Server-Sent Events for job status, queue depth, processed count, and throttling state.
- Live search updates over Server-Sent Events so results refresh as the index grows.
- Resume incomplete crawl jobs after restart, with automated verification for pending-frontier recovery.
- Each crawl also writes a spec-style JSON artifact at `data/jobs/[epoch_threadId].data`, including logs and the queued URL snapshot.
- A shared `data/visited_urls.data` file mirrors already fetched pages so duplicate URLs can be skipped across jobs.
- Filesystem term buckets are exported under `data/storage`, for example `data/storage/p.data` for words starting with `p`.
- Compatibility search route at `GET /search?query=<word>&sortBy=relevance` with `relevance_score`.

## Architecture

- `CrawlerManager` owns crawl jobs, persistence updates, and job lifecycle transitions.
- `CrawlerArtifactsStore` mirrors job state into filesystem `.data` artifacts and maintains `visited_urls.data`.
- `FrontierQueue` stores crawl frontier state in SQLite and keeps a bounded in-memory working set for efficient dequeue.
- `WorkerPool` enforces concurrency and rate limits while coordinating worker execution safely.
- `SearchService` queries the live index and returns triples in the form `(relevant_url, origin_url, depth)`.
- `UpdateBus` fans job updates into SSE streams for the dashboard and live search pages.

## UI Surface

- `/` starts crawl jobs, shows recent jobs, and displays live queue/backpressure state.
- `/status/:jobId` shows a live job dashboard with status, queued URLs, processed URLs, active workers, errors, and updated time.
- `/search?query=...` shows live search results while indexing is active.
- `/search?query=...&sortBy=relevance` returns question-compatible JSON from the matching initial-letter bucket files under `data/storage`.
- `/api/index`, `/api/status/:jobId`, and `/api/search` provide JSON endpoints.
- `/events/jobs`, `/events/job/:jobId`, and `/events/search` provide SSE event streams.

## Question Compatibility

- The repository includes a sample raw storage bucket at `data/storage/p.data`.
- Crawl job IDs are emitted in `[EpochTimeCreated_ThreadID]` style, for example `1742852390123_91234`.
- Each job writes `data/jobs/[crawlerId].data` with status, logs, and the current queue snapshot.
- The compatibility search API returns JSON results with `relevant_url`, `origin_url`, `depth`, `matched_frequency`, and `relevance_score`.
- The compatibility scoring formula is:
  - `(frequency * 10) + 1000 - (depth * 5)` for exact single-word matches.
- Regenerate the raw storage bucket files with `npm run export:storage`.

## Relevance Model

- Terms are tokenized from visible page text.
- Search ranks results by summed keyword frequency.
- Results are returned as `(relevant_url, origin_url, depth)` triples.

## Verification

- `npm test` runs crawler, parser, concurrency, resume, and UI rendering checks.
- `npm run build` validates the TypeScript build.

## Configuration

Environment variables:

- PORT: HTTP port (default 3600)
- CRAWLER_DATA_DIR: base directory for crawler artifacts (default `./data`)
- CRAWLER_JOB_DATA_PATH: crawler job artifact directory (default `./data/jobs`)
- VISITED_URLS_PATH: newline-delimited visited URL snapshot (default `./data/visited_urls.data`)
- RAW_STORAGE_PATH: raw storage export directory for question-compatible search (default `./data/storage`)
- RAW_STORAGE_JOB_ID: optional job ID to export into the raw storage snapshot
- DB_PATH: SQLite database file (default ./crawler.db)
- MAX_QUEUE: maximum queued URLs per job (default 2000)
- MAX_CONCURRENT: maximum concurrent fetches (default 6)
- RATE_PER_SEC: maximum fetches per second (default 2)
- REQUEST_TIMEOUT_MS: per-request timeout in milliseconds (default 10000)
- USER_AGENT: crawler user agent string
- MAX_BODY_BYTES: maximum response body size accepted for indexing (default 2000000)

## Assumptions And Limits

- This is a single-machine localhost system, not a distributed crawler.
- Only HTML pages are parsed.
- Politeness is modeled as global rate limiting rather than per-host scheduling.
- Relevance is intentionally simple and based on term frequency rather than advanced ranking.
