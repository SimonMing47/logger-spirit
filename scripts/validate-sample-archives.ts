import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { extractArchiveRecursively } from "../src/lib/archive";
import { decodeText } from "../src/lib/text";

const ROOT = process.cwd();
const SAMPLE_DIR = path.join(ROOT, "sample-data", "generated");
const ARCHIVES = [
  "incident-alpha-2026-02-12.zip",
  "incident-beta-2026-02-12.zip",
];

const EXPECTED_QUERIES = [
  "PAYMENT_TIMEOUT",
  "DB_CONN_REFUSED",
  "KafkaOffsetLag",
  "INVENTORY_STALE",
  "REDIS_TIMEOUT",
  "alpha-trace-0001",
  "beta-trace-1002",
];

type ArchiveSummary = {
  archive: string;
  fileCount: number;
  textFileCount: number;
  maxDepthGuess: number;
};

function depthGuess(filePath: string): number {
  const parts = filePath.split("/").filter(Boolean);
  return parts.length;
}

async function validateArchive(fileName: string): Promise<ArchiveSummary> {
  const absolute = path.join(SAMPLE_DIR, fileName);
  const bytes = new Uint8Array(await readFile(absolute));
  const extracted = extractArchiveRecursively(fileName, bytes);

  if (extracted.length === 0) {
    throw new Error(`${fileName} extracted 0 files`);
  }

  const searchable = extracted.filter((item) => item.textLike);
  const fileTextPairs = searchable.map((item) => ({
    path: item.path,
    text: decodeText(item.bytes),
  }));

  for (const query of EXPECTED_QUERIES) {
    const hit = fileTextPairs.find((item) => item.text.includes(query));
    if (hit) {
      continue;
    }
    if (query.startsWith("alpha-") && fileName.includes("beta")) {
      continue;
    }
    if (query.startsWith("beta-") && fileName.includes("alpha")) {
      continue;
    }
    if (
      ["PAYMENT_TIMEOUT", "DB_CONN_REFUSED", "KafkaOffsetLag"].includes(query) &&
      fileName.includes("beta")
    ) {
      continue;
    }
    if (
      ["INVENTORY_STALE", "REDIS_TIMEOUT"].includes(query) &&
      fileName.includes("alpha")
    ) {
      continue;
    }

    throw new Error(`${fileName} missing query keyword: ${query}`);
  }

  const hasNestedZipPath = extracted.some((item) => item.path.includes("nested-layer"));
  const hasNestedTarPath = extracted.some((item) => item.path.includes("metrics/otel.log"));
  if (fileName.includes("alpha") && (!hasNestedZipPath || !hasNestedTarPath)) {
    throw new Error(`${fileName} missing nested zip or tar extraction evidence`);
  }

  const hasDumpTarPath = extracted.some((item) => item.path.includes("deep/timeline.log"));
  if (fileName.includes("beta") && !hasDumpTarPath) {
    throw new Error(`${fileName} missing deep tar extraction evidence`);
  }

  return {
    archive: fileName,
    fileCount: extracted.length,
    textFileCount: searchable.length,
    maxDepthGuess: Math.max(...extracted.map((item) => depthGuess(item.path))),
  };
}

async function main() {
  const summaries: ArchiveSummary[] = [];
  const mergedTexts: string[] = [];

  for (const archive of ARCHIVES) {
    summaries.push(await validateArchive(archive));
  }

  const mergedSearchPool = new Map<string, number>();

  for (const archive of ARCHIVES) {
    const absolute = path.join(SAMPLE_DIR, archive);
    const bytes = new Uint8Array(await readFile(absolute));
    const extracted = extractArchiveRecursively(archive, bytes);
    for (const file of extracted) {
      if (!file.textLike) {
        continue;
      }
      mergedSearchPool.set(`${archive}:${file.path}`, 1);
      mergedTexts.push(decodeText(file.bytes));
    }
  }

  const mergedQueryHits = EXPECTED_QUERIES.map((query) => {
    const count = mergedTexts.reduce((acc, text) => {
      return text.includes(query) ? acc + 1 : acc;
    }, 0);
    return { query, count };
  });

  for (const item of mergedQueryHits) {
    if (item.count === 0) {
      throw new Error(`merged search missing query: ${item.query}`);
    }
  }

  for (const summary of summaries) {
    console.log(
      `${summary.archive}: files=${summary.fileCount}, textFiles=${summary.textFileCount}, depth≈${summary.maxDepthGuess}`,
    );
  }

  console.log(`merged searchable files=${mergedSearchPool.size}`);
  for (const item of mergedQueryHits) {
    console.log(`query ${item.query} => ${item.count} files`);
  }
  console.log("validation=PASS");
}

main().catch((error) => {
  console.error(`validation=FAIL\n${String(error)}`);
  process.exitCode = 1;
});
