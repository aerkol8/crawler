# Web Crawler and Search (Local)

This project provides a local web crawler and search system with a minimal web UI. It supports indexing a site from an origin URL to a maximum depth, and searching the indexed pages while crawling is active.

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
- Search while indexing is active.
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
