# Web Crawler and Search (Local)

This project is a localhost web crawler and real-time search engine built for the ITU "Google in a day" systems exercise. It indexes from an origin URL to a maximum depth, supports searching while indexing is active, and exposes a live dashboard for crawl status, queue depth, and backpressure visibility.

The implementation is intentionally biased toward simple, inspectable building blocks instead of full crawler frameworks. Crawling uses native `fetch`, HTML parsing uses low-level string/regex extraction, frontier coordination is backed by SQLite plus explicit async mutexes, and live UI updates are delivered through Server-Sent Events.

## Quick Start

1. Install dependencies with `npm install`.
2. Start the app with `npm run dev`.
3. Open `http://localhost:3000`.
4. Create a crawl job, watch status update live, and run searches while indexing is still active.

## Commands

- npm install
- npm run dev
- npm run build
- npm start
- npm test

## Features

- Crawl with depth limit and global de-duplication.
- Backpressure via max queue depth and max concurrent fetches.
- Low-level HTML parsing and link extraction without full-featured crawler/search frameworks.
- Explicit async-mutex coordination for worker/frontier state updates under concurrent activity.
- Search while indexing is active and returns all matching URL/origin/depth triples.
- Live dashboard updates over Server-Sent Events for job status, queue depth, processed count, and throttling state.
- Live search updates over Server-Sent Events so results refresh as the index grows.
- Resume incomplete crawl jobs after restart, with automated verification for pending-frontier recovery.

## Architecture

- `CrawlerManager` owns crawl jobs, persistence updates, and job lifecycle transitions.
- `FrontierQueue` stores crawl frontier state in SQLite and keeps a bounded in-memory working set for efficient dequeue.
- `WorkerPool` enforces concurrency and rate limits while coordinating worker execution safely.
- `SearchService` queries the live index and returns triples in the form `(relevant_url, origin_url, depth)`.
- `UpdateBus` fans job updates into SSE streams for the dashboard and live search pages.

## UI Surface

- `/` starts crawl jobs, shows recent jobs, and displays live queue/backpressure state.
- `/status/:jobId` shows a live job dashboard with status, queued URLs, processed URLs, active workers, errors, and updated time.
- `/search?query=...` shows live search results while indexing is active.
- `/api/index`, `/api/status/:jobId`, and `/api/search` provide JSON endpoints.
- `/events/jobs`, `/events/job/:jobId`, and `/events/search` provide SSE event streams.

## Relevance Model

- Terms are tokenized from visible page text.
- Search ranks results by summed keyword frequency.
- Results are returned as `(relevant_url, origin_url, depth)` triples.

## Verification

- `npm test` runs crawler, parser, concurrency, resume, and UI rendering checks.
- `npm run build` validates the TypeScript build.

## Configuration

Environment variables:

- PORT: HTTP port (default 3000)
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
