import { config } from "../config";
import { getDb } from "../db";
import { exportRawStorageSnapshot } from "../storage/rawStorage";

async function main() {
  const db = await getDb();
  const preferredJobId = process.argv[2] || config.rawStorageJobId || undefined;
  const outputPath = process.argv[3] || config.rawStoragePath;
  const result = await exportRawStorageSnapshot(db, outputPath, preferredJobId);

  if (result.lineCount === 0) {
    console.log(`No indexed crawl data found. Cleared bucket files under ${result.storageDir}`);
    return;
  }

  const scope = result.jobId ? `job ${result.jobId}` : `${result.jobCount} job(s)`;
  console.log(`Exported ${result.lineCount} rows across ${result.bucketCount} bucket file(s) for ${scope} into ${result.storageDir}`);
}

void main();
