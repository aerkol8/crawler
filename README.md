# Web Crawler and Search (Local)

This project provides a local web crawler and real-time search system for localhost use. It indexes from an origin URL to a maximum depth, supports searching while indexing is active, and exposes a live dashboard for crawl status, queue depth, and backpressure visibility.

## Quick Start

1) Install dependencies.
2) Run the server in dev mode.
3) Open the UI and create a crawl job.

## Commands

- npm install
- npm run dev
- npm run build
- npm start

## Features

- Crawl with depth limit and global de-duplication.
- Backpressure via max queue depth and max concurrent fetches.
- Low-level HTML parsing and link extraction without full-featured crawler/search frameworks.
- Explicit async-mutex coordination for worker/frontier state updates under concurrent activity.
- Search while indexing is active and returns all matching URL/origin/depth triples.
- Live dashboard updates over Server-Sent Events for job status, queue depth, processed count, and throttling state.
- Live search updates over Server-Sent Events so results refresh as the index grows.
- Resume incomplete crawl jobs after restart, with automated verification for pending-frontier recovery.

## Configuration

Environment variables:

- PORT: HTTP port (default 3000)
- DB_PATH: SQLite database file (default ./crawler.db)
- MAX_QUEUE: maximum queued URLs per job (default 2000)
- MAX_CONCURRENT: maximum concurrent fetches (default 6)
- RATE_PER_SEC: maximum fetches per second (default 2)
- REQUEST_TIMEOUT_MS: per-request timeout in milliseconds (default 10000)
- USER_AGENT: crawler user agent string
