import { JobDetail, JobStatus } from "../crawler/manager";
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

function canStopJob(status: string) {
  return status === "running" || status === "stopping";
}

function renderJobActions(job: JobStatus, redirectTo: string) {
  const stopLabel = job.status === "stopping" ? "Stopping..." : "Stop";
  const stopDisabled = canStopJob(job.status) ? "" : "disabled";

  return `
      <div class="actions">
        <form method="post" action="/jobs/${encodeURIComponent(job.id)}/stop">
          <input type="hidden" name="redirectTo" value="${escapeHtml(redirectTo)}" />
          <button type="submit" ${stopDisabled}>${stopLabel}</button>
        </form>
        <form method="post" action="/jobs/${encodeURIComponent(job.id)}/delete" onsubmit="return confirm('Delete this crawl job and indexed data?');">
          <input type="hidden" name="redirectTo" value="${escapeHtml(redirectTo)}" />
          <button type="submit" class="danger">Delete</button>
        </form>
      </div>`;
}

function renderJobRow(job: JobStatus, maxQueue: number, redirectTo: string) {
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
        <td>${renderJobActions(job, redirectTo)}</td>
      </tr>`;
}

function renderSearchRow(row: SearchResult) {
  return `
      <tr>
        <td>${escapeHtml(row.relevant_url)}</td>
        <td>${escapeHtml(row.origin_url)}</td>
        <td>${row.depth}</td>
        <td>${row.relevance_score}</td>
      </tr>`;
}

function renderStatusBanner(job: JobDetail) {
  const bannerClass = job.status === "completed"
    ? "success"
    : job.status === "stopped"
      ? "warning"
      : job.status === "stopping"
        ? "warning"
        : "info";

  const bannerText = job.status === "completed"
    ? "Crawler completed successfully."
    : job.status === "stopped"
      ? "Crawler was interrupted and is no longer running."
      : job.status === "stopping"
        ? "Stop requested. The crawler is draining active work."
        : `Crawler is running${job.currentUrl ? ` and currently processing ${job.currentUrl}.` : "."}`;

  return `<div id="job-banner" class="banner ${bannerClass}">${escapeHtml(bannerText)}</div>`;
}

function renderQueuedUrlItems(job: JobDetail) {
  if (job.queuedUrls.length === 0) {
    return "<li>No queued URLs right now</li>";
  }

  return job.queuedUrls
    .slice(0, 12)
    .map((entry) => (
      `<li><code>${escapeHtml(entry.url)}</code> depth=${entry.depth} status=${escapeHtml(entry.status)}</li>`
    ))
    .join("");
}

function renderLogItems(job: JobDetail) {
  if (job.logs.length === 0) {
    return "<li>No logs yet</li>";
  }

  return job.logs
    .slice(-25)
    .reverse()
    .map((entry) => {
      const detail = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
      return `<li><strong>${escapeHtml(entry.timestamp)}</strong> [${escapeHtml(entry.level)}] ${escapeHtml(entry.message + detail)}</li>`;
    })
    .join("");
}

export function renderHome(jobs: JobStatus[], maxQueue: number) {
  const jobRows = jobs.map((job) => renderJobRow(job, maxQueue, "/")).join("");
  const emptyRow = "<tr><td colspan='10'>No jobs yet</td></tr>";

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
        .actions { display: flex; gap: 8px; }
        .actions form { margin: 0; }
        .danger { color: #7a1f1f; }
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
      <p>Crawl jobs stay in the local database until you delete them.</p>
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
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="job-rows">
          ${jobRows || emptyRow}
        </tbody>
      </table>
      <script>
        const maxQueue = ${JSON.stringify(maxQueue)};
        const emptyRow = ${JSON.stringify(emptyRow)};
        const redirectTo = "/";

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }

        function canStopJob(status) {
          return status === "running" || status === "stopping";
        }

        function renderActions(job) {
          const stopLabel = job.status === "stopping" ? "Stopping..." : "Stop";
          const stopDisabled = canStopJob(job.status) ? "" : "disabled";

          return \`
            <div class="actions">
              <form method="post" action="/jobs/\${encodeURIComponent(job.id)}/stop">
                <input type="hidden" name="redirectTo" value="\${escapeHtml(redirectTo)}" />
                <button type="submit" \${stopDisabled}>\${stopLabel}</button>
              </form>
              <form method="post" action="/jobs/\${encodeURIComponent(job.id)}/delete" onsubmit="return confirm('Delete this crawl job and indexed data?');">
                <input type="hidden" name="redirectTo" value="\${escapeHtml(redirectTo)}" />
                <button type="submit" class="danger">Delete</button>
              </form>
            </div>
          \`;
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
              <td>\${renderActions(job)}</td>
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

export function renderStatus(job: JobDetail, maxQueue: number) {
  const jobId = escapeHtml(job.id);
  const stopLabel = job.status === "stopping" ? "Stopping..." : "Stop";
  const stopDisabled = canStopJob(job.status) ? "" : "disabled";
  const emptyQueue = "<li>No queued URLs right now</li>";
  const emptyLogs = "<li>No logs yet</li>";
  return `
  <html>
    <head>
      <title>Crawler Status</title>
      <style>
        body { font-family: Georgia, serif; margin: 32px; }
        code { word-break: break-word; }
        .card { border: 1px solid #ccc; padding: 16px; }
        .actions { display: flex; gap: 8px; margin: 0 0 16px; }
        .actions form { margin: 0; }
        .danger { color: #7a1f1f; }
        .banner { padding: 12px 16px; margin: 0 0 16px; border: 1px solid #ccc; }
        .banner.info { background: #f6f0e3; }
        .banner.success { background: #ebf6ea; }
        .banner.warning { background: #fff4db; }
        .panel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-bottom: 16px; }
        .log-list, .queue-list { margin: 0; padding-left: 20px; }
        .log-list li, .queue-list li { margin: 0 0 8px; }
        .muted { color: #666; }
      </style>
    </head>
    <body>
      <h1>Job Status</h1>
      <p>Live dashboard updates through a server event stream.</p>
      <p>Use Stop to halt new work for this crawl, or Delete to remove it from the local index.</p>
      ${renderStatusBanner(job)}
      <div class="actions">
        <form method="post" action="/jobs/${encodeURIComponent(job.id)}/stop">
          <input type="hidden" name="redirectTo" value="/status/${encodeURIComponent(job.id)}" />
          <button id="stop-button" type="submit" ${stopDisabled}>${stopLabel}</button>
        </form>
        <form method="post" action="/jobs/${encodeURIComponent(job.id)}/delete" onsubmit="return confirm('Delete this crawl job and indexed data?');">
          <input type="hidden" name="redirectTo" value="/" />
          <button type="submit" class="danger">Delete</button>
        </form>
      </div>
      <div class="panel-grid">
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
          <p><strong>Created:</strong> <span id="job-created">${escapeHtml(job.createdAt)}</span></p>
          <p><strong>Updated:</strong> <span id="job-updated">${escapeHtml(job.updatedAt)}</span></p>
          <p><strong>Current URL:</strong> <span id="job-current-url">${job.currentUrl ? escapeHtml(job.currentUrl) : "<span class=\"muted\">idle</span>"}</span></p>
          <p><strong>Last Error:</strong> <span id="job-last-error">${job.lastError ? escapeHtml(job.lastError) : "<span class=\"muted\">none</span>"}</span></p>
        </div>
        <div class="card">
          <h2>Queued URLs</h2>
          <p><span id="job-queue-count">${job.queuedUrls.length}</span> URLs in the current artifact snapshot.</p>
          <ul id="job-queue" class="queue-list">
            ${renderQueuedUrlItems(job) || emptyQueue}
          </ul>
        </div>
      </div>
      <div class="card">
        <h2>State Logs</h2>
        <p>Recent crawler events from the job artifact file.</p>
        <ol id="job-logs" class="log-list">
          ${renderLogItems(job) || emptyLogs}
        </ol>
      </div>
      <p>Last refresh: <span id="job-refresh-time">server render</span></p>
      <p><a href="/">Back</a></p>
      <script>
        const jobId = ${JSON.stringify(job.id)};
        const maxQueue = ${JSON.stringify(maxQueue)};
        const emptyQueue = ${JSON.stringify(emptyQueue)};
        const emptyLogs = ${JSON.stringify(emptyLogs)};

        function canStopJob(status) {
          return status === "running" || status === "stopping";
        }

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }

        function bannerClass(status) {
          if (status === "completed") {
            return "banner success";
          }
          if (status === "stopped" || status === "stopping") {
            return "banner warning";
          }
          return "banner info";
        }

        function bannerText(job) {
          if (job.status === "completed") {
            return "Crawler completed successfully.";
          }
          if (job.status === "stopped") {
            return "Crawler was interrupted and is no longer running.";
          }
          if (job.status === "stopping") {
            return "Stop requested. The crawler is draining active work.";
          }
          return job.currentUrl
            ? "Crawler is running and currently processing " + job.currentUrl + "."
            : "Crawler is running.";
        }

        function renderQueue(queue) {
          if (!queue.length) {
            return emptyQueue;
          }

          return queue.slice(0, 12).map((entry) => (
            "<li><code>" + escapeHtml(entry.url) + "</code> depth=" + entry.depth + " status=" + escapeHtml(entry.status) + "</li>"
          )).join("");
        }

        function renderLogs(logs) {
          if (!logs.length) {
            return emptyLogs;
          }

          return logs.slice(-25).reverse().map((entry) => {
            const detail = entry.data ? " " + JSON.stringify(entry.data) : "";
            return "<li><strong>" + escapeHtml(entry.timestamp) + "</strong> [" + escapeHtml(entry.level) + "] " + escapeHtml(entry.message + detail) + "</li>";
          }).join("");
        }

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
            document.getElementById("job-created").textContent = job.createdAt;
            document.getElementById("job-updated").textContent = job.updatedAt;
            document.getElementById("job-current-url").innerHTML = job.currentUrl ? escapeHtml(job.currentUrl) : "<span class='muted'>idle</span>";
            document.getElementById("job-last-error").innerHTML = job.lastError ? escapeHtml(job.lastError) : "<span class='muted'>none</span>";
            document.getElementById("job-queue-count").textContent = String(job.queuedUrls.length);
            document.getElementById("job-queue").innerHTML = renderQueue(job.queuedUrls);
            document.getElementById("job-logs").innerHTML = renderLogs(job.logs);
            const banner = document.getElementById("job-banner");
            banner.className = bannerClass(job.status);
            banner.textContent = bannerText(job);
            document.getElementById("job-refresh-time").textContent = new Date().toLocaleTimeString();
            const stopButton = document.getElementById("stop-button");
            stopButton.disabled = !canStopJob(job.status);
            stopButton.textContent = job.status === "stopping" ? "Stopping..." : "Stop";
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
  const emptyRow = "<tr><td colspan='4'>No results</td></tr>";

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
            <th>Relevance Score</th>
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
              <td>\${row.relevance_score}</td>
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
