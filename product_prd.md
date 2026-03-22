# Product Requirements Document

## Goal
Build a local web crawler and search system that can index pages from a starting URL up to a depth limit, and provide search results while indexing is still active.

## Users
- Developer evaluating crawler/search behavior.
- Reviewer validating system architecture and data flow.

## Functional Requirements
- Index endpoint accepts origin URL and depth k.
- Crawl up to depth k without crawling the same page twice.
- Search endpoint accepts a query string and returns triples: (relevant_url, origin_url, depth).
- Search reflects new results while indexing is active.
- UI allows starting jobs, viewing status, and running searches.
- Local persistence via SQLite; resume after interruption.

## Non-Functional Requirements
- Single-machine scale with controlled backpressure.
- Use language-native capabilities and lightweight libraries.
- Localhost runnable with minimal dependencies.

## Scope Assumptions
- Relevance is based on term matching and frequency.
- Only HTML pages are parsed.
- Politeness is global rate limiting, not per-host.

## Out of Scope
- Distributed crawling or multi-node coordination.
- Advanced ranking (PageRank, semantic search).
- JavaScript rendering or headless browser crawling.
