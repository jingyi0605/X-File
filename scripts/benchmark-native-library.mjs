import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { runLibraryIndexOnce } from "../packages/indexer/dist/src/index.js";

const value = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
};
const fileCount = value("--files", 1000);
const directoryCount = value("--dirs", 50);
const unchangedRuns = value("--unchanged-runs", 1);
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-native-benchmark-"));
const results = [];
let previousFiles = new Map();
let previousSnapshots = new Map();

function snapshotFiles() {
  return new Map(["export-catalog-snapshot.json", "active-file-state-snapshot.json", "index-state.json"]
    .map(name => {
      const stat = fs.statSync(path.join(rootDir, ".ai-index/runtime", name), { bigint: true });
      return [name, `${stat.ino}:${stat.mtimeNs}:${stat.size}`];
    }));
}

function exportFiles() {
  const root = path.join(rootDir, ".ai-index/exports");
  const files = new Map();
  const queue = [root];
  while (queue.length) {
    const directory = queue.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) queue.push(absolute);
      else {
        const stat = fs.statSync(absolute, { bigint: true });
        files.set(path.relative(root, absolute), `${stat.ino}:${stat.mtimeNs}:${stat.size}`);
      }
    }
  }
  return files;
}

async function measure(name, targetPath) {
  const started = performance.now();
  const result = await runLibraryIndexOnce({ rootDir, targetPath });
  const durationMs = Math.round(performance.now() - started);
  const files = exportFiles();
  const snapshots = snapshotFiles();
  results.push({
    name, durationMs,
    scanned: result.index.scannedCount,
    indexed: result.index.indexedCount,
    unchanged: result.index.unchangedCount,
    rewrittenExports: [...files].filter(([file, version]) => previousFiles.get(file) !== version).length,
    removedExports: [...previousFiles.keys()].filter(file => !files.has(file)).length,
    rewrittenSnapshots: [...snapshots].filter(([file, version]) => previousSnapshots.get(file) !== version).map(([file]) => file),
  });
  previousFiles = files;
  previousSnapshots = snapshots;
}

try {
  for (let index = 0; index < fileCount; index++) {
    const directory = path.join(rootDir, `folder-${index % directoryCount}`);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `document-${index}.md`),
      `# 文档 ${index}\n\n原生索引性能验证 alpha beta gamma。\n${"正文内容 ".repeat(100)}`);
  }
  await measure("首次完整索引");
  for (let run = 0; run < unchangedRuns; run++) {
    await measure(unchangedRuns === 1 ? "无变化刷新" : `无变化刷新 #${run + 1}`);
  }
  fs.appendFileSync(path.join(rootDir, "folder-0/document-0.md"), "\n新增内容");
  await measure("单文件更新，摘要词项不变", "folder-0/document-0.md");
  fs.writeFileSync(path.join(rootDir, "folder-0/document-0.md"), "Delta 新主题内容，验证搜索词项更新。\n");
  await measure("单文件更新，摘要词项改变", "folder-0/document-0.md");
  console.log(JSON.stringify({ fileCount, directoryCount, results }, null, 2));
} finally {
  fs.rmSync(rootDir, { recursive: true, force: true });
}
