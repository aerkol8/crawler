import { test } from "node:test";
import assert from "node:assert/strict";
import { parseHtml } from "../crawler/parser";

test("parseHtml extracts title, text, and links with low-level parsing", () => {
  const parsed = parseHtml(
    `
    <html>
      <head>
        <title>Alpha &amp; Beta</title>
        <style>.hidden { display: none; }</style>
      </head>
      <body>
        <script>window.ignore = true;</script>
        <h1>Hello crawler</h1>
        <p>Find alpha beta terms.</p>
        <a href="/docs">Docs</a>
        <a href="https://example.com/about">About</a>
        <a href="mailto:test@example.com">Ignore</a>
      </body>
    </html>
    `,
    "https://example.com/start"
  );

  assert.equal(parsed.title, "Alpha & Beta");
  assert.equal(parsed.text, "Hello crawler Find alpha beta terms. Docs About Ignore");
  assert.deepEqual(parsed.links, [
    "https://example.com/docs",
    "https://example.com/about"
  ]);
  assert.equal(parsed.termCounts.get("alpha"), 1);
  assert.equal(parsed.termCounts.get("beta"), 1);
});
