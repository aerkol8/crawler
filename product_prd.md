# Product Requirements Document

## Goal
Build a local web crawler and real-time search system that can index pages from a starting URL up to a depth limit, provide search results while indexing is still active, and surface crawl state through a live dashboard.

## Success Criteria

- Crawl accurately from an origin URL up to depth `k`.
- Never crawl the same URL twice within the indexed corpus.
- Apply controlled backpressure through queue depth, concurrency, and request-rate limits.
- Return search results as `(relevant_url, origin_url, depth)` triples.
- Show system state in real time while crawling is active.
- Keep the design understandable enough that a reviewer can explain the concurrency and storage model.

## Users
- Developer evaluating crawler/search behavior.
- Reviewer validating system architecture and data flow.

## Functional Requirements
- Index endpoint accepts origin URL and depth k.
- Crawl up to depth k without crawling the same page twice.
- Search endpoint accepts a query string and returns triples: (relevant_url, origin_url, depth).
- Search reflects new results while indexing is active.
- UI allows starting jobs, viewing status, and running searches.
- Dashboard refreshes in real time and shows processed URLs, queued URLs, active workers, and backpressure status.
- Local persistence via SQLite; resume after interruption.

## Concrete Implementation Plan

### Phase 1: Requirements Expansion
- Translate the assignment into explicit crawl, search, UI, persistence, and verification requirements.
- Make simple assumptions about relevancy, crawl politeness, and single-machine scale.

### Phase 2: Architecture Mapping
- Define the main components before coding: crawler manager, frontier queue, worker pool, parser, search service, persistence layer, and live update bus.
- Define the data model for crawl jobs, frontier entries, pages, discovered relationships, and indexed terms.
- Define the live-update path so search and status views can reflect new crawl progress while indexing is active.

### Phase 3: Coding Constraints
- Prefer native or low-level primitives over full crawler/search frameworks.
- Keep the system localhost-runnable with a local database.
- Make concurrency safety explicit around shared frontier and worker state.

### Phase 4: Iterative Build Order
1. Core crawler with depth limiting, de-duplication, persistence, and backpressure.
2. Real-time search over the live index.
3. Dashboard/UI with live system visibility.
4. Tests and verification.
5. Docs and production recommendations.

## Non-Functional Requirements
- Single-machine scale with controlled backpressure.
- Use language-native capabilities and lightweight libraries, including low-level HTML parsing rather than full crawler/search frameworks.
- Protect shared in-memory crawl coordination with explicit concurrency-safe primitives.
- Localhost runnable with minimal dependencies.

## System Architecture

- `CrawlerManager`: owns crawl jobs, resume behavior, statistics, and page-processing orchestration.
- `FrontierQueue`: persists pending/processing/done frontier state and guards queue mutations.
- `WorkerPool`: schedules workers with concurrency and rate limits.
- `Parser`: extracts text, title, and links from HTML using low-level parsing logic.
- `SearchService`: reads the live inverted index from SQLite and ranks matches by term frequency.
- `UpdateBus` + SSE endpoints: propagate job updates to dashboard and search pages in real time.

## Data Model

- `crawl_jobs`: top-level crawl job metadata and status counters.
- `frontier`: queued, processing, done, and failed crawl entries.
- `pages`: canonical URL records and fetch metadata.
- `job_pages`: discovered `(origin_url, relevant_url, depth)` relationships.
- `terms` and `page_terms`: the live searchable index.

## Scope Assumptions
- Relevance is based on term matching and frequency.
- Only HTML pages are parsed.
- Politeness is global rate limiting, not per-host.
- Real-time UI updates use local event streams over HTTP.

## Out of Scope
- Distributed crawling or multi-node coordination.
- Advanced ranking (PageRank, semantic search).
- JavaScript rendering or headless browser crawling.
- Internet-scale host scheduling, robots.txt enforcement, and large-cluster execution.
