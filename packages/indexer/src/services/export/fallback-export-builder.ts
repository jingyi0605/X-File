import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { FileScanner, type FileScanResult } from "../../scanner/file-scanner.js";
import type { RuntimeConfig } from "../../types/runtime-config.js";
import type { DirtyScope } from "../dirty/dirty-scope-resolver.js";
import { throwIfAborted } from "../../utils/abort.js";
import { buildLibraryExport, type ExportBuildResult } from "./export-builder.js";
import type { ExportCatalogDataSource, ExportCatalogSnapshot } from "./export-data-source.js";

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
  dirtyScope: DirtyScope;
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

export interface FallbackExportResult extends ExportBuildResult {
  documentCount: number;
}

interface FallbackDocument {
  documentId: string;
  path: string;
  title: string;
  summary: string;
  tags: string[];
  derivedTags: string[];
  mtime: string;
}

const MAX_SUMMARY_CHARS = 240;

function createFullDirtyScope(): DirtyScope {
  return {
    trigger: "full",
    changedPaths: [],
    deletedPaths: [],
    dirtyDirectories: [],
    dirtyTagPaths: [],
    dirtyMetaShards: [],
    dirtyDetailShards: [],
    dirtyPostingBuckets: [],
    dirtyRelations: [],
  };
}

/**
 * better-sqlite3 绑定不可用时的应急导出。
 * 这里不再手搓第二套 manifest/meta/search 格式，而是把扫描结果收成最小 data source，
 * 复用正式 ExportBuilder / SearchIndexBuilder 产物契约。
 */
export async function buildFallbackExport(
  config: RuntimeConfig,
  options: {
    targetPath?: string;
    reason?: string;
    signal?: AbortSignal;
  } = {},
): Promise<{
  index: FallbackExportIndexResult;
  exportResult: FallbackExportResult;
}> {
  const scanner = new FileScanner(config.rootDir, {
    allowedExtensions: config.allowedExtensions,
    includedHiddenPaths: config.includedHiddenPaths,
  });

  // fallback 不再尝试“局部导出”特殊语义。
  // 只要走到这条应急路径，就直接扫描允许扩展名下的全部文件，保证最终导出是自洽的完整快照。
  const files = scanner.scan(undefined, options.signal);
  const indexableFiles = files.filter((file) => config.maxFileSizeBytes <= 0 || file.size <= config.maxFileSizeBytes);
  const skippedFiles = files.filter((file) => config.maxFileSizeBytes > 0 && file.size > config.maxFileSizeBytes);
  const documents = indexableFiles.map((file) => toFallbackDocument(config.rootDir, file));
  const dataSource = createFallbackExportCatalogDataSource(documents);

  throwIfAborted(options.signal, "文档库兜底导出已取消");
  const exportResult = await buildLibraryExport(config, {
    dirtyScope: createFullDirtyScope(),
    reason: options.reason ?? "fallback_export",
    signal: options.signal,
  }, dataSource);

  const indexedPaths = documents.map((document) => document.path);
  const skippedPaths = skippedFiles.map((file) => file.relativePath);
  return {
    index: {
      scannedCount: files.length,
      indexedCount: documents.length,
      unchangedCount: 0,
      indexedPaths,
      skippedPaths,
      failedPaths: [],
      failedCount: 0,
      failures: [],
      failureOverflowCount: 0,
      deletedCount: 0,
      deletedPaths: [],
      dirtyScope: {
        ...createFullDirtyScope(),
        changedPaths: [...indexedPaths, ...skippedPaths].sort((left, right) => left.localeCompare(right, "zh-Hans-CN")),
        dirtyDirectories: [...new Set([...documents.map((document) => directoryOf(document.path)), ...skippedPaths.map(directoryOf)])],
      },
      timingsMs: {},
      batchStats: {
        writeBatchSize: documents.length,
        successBatchCount: documents.length > 0 ? 1 : 0,
        failureBatchCount: 0,
      },
      tagStats: {
        directAssignedCount: 0,
        derivedAssignedCount: 0,
        avgDirectPerIndexedDocument: 0,
        avgDerivedPerIndexedDocument: 0,
      },
      skipStats: {
        skippedCount: skippedPaths.length,
        skippedByExtension: countSkippedByExtension(skippedFiles),
        skipCatalogRecords: skippedPaths.length > 0 ? 1 : 0,
      },
    },
    exportResult: {
      ...exportResult,
      documentCount: documents.length,
    },
  };
}

export function createFallbackExportCatalogDataSource(
  documents: Array<{
    documentId: string;
    path: string;
    title: string;
    summary: string;
    tags?: string[];
    derivedTags?: string[];
    mtime: string;
  }>,
): ExportCatalogDataSource {
  const snapshot: ExportCatalogSnapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    tags: [],
    documents: documents
      .map((document) => ({
        documentId: document.documentId,
        path: document.path,
        title: document.title,
        summary: document.summary,
        tags: [...(document.tags ?? [])],
        derivedTags: [...(document.derivedTags ?? [])],
        mtime: document.mtime,
      }))
      .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
  };
  return createSnapshotBackedExportCatalogDataSource(snapshot);
}

function createSnapshotBackedExportCatalogDataSource(snapshot: ExportCatalogSnapshot): ExportCatalogDataSource {
  const documentMap = new Map(snapshot.documents.map((document) => [document.documentId, cloneDocument(document)]));
  const documents = [...documentMap.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
  const tags = [...snapshot.tags].map((tag) => ({ ...tag }));
  const tagMap = new Map(tags.map((tag) => [tag.path, tag]));

  return {
    listExportTags() {
      return tags.map((tag) => ({ ...tag }));
    },
    *iterateExportDocumentRecords(batchSize = 1000) {
      for (let index = 0; index < documents.length; index += batchSize) {
        yield documents.slice(index, index + batchSize).map(cloneDocument);
      }
    },
    *iterateTagPostingRows(batchSize = 5000) {
      const rows = [
        ...buildTagPostingRows(documents, tagMap, false),
        ...buildTagPostingRows(documents, tagMap, true),
      ];
      for (let index = 0; index < rows.length; index += batchSize) {
        yield rows.slice(index, index + batchSize).map((row) => ({ ...row }));
      }
    },
    *iterateDirectTagPostingRows(batchSize = 5000) {
      const rows = buildTagPostingRows(documents, tagMap, false);
      for (let index = 0; index < rows.length; index += batchSize) {
        yield rows.slice(index, index + batchSize).map((row) => ({ ...row }));
      }
    },
    listExportDocumentsByPaths(paths: string[]) {
      const wanted = new Set(paths.map((item) => item.trim()).filter(Boolean));
      return documents
        .filter((document) => wanted.has(document.path))
        .map(cloneDocument);
    },
  };
}

function buildTagPostingRows(
  documents: FallbackDocument[],
  tagMap: Map<string, { rootType: string }>,
  derived: boolean,
) {
  const rows: Array<{
    rootType: string;
    tagPath: string;
    documentId: string;
    path: string;
    title: string;
    derived: boolean;
  }> = [];
  for (const document of documents) {
    const tagPaths = derived ? document.derivedTags : document.tags;
    for (const tagPath of tagPaths) {
      rows.push({
        rootType: tagMap.get(tagPath)?.rootType ?? inferRootType(tagPath),
        tagPath,
        documentId: document.documentId,
        path: document.path,
        title: document.title,
        derived,
      });
    }
  }
  return rows.sort((left, right) => (
    left.rootType.localeCompare(right.rootType, "zh-Hans-CN")
    || left.tagPath.localeCompare(right.tagPath, "zh-Hans-CN")
    || left.path.localeCompare(right.path, "zh-Hans-CN")
    || left.documentId.localeCompare(right.documentId, "zh-Hans-CN")
  ));
}

function inferRootType(tagPath: string): string {
  return tagPath.split("/").filter(Boolean)[0] ?? "";
}

function cloneDocument(document: FallbackDocument): FallbackDocument {
  return {
    ...document,
    tags: [...document.tags],
    derivedTags: [...document.derivedTags],
  };
}

function toFallbackDocument(rootDir: string, file: FileScanResult): FallbackDocument {
  return {
    documentId: stableDocumentId(file.relativePath),
    path: file.relativePath,
    title: path.posix.basename(file.relativePath),
    summary: readSummary(path.join(rootDir, file.relativePath)),
    tags: [],
    derivedTags: [],
    mtime: file.mtime,
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

function directoryOf(filePath: string): string {
  const directory = path.posix.dirname(filePath);
  return directory && directory !== "" ? directory : ".";
}

function stableDocumentId(value: string): string {
  return `doc_${crypto.createHash("sha1").update(value).digest("hex").slice(0, 16)}`;
}

function countSkippedByExtension(files: FileScanResult[]): Record<string, number> {
  const values = new Map<string, number>();
  for (const file of files) {
    values.set(file.extension, (values.get(file.extension) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...values.entries()].sort((left, right) => left[0].localeCompare(right[0], "zh-Hans-CN")),
  );
}
