#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const DEFAULTS = {
  files: 500,
  dirs: 25,
  bytes: 2048,
  extension: ".md",
  keep: false,
  out: "",
  root: "",
  json: false,
};

async function loadIndexerPackage() {
  try {
    return await import("@x-file/indexer");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") {
      throw error;
    }
    return import("../packages/indexer/dist/src/index.js");
  }
}

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      continue;
    }
    if (!token.startsWith("--")) {
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.trim();
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined && value && !value.startsWith("--")) {
      index += 1;
    }
    switch (key) {
      case "files":
        args.files = readPositiveInteger(value, key);
        break;
      case "dirs":
        args.dirs = readPositiveInteger(value, key);
        break;
      case "bytes":
        args.bytes = readPositiveInteger(value, key);
        break;
      case "extension":
        args.extension = normalizeExtension(String(value ?? ""));
        break;
      case "root":
        args.root = String(value ?? "").trim();
        break;
      case "out":
        args.out = String(value ?? "").trim();
        break;
      case "keep":
        args.keep = true;
        break;
      case "json":
        args.json = true;
        break;
      case "help":
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：--${key}`);
    }
  }
  return args;
}

function readPositiveInteger(value, key) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${key} 必须是正整数`);
  }
  return parsed;
}

function normalizeExtension(value) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    throw new Error("--extension 不能为空");
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function printHelp() {
  console.log(`用法：
  pnpm benchmark:large-library -- --files 500 --dirs 25 --bytes 2048
  pnpm benchmark:large-library -- --files 100000 --dirs 1000 --bytes 4096 --keep

参数：
  --files <n>       生成文件数量，默认 500
  --dirs <n>        生成目录数量，默认 25
  --bytes <n>       每个文件目标大小，默认 2048
  --extension <ext> 文件扩展名，默认 .md
  --root <path>     使用指定资料库目录；不传则创建临时目录
  --out <path>      JSON 摘要输出路径；不传只写 stdout
  --keep            保留临时资料库目录，方便复查 .ai-index
  --json            stdout 只输出 JSON，不输出进度文本
`);
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function createBenchmarkRoot(config) {
  if (config.root) {
    const rootDir = path.resolve(config.root);
    ensureDirectory(rootDir);
    return { rootDir, createdTemporaryRoot: false };
  }
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-large-library-"));
  return { rootDir, createdTemporaryRoot: true };
}

function makePayload(index, bytes) {
  const header = [
    `# 压测文档 ${index}`,
    "",
    `这是 X-File 大目录压测生成的第 ${index} 个文档。`,
    "内容用于验证扫描、索引、导出和 manifest 汇总，不代表真实用户资料。",
    "",
  ].join("\n");
  if (Buffer.byteLength(header, "utf8") >= bytes) {
    return header;
  }
  const filler = "索引压测内容块 alpha beta gamma delta 2026 X-File library benchmark。\n";
  let output = header;
  while (Buffer.byteLength(output, "utf8") < bytes) {
    output += filler;
  }
  return output;
}

function generateLibrary(rootDir, config) {
  const startedAt = performance.now();
  const filesPerDir = Math.ceil(config.files / config.dirs);
  let writtenFiles = 0;
  let writtenBytes = 0;

  for (let dirIndex = 0; dirIndex < config.dirs && writtenFiles < config.files; dirIndex += 1) {
    const group = String(Math.floor(dirIndex / 100)).padStart(3, "0");
    const dirName = `group-${group}/folder-${String(dirIndex).padStart(5, "0")}`;
    const dirPath = path.join(rootDir, dirName);
    ensureDirectory(dirPath);

    for (let fileIndex = 0; fileIndex < filesPerDir && writtenFiles < config.files; fileIndex += 1) {
      const globalIndex = writtenFiles + 1;
      const fileName = `doc-${String(globalIndex).padStart(8, "0")}${config.extension}`;
      const payload = makePayload(globalIndex, config.bytes);
      fs.writeFileSync(path.join(dirPath, fileName), payload, "utf8");
      writtenFiles += 1;
      writtenBytes += Buffer.byteLength(payload, "utf8");
    }
  }

  return {
    generatedFileCount: writtenFiles,
    generatedDirectoryCount: config.dirs,
    generatedBytes: writtenBytes,
    durationMs: roundMs(performance.now() - startedAt),
  };
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function collectManifestSummary(manifestPath) {
  const manifest = readJsonFile(manifestPath);
  const outputDir = path.dirname(manifestPath);
  const statusPath = manifest.entries?.status
    ? path.join(outputDir, manifest.entries.status)
    : null;
  const status = statusPath && fs.existsSync(statusPath) ? readJsonFile(statusPath) : null;
  const metaDocumentCount = Array.isArray(manifest.meta_shards)
    ? manifest.meta_shards.reduce((sum, shard) => sum + Number(shard.document_count ?? 0), 0)
    : 0;

  return {
    manifestPath,
    outputDir,
    format: manifest.format ?? null,
    fallback: Boolean(manifest.fallback),
    generatedAt: manifest.generated_at ?? null,
    statusDocumentCount: Number(status?.document_count ?? 0),
    metaDocumentCount,
    metaShardCount: manifest.meta_shards?.length ?? 0,
    detailShardCount: manifest.detail_shards?.length ?? 0,
    tagShardCount: manifest.tag_shards?.length ?? 0,
    relationShardCount: manifest.relation_shards?.length ?? 0,
    searchBucketCount: manifest.search_buckets?.length ?? 0,
  };
}

function getRssMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  const log = config.json ? () => undefined : console.error;
  const totalStartedAt = performance.now();
  const { rootDir, createdTemporaryRoot } = createBenchmarkRoot(config);

  log(`生成压测资料库：${rootDir}`);
  const generation = generateLibrary(rootDir, config);
  const { runLibraryIndexOnce } = await loadIndexerPackage();

  const stages = [];
  log(`开始索引：${generation.generatedFileCount} 个文件，${generation.generatedDirectoryCount} 个目录`);
  const indexStartedAt = performance.now();
  const result = await runLibraryIndexOnce({
    rootDir,
    allowedExtensions: [config.extension],
    reason: "large_library_benchmark",
    onStageChange(stage) {
      stages.push({ stage, atMs: roundMs(performance.now() - indexStartedAt) });
      log(`索引阶段：${stage}`);
    },
  });
  const indexDurationMs = roundMs(performance.now() - indexStartedAt);
  const manifest = collectManifestSummary(result.exportResult.manifestPath);

  const summary = {
    ok: true,
    benchmark: {
      files: config.files,
      dirs: config.dirs,
      bytesPerFile: config.bytes,
      extension: config.extension,
      createdTemporaryRoot,
      keptRoot: config.keep || !createdTemporaryRoot,
    },
    paths: {
      rootDir,
      indexDir: result.config.indexDir,
      dbPath: result.config.dbPath,
      exportDir: result.config.exportDir,
      manifestPath: result.exportResult.manifestPath,
    },
    generation,
    index: {
      fallbackMode: result.fallbackMode,
      scannedCount: result.index.scannedCount,
      indexedCount: result.index.indexedCount,
      failedCount: result.index.failedCount,
      skippedCount: result.index.skipStats?.skippedCount ?? result.index.skippedPaths?.length ?? 0,
      durationMs: indexDurationMs,
      stages,
    },
    export: {
      filesWritten: result.exportResult.filesWritten.length,
      ...manifest,
    },
    process: {
      nodeVersion: process.version,
      rssMb: getRssMb(),
    },
    durationMs: roundMs(performance.now() - totalStartedAt),
  };

  if (config.out) {
    const outPath = path.resolve(config.out);
    ensureDirectory(path.dirname(outPath));
    fs.writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  }

  console.log(JSON.stringify(summary, null, 2));

  if (createdTemporaryRoot && !config.keep) {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
