import { JobStatus } from "../crawler/manager";
import { SearchResult } from "../search/searchService";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderBackpressureLabel(queuedCount: number, maxQueue: number) {
  return queuedCount >= maxQueue ? "active" : "ok";
}

function renderJobRow(job: JobStatus, maxQueue: number) {
  return `
      <tr>
        <td>${escapeHtml(job.id)}</td>
        <td>${escapeHtml(job.originUrl)}</td>
        <td>${job.maxDepth}</td>
        <td>${escapeHtml(job.status)}</td>
        <td>${job.queuedCount}</td>
        <td>${renderBackpressureLabel(job.queuedCount, maxQueue)}</td>
        <td>${job.activeWorkers}</td>
        <td>${job.processedCount}</td>
        <td><a href="/status/${encodeURIComponent(job.id)}">view</a></td>
      </tr>`;
}

function renderSearchRow(row: SearchResult) {
  return `
      <tr>
        <td>${escapeHtml(row.relevant_url)}</td>
        <td>${escapeHtml(row.origin_url)}</td>
        <td>${row.depth}</td>
      </tr>`;
}

export function renderHome(jobs: JobStatus[], maxQueue: number) {
  const jobRows = jobs.map((job) => renderJobRow(job, maxQueue)).join("");
  const emptyRow = "<tr><td colspan='9'>No jobs yet</td></tr>";

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
      <p>Live event stream connected. Last refresh: <span id="job-refresh-time">server render</span></p>
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
        <tbody id="job-rows">
          ${jobRows || emptyRow}
        </tbody>
      </table>
      <script>
        const maxQueue = ${JSON.stringify(maxQueue)};
        const emptyRow = ${JSON.stringify(emptyRow)};

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }

        function renderRows(jobs) {
          if (!jobs.length) {
            return emptyRow;
          }

          return jobs.map((job) => \`
            <tr>
              <td>\${escapeHtml(job.id)}</td>
              <td>\${escapeHtml(job.originUrl)}</td>
              <td>\${job.maxDepth}</td>
              <td>\${escapeHtml(job.status)}</td>
              <td>\${job.queuedCount}</td>
              <td>\${job.queuedCount >= maxQueue ? "active" : "ok"}</td>
              <td>\${job.activeWorkers}</td>
              <td>\${job.processedCount}</td>
              <td><a href="/status/\${encodeURIComponent(job.id)}">view</a></td>
            </tr>
          \`).join("");
        }

        function connectJobStream() {
          const source = new EventSource("/events/jobs");
          source.addEventListener("jobs", (event) => {
            const jobs = JSON.parse(event.data);
            document.getElementById("job-rows").innerHTML = renderRows(jobs);
            document.getElementById("job-refresh-time").textContent = new Date().toLocaleTimeString();
          });
          window.addEventListener("beforeunload", () => source.close(), { once: true });
        }

        document.getElementById("job-refresh-time").textContent = new Date().toLocaleTimeString();
        connectJobStream();
      </script>
    </body>
  </html>
  `;
}

export function renderStatus(job: JobStatus, maxQueue: number) {
  const jobId = escapeHtml(job.id);
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
      <p>Live dashboard updates through a server event stream.</p>
      <div class="card">
        <p><strong>Job ID:</strong> <span id="job-id">${jobId}</span></p>
        <p><strong>Origin:</strong> <span id="job-origin">${escapeHtml(job.originUrl)}</span></p>
        <p><strong>Depth:</strong> <span id="job-depth">${job.maxDepth}</span></p>
        <p><strong>Status:</strong> <span id="job-status">${escapeHtml(job.status)}</span></p>
        <p><strong>Queued:</strong> <span id="job-queued">${job.queuedCount}</span></p>
        <p><strong>Backpressure:</strong> <span id="job-backpressure">${renderBackpressureLabel(job.queuedCount, maxQueue)}</span></p>
        <p><strong>Active Workers:</strong> <span id="job-active">${job.activeWorkers}</span></p>
        <p><strong>Processed:</strong> <span id="job-processed">${job.processedCount}</span></p>
        <p><strong>Errors:</strong> <span id="job-errors">${job.errorCount}</span></p>
        <p><strong>Updated:</strong> <span id="job-updated">${escapeHtml(job.updatedAt)}</span></p>
      </div>
      <p>Last refresh: <span id="job-refresh-time">server render</span></p>
      <p><a href="/">Back</a></p>
      <script>
        const jobId = ${JSON.stringify(job.id)};
        const maxQueue = ${JSON.stringify(maxQueue)};

        function applyJob(job) {
            document.getElementById("job-id").textContent = job.id;
            document.getElementById("job-origin").textContent = job.originUrl;
            document.getElementById("job-depth").textContent = String(job.maxDepth);
            document.getElementById("job-status").textContent = job.status;
            document.getElementById("job-queued").textContent = String(job.queuedCount);
            document.getElementById("job-backpressure").textContent = job.queuedCount >= maxQueue ? "active" : "ok";
            document.getElementById("job-active").textContent = String(job.activeWorkers);
            document.getElementById("job-processed").textContent = String(job.processedCount);
            document.getElementById("job-errors").textContent = String(job.errorCount);
            document.getElementById("job-updated").textContent = job.updatedAt;
            document.getElementById("job-refresh-time").textContent = new Date().toLocaleTimeString();
        }

        function connectStatusStream() {
          const source = new EventSource("/events/job/" + encodeURIComponent(jobId));
          source.addEventListener("job", (event) => {
            applyJob(JSON.parse(event.data));
          });
          window.addEventListener("beforeunload", () => source.close(), { once: true });
        }

        document.getElementById("job-refresh-time").textContent = new Date().toLocaleTimeString();
        connectStatusStream();
      </script>
    </body>
  </html>
  `;
}

export function renderSearch(query: string, results: SearchResult[]) {
  const resultRows = results.map((row) => renderSearchRow(row)).join("");
  const emptyRow = "<tr><td colspan='3'>No results</td></tr>";

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
        <input name="query" type="text" style="width: 420px;" value="${escapeHtml(query)}" />
        <button type="submit">Search</button>
      </form>
      <p>Live search updates through a server event stream while a query is active.</p>
      <p><span id="search-count">${results.length}</span> results</p>
      <p>Last refresh: <span id="search-refresh-time">server render</span></p>
      <table>
        <thead>
          <tr>
            <th>Relevant URL</th>
            <th>Origin URL</th>
            <th>Depth</th>
          </tr>
        </thead>
        <tbody id="search-results">
          ${resultRows || emptyRow}
        </tbody>
      </table>
      <p><a href="/">Back</a></p>
      <script>
        const query = ${JSON.stringify(query)};
        const emptyRow = ${JSON.stringify(emptyRow)};

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }

        function renderRows(results) {
          if (!results.length) {
            return emptyRow;
          }

          return results.map((row) => \`
            <tr>
              <td>\${escapeHtml(row.relevant_url)}</td>
              <td>\${escapeHtml(row.origin_url)}</td>
              <td>\${row.depth}</td>
            </tr>
          \`).join("");
        }

        function applySearchResults(results) {
            document.getElementById("search-results").innerHTML = renderRows(results);
            document.getElementById("search-count").textContent = String(results.length);
            document.getElementById("search-refresh-time").textContent = new Date().toLocaleTimeString();
        }

        function connectSearchStream() {
          const source = new EventSource("/events/search?query=" + encodeURIComponent(query));
          source.addEventListener("results", (event) => {
            applySearchResults(JSON.parse(event.data));
          });
          window.addEventListener("beforeunload", () => source.close(), { once: true });
        }

        document.getElementById("search-refresh-time").textContent = new Date().toLocaleTimeString();
        if (query) {
          connectSearchStream();
        }
      </script>
    </body>
  </html>
  `;
}
