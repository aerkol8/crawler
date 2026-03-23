import { config } from "../config";
import { getDb } from "../db";
import { exportRawStorageSnapshot } from "../storage/rawStorage";

async function main() {
  const db = await getDb();
  const preferredJobId = process.argv[2] || config.rawStorageJobId || undefined;
  const outputPath = process.argv[3] || config.rawStoragePath;
  const result = await exportRawStorageSnapshot(db, outputPath, preferredJobId);

  if (!result.jobId) {
    console.log(`No indexed crawl data found. Wrote empty snapshot to ${outputPath}`);
    return;
  }

  console.log(`Exported ${result.lineCount} rows from job ${result.jobId} to ${outputPath}`);
}

void main();
