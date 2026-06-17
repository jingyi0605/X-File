import fs from "node:fs";
import path from "node:path";
import type {
  ActiveIndexedFileState,
  IndexedDocumentBatchEntry,
  ReconcileScope,
} from "../../repositories/catalog-write-repository.js";
import {
  CatalogRepository,
  type ExportDocumentRecord,
} from "../../repositories/catalog-repository.js";
import type { ParserSkipRecordInput } from "../../parser/parser-skip-repository.js";
import type { LibraryIndexerDatabaseDriver } from "../../sqlite/open-database.js";
import type { RuntimeConfig } from "../../types/runtime-config.js";
import {
  resolveExportCatalogSnapshotPath,
  type ExportCatalogSnapshot,
} from "../export/export-data-source.js";
import type { ParserSkipCatalogRecord } from "../../parser/parser-skip-repository.js";
import {
  createSqliteTextIndexStatusStore,
  type TextIndexStatusStore,
} from "./text-index-status-store.js";
import {
  createSqliteTextIndexDocumentStore,
  type TextIndexDocumentStore,
} from "./text-index-document-store.js";
import {
  createSqliteChunkWriteStore,
  type ChunkWriteStore,
} from "./chunk-write-store.js";
import {
  createSqliteTextIndexTagStore,
  type TextIndexTagStore,
} from "./text-index-tag-store.js";
import {
  createSqliteParserSkipStore,
  type ParserSkipStore,
} from "./parser-skip-store.js";

interface RuntimeActiveIndexedFileStateRecord extends ActiveIndexedFileState {
  path: string;
}

interface RuntimeActiveFileStateSnapshot {
  version: 1;
  generatedAt: string;
  files: RuntimeActiveIndexedFileStateRecord[];
}

export interface RuntimeIndexStateSnapshot {
  version: 1;
  generatedAt: string;
  failedDocuments: RuntimeActiveIndexedFileStateRecord[];
  skippedDocuments: RuntimeActiveIndexedFileStateRecord[];
  parserSkips: ParserSkipCatalogRecord[];
}

export interface TextIndexCatalogStore {
  beginSession(): void;
  endSession(): void;
  countActiveFiles(): number;
  getActiveIndexedFileState(relativePath: string): ActiveIndexedFileState | null;
  listActiveFiles(scope?: ReconcileScope): ActiveIndexedFileState[];
  batchUpsertDocuments(entries: IndexedDocumentBatchEntry[], observedAt: string): void;
  batchUpsertParseFailures(entries: Array<{ file: IndexedDocumentBatchEntry["file"]; error: Error }>, observedAt: string): void;
  batchMarkSkippedDocuments(entries: Array<{
    file: IndexedDocumentBatchEntry["file"];
    adapter: string;
    reasonCode: string;
    message: string;
  }>, observedAt: string): void;
  recordSkip(input: ParserSkipRecordInput): ParserSkipCatalogRecord;
  reconcileScope(
    scope: ReconcileScope,
    observedAt: string,
    options?: { seenPaths?: Set<string> },
  ): { deletedCount: number; deletedPaths: string[] };
  listExportDocumentsByPaths(paths: string[]): ExportDocumentRecord[];
  deleteActiveFilesByPaths(relativePaths: string[], deletedAt?: string): { deletedCount: number; deletedPaths: string[] };
}

/**
 * 把默认 index-only 需要的“读侧”能力单独抽出来。
 * 这样后续可以先把 unchanged / active-count / dirty-scope 回读
 * 换成 runtime snapshot 或 native store，而不必连写侧一起重做。
 */
export interface TextIndexCatalogReadStore {
  countActiveFiles(): number;
  getActiveIndexedFileState(relativePath: string): ActiveIndexedFileState | null;
  listActiveFiles(scope?: ReconcileScope): ActiveIndexedFileState[];
  listExportDocumentsByPaths(paths: string[]): ExportDocumentRecord[];
}

export interface TextIndexCatalogWriteStore {
  beginSession(): void;
  endSession(): void;
  listActiveFiles(scope?: ReconcileScope): ActiveIndexedFileState[];
  batchUpsertDocuments(entries: IndexedDocumentBatchEntry[], observedAt: string): void;
  batchUpsertParseFailures(entries: Array<{ file: IndexedDocumentBatchEntry["file"]; error: Error }>, observedAt: string): void;
  batchMarkSkippedDocuments(entries: Array<{
    file: IndexedDocumentBatchEntry["file"];
    adapter: string;
    reasonCode: string;
    message: string;
  }>, observedAt: string): void;
  recordSkip(input: ParserSkipRecordInput): ParserSkipCatalogRecord;
  reconcileScope(
    scope: ReconcileScope,
    observedAt: string,
    options?: { seenPaths?: Set<string> },
  ): { deletedCount: number; deletedPaths: string[] };
  deleteActiveFilesByPaths(relativePaths: string[], deletedAt?: string): { deletedCount: number; deletedPaths: string[] };
  writeRuntimeIndexStateSnapshot?(config: RuntimeConfig): string;
}

export interface CreateTextIndexCatalogStoreOptions {
  dbPath: string;
  dbDriver?: LibraryIndexerDatabaseDriver | null;
  statusStore?: TextIndexStatusStore;
  documentStore?: TextIndexDocumentStore;
  chunkStore?: ChunkWriteStore;
  tagStore?: TextIndexTagStore;
  parserSkipStore?: ParserSkipStore;
}

export interface DefaultRuntimeBackedTextIndexStores {
  readStore: TextIndexCatalogReadStore;
  writeStore: TextIndexCatalogWriteStore;
}

function resolveRuntimeActiveFileStateSnapshotPath(config: RuntimeConfig): string {
  return path.join(config.indexDir, "runtime", "active-file-state-snapshot.json");
}

function resolveRuntimeIndexStateSnapshotPath(config: RuntimeConfig): string {
  return path.join(config.indexDir, "runtime", "index-state.json");
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function normalizeStatePath(value: string): string {
  return value.replace(/\\/g, "/").trim();
}

export function readRuntimeActiveFileStateSnapshot(
  config: RuntimeConfig,
): RuntimeActiveFileStateSnapshot | null {
  const snapshot = readJsonFile<RuntimeActiveFileStateSnapshot>(
    resolveRuntimeActiveFileStateSnapshotPath(config),
  );
  if (!snapshot || !Array.isArray(snapshot.files)) {
    return null;
  }
  return {
    version: 1,
    generatedAt: snapshot.generatedAt ?? new Date(0).toISOString(),
    files: snapshot.files
      .filter((item) => item && typeof item.path === "string")
      .map((item) => ({
        path: normalizeStatePath(item.path),
        extension: typeof item.extension === "string" ? item.extension : "",
        size: Number(item.size ?? 0),
        mtime: typeof item.mtime === "string" ? item.mtime : "",
        indexStatus: typeof item.indexStatus === "string" ? item.indexStatus : "",
      }))
      .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
  };
}

export function writeRuntimeActiveFileStateSnapshot(
  config: RuntimeConfig,
  files: RuntimeActiveIndexedFileStateRecord[],
): string {
  const snapshotPath = resolveRuntimeActiveFileStateSnapshotPath(config);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(
    snapshotPath,
    `${JSON.stringify({
      version: 1,
      generatedAt: new Date().toISOString(),
      files: [...files]
        .map((item) => ({
          path: normalizeStatePath(item.path),
          extension: item.extension,
          size: item.size,
          mtime: item.mtime,
          indexStatus: item.indexStatus,
        }))
        .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
    }, null, 2)}\n`,
    "utf-8",
  );
  return snapshotPath;
}

export function writeRuntimeIndexStateSnapshot(
  config: RuntimeConfig,
  snapshot: RuntimeIndexStateSnapshot,
): string {
  const snapshotPath = resolveRuntimeIndexStateSnapshotPath(config);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(
    snapshotPath,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf-8",
  );
  return snapshotPath;
}

export function readRuntimeIndexStateSnapshot(
  config: RuntimeConfig,
): RuntimeIndexStateSnapshot | null {
  const snapshot = readJsonFile<RuntimeIndexStateSnapshot>(
    resolveRuntimeIndexStateSnapshotPath(config),
  );
  if (!snapshot) {
    return null;
  }
  return {
    version: 1,
    generatedAt: snapshot.generatedAt ?? new Date(0).toISOString(),
    failedDocuments: Array.isArray(snapshot.failedDocuments) ? snapshot.failedDocuments : [],
    skippedDocuments: Array.isArray(snapshot.skippedDocuments) ? snapshot.skippedDocuments : [],
    parserSkips: Array.isArray(snapshot.parserSkips) ? snapshot.parserSkips : [],
  };
}

/**
 * 把 TextIndexer 依赖的 SQLite 读写面压成最小 store，避免索引主流程直接操作多个 repository。
 */
export function createSqliteTextIndexCatalogStore(
  options: CreateTextIndexCatalogStoreOptions,
): TextIndexCatalogStore {
  const repository = new CatalogRepository(options.dbPath, {}, options.dbDriver ?? null);
  const parserSkipStore = options.parserSkipStore ?? createSqliteParserSkipStore({
    dbPath: options.dbPath,
    dbDriver: options.dbDriver ?? null,
  });
  const statusStore = options.statusStore ?? createSqliteTextIndexStatusStore({
    dbPath: options.dbPath,
    dbDriver: options.dbDriver ?? null,
  });
  const documentStore = options.documentStore ?? createSqliteTextIndexDocumentStore({
    dbPath: options.dbPath,
    dbDriver: options.dbDriver ?? null,
  });
  const chunkStore = options.chunkStore ?? createSqliteChunkWriteStore({
    dbPath: options.dbPath,
    dbDriver: options.dbDriver ?? null,
  });
  const tagStore = options.tagStore ?? createSqliteTextIndexTagStore({
    dbPath: options.dbPath,
    dbDriver: options.dbDriver ?? null,
  });

  return {
    beginSession(): void {
      parserSkipStore.beginSession();
    },
    endSession(): void {
      parserSkipStore.endSession();
    },
    countActiveFiles(): number {
      return statusStore.countActiveFiles();
    },
    getActiveIndexedFileState(relativePath: string): ActiveIndexedFileState | null {
      return statusStore.getActiveIndexedFileState(relativePath);
    },
    listActiveFiles(scope: ReconcileScope = { kind: "all" }): ActiveIndexedFileState[] {
      return statusStore.listActiveFiles(scope);
    },
    batchUpsertDocuments(entries: IndexedDocumentBatchEntry[], observedAt: string): void {
      const tagContexts = tagStore.captureBatchUpsertContexts(entries);
      statusStore.batchUpsertIndexedDocuments(entries.map((entry) => entry.file), observedAt);
      documentStore.batchUpsertDocuments(entries, observedAt);
      chunkStore.batchUpsertDocuments(entries, observedAt);
      tagStore.batchUpsertDocuments(entries, observedAt, tagContexts);
    },
    batchUpsertParseFailures(entries, observedAt): void {
      statusStore.batchUpsertParseFailures(entries, observedAt);
    },
    batchMarkSkippedDocuments(entries, observedAt): void {
      statusStore.batchMarkSkippedDocuments(entries, observedAt);
    },
    recordSkip(input: ParserSkipRecordInput): ParserSkipCatalogRecord {
      return parserSkipStore.record(input);
    },
    reconcileScope(scope, observedAt, optionsArg): { deletedCount: number; deletedPaths: string[] } {
      const activeFiles = statusStore.listActiveFiles(scope);
      const seenPaths = optionsArg?.seenPaths ?? new Set<string>();
      const candidatePaths = activeFiles
        .filter((item) => !seenPaths.has(item.path))
        .map((item) => item.path);
      return statusStore.deleteActiveFilesByPaths(candidatePaths, observedAt);
    },
    deleteActiveFilesByPaths(relativePaths: string[], deletedAt?: string): { deletedCount: number; deletedPaths: string[] } {
      return statusStore.deleteActiveFilesByPaths(relativePaths, deletedAt);
    },
    listExportDocumentsByPaths(paths: string[]): ExportDocumentRecord[] {
      return repository.listExportDocumentsByPaths(paths);
    },
  };
}

export function createSqliteTextIndexCatalogReadStore(
  options: CreateTextIndexCatalogStoreOptions,
): TextIndexCatalogReadStore {
  const store = createSqliteTextIndexCatalogStore(options);
  return {
    countActiveFiles(): number {
      return store.countActiveFiles();
    },
    getActiveIndexedFileState(relativePath: string): ActiveIndexedFileState | null {
      return store.getActiveIndexedFileState(relativePath);
    },
    listActiveFiles(scope: ReconcileScope = { kind: "all" }): ActiveIndexedFileState[] {
      return store.listActiveFiles(scope);
    },
    listExportDocumentsByPaths(paths: string[]): ExportDocumentRecord[] {
      return store.listExportDocumentsByPaths(paths);
    },
  };
}

export function createSqliteTextIndexCatalogWriteStore(
  options: CreateTextIndexCatalogStoreOptions,
): TextIndexCatalogWriteStore {
  const store = createSqliteTextIndexCatalogStore(options);
  return {
    beginSession(): void {
      store.beginSession();
    },
    endSession(): void {
      store.endSession();
    },
    listActiveFiles(scope: ReconcileScope = { kind: "all" }): ActiveIndexedFileState[] {
      return store.listActiveFiles(scope);
    },
    batchUpsertDocuments(entries, observedAt): void {
      store.batchUpsertDocuments(entries, observedAt);
    },
    batchUpsertParseFailures(entries, observedAt): void {
      store.batchUpsertParseFailures(entries, observedAt);
    },
    batchMarkSkippedDocuments(entries, observedAt): void {
      store.batchMarkSkippedDocuments(entries, observedAt);
    },
    recordSkip(input: ParserSkipRecordInput): ParserSkipCatalogRecord {
      return store.recordSkip(input);
    },
    reconcileScope(scope, observedAt, optionsArg): { deletedCount: number; deletedPaths: string[] } {
      return store.reconcileScope(scope, observedAt, optionsArg);
    },
    deleteActiveFilesByPaths(relativePaths: string[], deletedAt?: string): { deletedCount: number; deletedPaths: string[] } {
      return store.deleteActiveFilesByPaths(relativePaths, deletedAt);
    },
  };
}

export function createRuntimeMirroredTextIndexCatalogWriteStore(
  config: RuntimeConfig,
  baseStore: TextIndexCatalogWriteStore,
): TextIndexCatalogWriteStore {
  const state = readRuntimeIndexStateSnapshot(config) ?? {
    version: 1 as const,
    generatedAt: new Date().toISOString(),
    failedDocuments: [],
    skippedDocuments: [],
    parserSkips: [],
  };
  const failedDocuments = new Map(state.failedDocuments.map((item) => [item.path, item]));
  const skippedDocuments = new Map(state.skippedDocuments.map((item) => [item.path, item]));
  const parserSkips = new Map(state.parserSkips.map((item) => [item.skipKey, item]));

  const persist = (): string => writeRuntimeIndexStateSnapshot(config, {
    version: 1,
    generatedAt: new Date().toISOString(),
    failedDocuments: [...failedDocuments.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
    skippedDocuments: [...skippedDocuments.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
    parserSkips: [...parserSkips.values()].sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt, "zh-Hans-CN")),
  });

  const markActiveDocument = (pathValue: string): void => {
    failedDocuments.delete(pathValue);
    skippedDocuments.delete(pathValue);
  };

  return {
    beginSession(): void {
      baseStore.beginSession();
    },
    endSession(): void {
      baseStore.endSession();
      persist();
    },
    listActiveFiles(scope?: ReconcileScope): ActiveIndexedFileState[] {
      return baseStore.listActiveFiles(scope);
    },
    batchUpsertDocuments(entries, observedAt): void {
      baseStore.batchUpsertDocuments(entries, observedAt);
      for (const entry of entries) {
        markActiveDocument(entry.file.relativePath);
      }
      persist();
    },
    batchUpsertParseFailures(entries, observedAt): void {
      baseStore.batchUpsertParseFailures(entries, observedAt);
      for (const entry of entries) {
        const pathValue = entry.file.relativePath;
        skippedDocuments.delete(pathValue);
        failedDocuments.set(pathValue, {
          path: pathValue,
          extension: entry.file.extension,
          size: entry.file.size,
          mtime: entry.file.mtime,
          indexStatus: "failed",
        });
      }
      persist();
    },
    batchMarkSkippedDocuments(entries, observedAt): void {
      baseStore.batchMarkSkippedDocuments(entries, observedAt);
      for (const entry of entries) {
        const pathValue = entry.file.relativePath;
        failedDocuments.delete(pathValue);
        skippedDocuments.set(pathValue, {
          path: pathValue,
          extension: entry.file.extension,
          size: entry.file.size,
          mtime: entry.file.mtime,
          indexStatus: "skipped",
        });
      }
      persist();
    },
    recordSkip(input: ParserSkipRecordInput): ParserSkipCatalogRecord {
      const record = baseStore.recordSkip(input);
      parserSkips.set(record.skipKey, record);
      persist();
      return record;
    },
    reconcileScope(scope, observedAt, optionsArg): { deletedCount: number; deletedPaths: string[] } {
      const result = baseStore.reconcileScope(scope, observedAt, optionsArg);
      for (const deletedPath of result.deletedPaths) {
        failedDocuments.delete(deletedPath);
        skippedDocuments.delete(deletedPath);
      }
      persist();
      return result;
    },
    deleteActiveFilesByPaths(relativePaths: string[], deletedAt?: string): { deletedCount: number; deletedPaths: string[] } {
      const result = baseStore.deleteActiveFilesByPaths(relativePaths, deletedAt);
      for (const deletedPath of result.deletedPaths) {
        failedDocuments.delete(deletedPath);
        skippedDocuments.delete(deletedPath);
      }
      persist();
      return result;
    },
    writeRuntimeIndexStateSnapshot(configArg: RuntimeConfig = config): string {
      if (configArg !== config) {
        return writeRuntimeIndexStateSnapshot(configArg, {
          version: 1,
          generatedAt: new Date().toISOString(),
          failedDocuments: [...failedDocuments.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
          skippedDocuments: [...skippedDocuments.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
          parserSkips: [...parserSkips.values()].sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt, "zh-Hans-CN")),
        });
      }
      return persist();
    },
  };
}

export function createRuntimeTextIndexCatalogReadStore(
  config: RuntimeConfig,
): TextIndexCatalogReadStore {
  const readActiveStateMap = (): Map<string, RuntimeActiveIndexedFileStateRecord> => {
    const snapshot = readRuntimeActiveFileStateSnapshot(config);
    return new Map((snapshot?.files ?? []).map((item) => [item.path, item]));
  };

  const readExportDocumentMap = (): Map<string, ExportDocumentRecord> => {
    const snapshot = readJsonFile<ExportCatalogSnapshot>(resolveExportCatalogSnapshotPath(config));
    const documents = Array.isArray(snapshot?.documents) ? snapshot.documents : [];
    return new Map(
      documents
        .filter((item) => item && typeof item.path === "string")
        .map((item) => [normalizeStatePath(item.path), item]),
    );
  };

  return {
    countActiveFiles(): number {
      return readActiveStateMap().size;
    },
    getActiveIndexedFileState(relativePath: string): ActiveIndexedFileState | null {
      const record = readActiveStateMap().get(normalizeStatePath(relativePath));
      if (!record) {
        return null;
      }
      return {
        path: record.path,
        extension: record.extension,
        size: record.size,
        mtime: record.mtime,
        indexStatus: record.indexStatus,
      };
    },
    listActiveFiles(scope: ReconcileScope = { kind: "all" }): ActiveIndexedFileState[] {
      const values = [...readActiveStateMap().values()];
      if (scope.kind === "exact" && scope.value) {
        const normalizedPath = normalizeStatePath(scope.value);
        return values.filter((item) => item.path === normalizedPath);
      }
      if (scope.kind === "prefix" && scope.value) {
        const normalizedPrefix = normalizeStatePath(scope.value).replace(/\/+$/, "");
        return values.filter((item) => item.path === normalizedPrefix || item.path.startsWith(`${normalizedPrefix}/`));
      }
      return values;
    },
    listExportDocumentsByPaths(paths: string[]): ExportDocumentRecord[] {
      const documentMap = readExportDocumentMap();
      return paths
        .map((item) => documentMap.get(normalizeStatePath(item)))
        .filter((item): item is ExportDocumentRecord => Boolean(item))
        .map((item) => ({
          ...item,
          tags: [...item.tags],
          derivedTags: [...item.derivedTags],
        }));
    },
  };
}

export function createRuntimePreferredTextIndexCatalogReadStore(
  config: RuntimeConfig,
  fallback: TextIndexCatalogReadStore,
): TextIndexCatalogReadStore {
  const runtimeStore = createRuntimeTextIndexCatalogReadStore(config);
  return {
    countActiveFiles(): number {
      const runtimeCount = runtimeStore.countActiveFiles();
      return runtimeCount > 0 ? runtimeCount : fallback.countActiveFiles();
    },
    getActiveIndexedFileState(relativePath: string): ActiveIndexedFileState | null {
      return runtimeStore.getActiveIndexedFileState(relativePath)
        ?? fallback.getActiveIndexedFileState(relativePath);
    },
    listActiveFiles(scope: ReconcileScope = { kind: "all" }): ActiveIndexedFileState[] {
      const runtimeFiles = runtimeStore.listActiveFiles(scope);
      return runtimeFiles.length > 0 ? runtimeFiles : fallback.listActiveFiles(scope);
    },
    listExportDocumentsByPaths(paths: string[]): ExportDocumentRecord[] {
      const runtimeDocuments = runtimeStore.listExportDocumentsByPaths(paths);
      if (runtimeDocuments.length === paths.length) {
        return runtimeDocuments;
      }
      const runtimeMap = new Map(runtimeDocuments.map((item) => [normalizeStatePath(item.path), item]));
      const missingPaths = paths.filter((item) => !runtimeMap.has(normalizeStatePath(item)));
      const fallbackDocuments = fallback.listExportDocumentsByPaths(missingPaths);
      return [
        ...runtimeDocuments,
        ...fallbackDocuments,
      ].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
    },
  };
}

export function createDefaultRuntimeBackedTextIndexStores(
  config: RuntimeConfig,
  dbDriver: LibraryIndexerDatabaseDriver | null = null,
): DefaultRuntimeBackedTextIndexStores {
  const sqliteReadStore = createSqliteTextIndexCatalogReadStore({
    dbPath: config.dbPath,
    dbDriver,
  });
  const sqliteWriteStore = createSqliteTextIndexCatalogWriteStore({
    dbPath: config.dbPath,
    dbDriver,
  });
  return {
    readStore: createRuntimePreferredTextIndexCatalogReadStore(config, sqliteReadStore),
    writeStore: createRuntimeMirroredTextIndexCatalogWriteStore(config, sqliteWriteStore),
  };
}
