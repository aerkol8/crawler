import { JobStatus } from "../crawler/manager";
import { SearchResult } from "../search/searchService";

export function renderHome(jobs: JobStatus[], maxQueue: number) {
  const jobRows = jobs
    .map(
      (job) => `
      <tr>
        <td>${job.id}</td>
        <td>${job.originUrl}</td>
        <td>${job.maxDepth}</td>
        <td>${job.status}</td>
        <td>${job.queuedCount}</td>
        <td>${job.queuedCount >= maxQueue ? "active" : "ok"}</td>
        <td>${job.activeWorkers}</td>
        <td>${job.processedCount}</td>
        <td><a href="/status/${job.id}">view</a></td>
      </tr>`
    )
    .join("");

  return `
  <html>
    <head>
      <title>Crawler</title>
      <style>
        body { font-family: Georgia, serif; margin: 32px; }
        form { margin-bottom: 24px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
        th { background: #f5f0e6; }
      </style>
    </head>
    <body>
      <h1>Crawler</h1>
      <form method="post" action="/index">
        <label>Origin URL</label><br />
        <input name="origin" type="url" required style="width: 420px;" />
        <br /><br />
        <label>Max Depth</label><br />
        <input name="maxDepth" type="number" min="0" max="6" value="2" />
        <br /><br />
        <button type="submit">Start Crawl</button>
      </form>

      <h2>Search</h2>
      <form method="get" action="/search">
        <input name="query" type="text" style="width: 420px;" placeholder="Search terms" />
        <button type="submit">Search</button>
      </form>

      <h2>Recent Jobs</h2>
      <table>
        <thead>
          <tr>
            <th>Job ID</th>
            <th>Origin</th>
            <th>Depth</th>
            <th>Status</th>
            <th>Queued</th>
            <th>Backpressure</th>
            <th>Active</th>
            <th>Processed</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          ${jobRows || "<tr><td colspan='9'>No jobs yet</td></tr>"}
        </tbody>
      </table>
    </body>
  </html>
  `;
}

export function renderStatus(job: JobStatus, maxQueue: number) {
  return `
  <html>
    <head>
      <title>Crawler Status</title>
      <style>
        body { font-family: Georgia, serif; margin: 32px; }
        .card { border: 1px solid #ccc; padding: 16px; width: 520px; }
      </style>
    </head>
    <body>
      <h1>Job Status</h1>
      <div class="card">
        <p><strong>Job ID:</strong> ${job.id}</p>
        <p><strong>Origin:</strong> ${job.originUrl}</p>
        <p><strong>Depth:</strong> ${job.maxDepth}</p>
        <p><strong>Status:</strong> ${job.status}</p>
        <p><strong>Queued:</strong> ${job.queuedCount}</p>
        <p><strong>Backpressure:</strong> ${job.queuedCount >= maxQueue ? "active" : "ok"}</p>
        <p><strong>Active Workers:</strong> ${job.activeWorkers}</p>
        <p><strong>Processed:</strong> ${job.processedCount}</p>
        <p><strong>Errors:</strong> ${job.errorCount}</p>
        <p><strong>Updated:</strong> ${job.updatedAt}</p>
      </div>
      <p><a href="/">Back</a></p>
    </body>
  </html>
  `;
}

export function renderSearch(query: string, results: SearchResult[]) {
  const resultRows = results
    .map(
      (row) => `
      <tr>
        <td>${row.relevant_url}</td>
        <td>${row.origin_url}</td>
        <td>${row.depth}</td>
      </tr>`
    )
    .join("");

  return `
  <html>
    <head>
      <title>Search</title>
      <style>
        body { font-family: Georgia, serif; margin: 32px; }
        table { border-collapse: collapse; width: 100%; }
        th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
        th { background: #f5f0e6; }
      </style>
    </head>
    <body>
      <h1>Search</h1>
      <form method="get" action="/search">
        <input name="query" type="text" style="width: 420px;" value="${query}" />
        <button type="submit">Search</button>
      </form>
      <p>${results.length} results</p>
      <table>
        <thead>
          <tr>
            <th>Relevant URL</th>
            <th>Origin URL</th>
            <th>Depth</th>
          </tr>
        </thead>
        <tbody>
          ${resultRows || "<tr><td colspan='3'>No results</td></tr>"}
        </tbody>
      </table>
      <p><a href="/">Back</a></p>
    </body>
  </html>
  `;
}
