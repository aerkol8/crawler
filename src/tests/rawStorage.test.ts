import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeRelevanceScore, searchRawStorage } from "../storage/rawStorage";

const tempDirs: string[] = [];

function createRawStorageDir(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "raw-storage-test-"));
  tempDirs.push(dir);

  for (const [fileName, contents] of Object.entries(files)) {
    writeFileSync(join(dir, fileName), contents, "utf8");
  }

  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("computeRelevanceScore follows the compatibility formula", () => {
  assert.equal(computeRelevanceScore(7, 3, true), 1055);
  assert.equal(computeRelevanceScore(7, 3, false), 55);
});

test("searchRawStorage sorts results by relevance_score for a single word query", async () => {
  const storageDir = createRawStorageDir({
    "p.data": [
      "python https://example.com/a https://origin.example 1 2",
      "python https://example.com/b https://origin.example 0 1",
      "python https://example.com/c https://origin.example 2 10"
    ].join("\n")
  });

  const results = await searchRawStorage(storageDir, "python");

  assert.deepEqual(results, [
    {
      relevant_url: "https://example.com/c",
      origin_url: "https://origin.example",
      depth: 2,
      matched_frequency: 10,
      relevance_score: 1090
    },
    {
      relevant_url: "https://example.com/a",
      origin_url: "https://origin.example",
      depth: 1,
      matched_frequency: 2,
      relevance_score: 1015
    },
    {
      relevant_url: "https://example.com/b",
      origin_url: "https://origin.example",
      depth: 0,
      matched_frequency: 1,
      relevance_score: 1010
    }
  ]);
});

test("searchRawStorage reads only the needed initial-letter bucket files", async () => {
  const storageDir = createRawStorageDir({
    "a.data": "alpha https://example.com/a https://origin.example 1 3",
    "p.data": [
      "python https://example.com/a https://origin.example 1 2",
      "python https://example.com/b https://origin.example 0 5"
    ].join("\n"),
    "z.data": "zebra https://example.com/z https://origin.example 0 9"
  });

  const results = await searchRawStorage(join(storageDir, "p.data"), "python alpha");

  assert.deepEqual(results, [
    {
      relevant_url: "https://example.com/a",
      origin_url: "https://origin.example",
      depth: 1,
      matched_frequency: 5,
      relevance_score: 1045
    },
    {
      relevant_url: "https://example.com/b",
      origin_url: "https://origin.example",
      depth: 0,
      matched_frequency: 5,
      relevance_score: 50
    }
  ]);
});
