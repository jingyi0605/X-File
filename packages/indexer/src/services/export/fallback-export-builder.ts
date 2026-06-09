import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { FileScanner, type FileScanResult } from "../../scanner/file-scanner.js";
import type { RuntimeConfig } from "../../types/runtime-config.js";
import { throwIfAborted } from "../../utils/abort.js";

export interface FallbackExportResult {
  outputDir: string;
  manifestPath: string;
  documentCount: number;
  filesWritten: string[];
  exportedAt: string;
}

export interface FallbackExportIndexResult {
  scannedCount: number;
  indexedCount: number;
  unchangedCount: number;
  indexedPaths: string[];
  skippedPaths: string[];
  failedPaths: string[];
  failedCount: number;
  failures: Array<{
    path: string;
    errorCode: string;
    message: string;
  }>;
  failureOverflowCount: number;
  deletedCount: number;
  deletedPaths: string[];
  dirtyScope: {
    trigger: "full" | "incremental";
    changedPaths: string[];
    dirtyDirectories: string[];
    dirtyTagPaths: string[];
    dirtyRelations: string[];
  };
  timingsMs: Record<string, number>;
  batchStats: {
    writeBatchSize: number;
    successBatchCount: number;
    failureBatchCount: number;
  };
  tagStats: {
    directAssignedCount: number;
    derivedAssignedCount: number;
    avgDirectPerIndexedDocument: number;
    avgDerivedPerIndexedDocument: number;
  };
  skipStats: {
    skippedCount: number;
    skippedByExtension: Record<string, number>;
    skipCatalogRecords: number;
  };
}

interface FallbackDocument {
  document_id: string;
  path: string;
  title: string;
  summary: string;
  mtime: string;
  direct_tags: string[];
  derived_tags: string[];
}

interface FallbackFolder {
  path: string;
  name: string;
  parent_path: string | null;
  direct_document_count: number;
  document_count: number;
}

const MAX_SUMMARY_CHARS = 240;

export async function buildFallbackExport(
  config: RuntimeConfig,
  options: {
    targetPath?: string;
    reason?: string;
    signal?: AbortSignal;
  } = {}
): Promise<{
  index: FallbackExportIndexResult;
  exportResult: FallbackExportResult;
}> {
  const exportedAt = new Date().toISOString();
  const scanner = new FileScanner(config.rootDir, {
    allowedExtensions: config.allowedExtensions,
    includedHiddenPaths: config.includedHiddenPaths
  });
  const files = scanner.scan(options.targetPath, options.signal);
  const documents = files.map((file) => toFallbackDocument(config.rootDir, file));
  const filesWritten: string[] = [];

  fs.mkdirSync(config.exportDir, { recursive: true });
  fs.mkdirSync(path.join(config.exportDir, "meta"), { recursive: true });

  const statusPath = path.join(config.exportDir, "status.json");
  writeJson(statusPath, {
    version: 2,
    exported_at: exportedAt,
    document_count: documents.length,
    reason: options.reason ?? "fallback_export"
  });
  filesWritten.push(statusPath);

  const taxonomyPath = path.join(config.exportDir, "taxonomy.json");
  writeJson(taxonomyPath, {
    version: 2,
    root_types: [],
    nodes: [],
    tree: []
  });
  filesWritten.push(taxonomyPath);

  const bootstrapPath = path.join(config.exportDir, "bootstrap.json");
  writeJson(bootstrapPath, {
    version: 2,
    folders: buildFolders(documents)
  });
  filesWritten.push(bootstrapPath);

  const metaPath = path.join(config.exportDir, "meta", "fallback.json");
  writeJson(metaPath, {
    version: 2,
    shard_type: "meta",
    exported_at: exportedAt,
    documents
  });
  filesWritten.push(metaPath);

  const manifestPath = path.join(config.exportDir, "manifest.json");
  writeJson(manifestPath, {
    version: 2,
    format: "static-v2",
    generated_at: exportedAt,
    fallback: true,
    entries: {
      status: "status.json",
      taxonomy: "taxonomy.json",
      bootstrap: "bootstrap.json"
    },
    meta_shards: [
      {
        id: "meta_fallback",
        directory: ".",
        path: "meta/fallback.json",
        document_count: documents.length
      }
    ],
    detail_shards: [],
    tag_shards: [],
    relation_shards: [],
    search_buckets: []
  });
  filesWritten.push(manifestPath);

  throwIfAborted(options.signal, "文档库兜底导出已取消");
  await Promise.resolve();

  const indexedPaths = documents.map((document) => document.path);
  return {
    index: {
      scannedCount: files.length,
      indexedCount: documents.length,
      unchangedCount: 0,
      indexedPaths,
      skippedPaths: [],
      failedPaths: [],
      failedCount: 0,
      failures: [],
      failureOverflowCount: 0,
      deletedCount: 0,
      deletedPaths: [],
      dirtyScope: {
        trigger: options.targetPath ? "incremental" : "full",
        changedPaths: indexedPaths,
        dirtyDirectories: [...new Set(documents.map((document) => directoryOf(document.path)))],
        dirtyTagPaths: [],
        dirtyRelations: []
      },
      timingsMs: {},
      batchStats: {
        writeBatchSize: documents.length,
        successBatchCount: documents.length > 0 ? 1 : 0,
        failureBatchCount: 0
      },
      tagStats: {
        directAssignedCount: 0,
        derivedAssignedCount: 0,
        avgDirectPerIndexedDocument: 0,
        avgDerivedPerIndexedDocument: 0
      },
      skipStats: {
        skippedCount: 0,
        skippedByExtension: {},
        skipCatalogRecords: 0
      }
    },
    exportResult: {
      outputDir: config.exportDir,
      manifestPath,
      documentCount: documents.length,
      filesWritten,
      exportedAt
    }
  };
}

function toFallbackDocument(rootDir: string, file: FileScanResult): FallbackDocument {
  return {
    document_id: stableDocumentId(file.relativePath),
    path: file.relativePath,
    title: path.posix.basename(file.relativePath),
    summary: readSummary(path.join(rootDir, file.relativePath)),
    mtime: file.mtime,
    direct_tags: [],
    derived_tags: []
  };
}

function readSummary(filePath: string): string {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.includes(0)) {
      return "";
    }
    return buffer
      .toString("utf8")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_SUMMARY_CHARS);
  } catch {
    return "";
  }
}

function buildFolders(documents: FallbackDocument[]): FallbackFolder[] {
  const folders = new Map<string, FallbackFolder>();
  ensureFolder(folders, ".");

  for (const document of documents) {
    const directory = directoryOf(document.path);
    ensureFolder(folders, directory).direct_document_count += 1;
    let current: string | null = directory;
    while (current) {
      ensureFolder(folders, current).document_count += 1;
      current = parentOf(current);
    }
  }

  return [...folders.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
}

function ensureFolder(
  folders: Map<string, FallbackFolder>,
  folderPath: string
): FallbackFolder {
  const normalized = folderPath || ".";
  const existing = folders.get(normalized);
  if (existing) {
    return existing;
  }
  const folder = {
    path: normalized,
    name: normalized === "." ? "资料库" : path.posix.basename(normalized),
    parent_path: parentOf(normalized),
    direct_document_count: 0,
    document_count: 0
  };
  folders.set(normalized, folder);
  return folder;
}

function directoryOf(filePath: string): string {
  const directory = path.posix.dirname(filePath);
  return directory && directory !== "" ? directory : ".";
}

function parentOf(folderPath: string): string | null {
  if (!folderPath || folderPath === ".") {
    return null;
  }
  const parent = path.posix.dirname(folderPath);
  return parent && parent !== "" ? parent : ".";
}

function stableDocumentId(value: string): string {
  return `doc_${crypto.createHash("sha1").update(value).digest("hex").slice(0, 16)}`;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
