export const schemaSql = `
CREATE TABLE IF NOT EXISTS crawl_jobs (
  id TEXT PRIMARY KEY,
  origin_url TEXT NOT NULL,
  max_depth INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  queued_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  active_workers INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL UNIQUE,
  title TEXT,
  fetched_at TEXT
);

CREATE TABLE IF NOT EXISTS job_pages (
  job_id TEXT NOT NULL,
  page_id INTEGER NOT NULL,
  origin_url TEXT NOT NULL,
  depth INTEGER NOT NULL,
  discovered_at TEXT NOT NULL,
  PRIMARY KEY (job_id, page_id)
);

CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS page_terms (
  job_id TEXT NOT NULL,
  page_id INTEGER NOT NULL,
  term_id INTEGER NOT NULL,
  frequency INTEGER NOT NULL,
  PRIMARY KEY (job_id, page_id, term_id)
);

CREATE TABLE IF NOT EXISTS frontier (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  url TEXT NOT NULL,
  depth INTEGER NOT NULL,
  status TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  UNIQUE (job_id, url)
);

CREATE INDEX IF NOT EXISTS idx_pages_url ON pages(url);
CREATE INDEX IF NOT EXISTS idx_terms_term ON terms(term);
CREATE INDEX IF NOT EXISTS idx_page_terms_term ON page_terms(term_id);
CREATE INDEX IF NOT EXISTS idx_frontier_job_status ON frontier(job_id, status);
`;
