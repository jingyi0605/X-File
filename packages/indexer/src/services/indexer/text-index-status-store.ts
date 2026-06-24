import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { FileScanResult } from "../../scanner/file-scanner.js";
import {
  openDatabase,
  type LibraryIndexerDatabase,
  type LibraryIndexerDatabaseDriver,
  type LibraryIndexerStatement,
} from "../../sqlite/open-database.js";
import type { ActiveIndexedFileState, ReconcileScope } from "../../repositories/catalog-write-repository.js";
import type { RuntimeConfig } from "../../types/runtime-config.js";

export interface SkippedDocumentStatusEntry {
  file: FileScanResult;
  adapter: string;
  reasonCode: string;
  message: string;
}

export interface TextIndexStatusStore {
  countActiveFiles(): number;
  listActiveFiles(scope?: ReconcileScope): ActiveIndexedFileState[];
  getActiveIndexedFileState(relativePath: string): ActiveIndexedFileState | null;
  batchUpsertIndexedDocuments(
    entries: FileScanResult[],
    observedAt?: string,
  ): Array<{ fileId: string; documentId: string }>;
  batchUpsertParseFailures(
    entries: Array<{ file: FileScanResult; error: Error }>,
    observedAt?: string,
  ): Array<{ fileId: string; documentId: string }>;
  batchMarkSkippedDocuments(
    entries: SkippedDocumentStatusEntry[],
    observedAt?: string,
  ): Array<{ fileId: string; documentId: string }>;
  deleteActiveFilesByPaths(
    relativePaths: string[],
    deletedAt?: string,
  ): { deletedCount: number; deletedPaths: string[] };
}

interface StatusStatements {
  upsertFile: LibraryIndexerStatement;
  upsertDocumentStatus: LibraryIndexerStatement;
  selectFileByPath: LibraryIndexerStatement;
  selectDocumentByFileId: LibraryIndexerStatement;
  markFileDeleted: LibraryIndexerStatement;
  deleteDocumentTags: LibraryIndexerStatement;
  deleteDerivedDocumentTags: LibraryIndexerStatement;
  deleteChunksByDocumentId: LibraryIndexerStatement;
  listActiveFilesAll: LibraryIndexerStatement;
  listActiveFilesExact: LibraryIndexerStatement;
  listActiveFilesPrefix: LibraryIndexerStatement;
  countActiveFiles: LibraryIndexerStatement;
  selectActiveIndexedFileStateByPath: LibraryIndexerStatement;
}

interface RuntimeActiveIndexedFileStateRecord extends ActiveIndexedFileState {
  path: string;
}

interface RuntimeActiveFileStateSnapshot {
  version: 1;
  generatedAt: string;
  files: RuntimeActiveIndexedFileStateRecord[];
}

interface RuntimeIndexStateSnapshot {
  version: 1;
  generatedAt: string;
  failedDocuments: RuntimeActiveIndexedFileStateRecord[];
  skippedDocuments: RuntimeActiveIndexedFileStateRecord[];
  parserSkips: unknown[];
}

function makeStableId(prefix: string, value: string): string {
  const digest = crypto.createHash("sha1").update(value).digest("hex");
  return `${prefix}_${digest}`;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
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

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function matchesScope(pathValue: string, scope: ReconcileScope): boolean {
  if (scope.kind === "exact" && scope.value) {
    return pathValue === normalizeRelativePath(scope.value);
  }
  if (scope.kind === "prefix" && scope.value) {
    const normalizedPrefix = normalizeRelativePath(scope.value).replace(/\/+$/, "");
    return pathValue === normalizedPrefix || pathValue.startsWith(`${normalizedPrefix}/`);
  }
  return true;
}

function toRuntimeState(
  input: Pick<FileScanResult, "relativePath" | "extension" | "size" | "mtime">,
  indexStatus: string,
): RuntimeActiveIndexedFileStateRecord {
  return {
    path: normalizeRelativePath(input.relativePath),
    extension: input.extension,
    size: input.size,
    mtime: input.mtime,
    indexStatus,
  };
}

export function createRuntimeTextIndexStatusStore(
  config: RuntimeConfig,
  mirrorStore: TextIndexStatusStore | null = null,
): TextIndexStatusStore {
  const activeSnapshot = readJsonFile<RuntimeActiveFileStateSnapshot>(
    resolveRuntimeActiveFileStateSnapshotPath(config),
  );
  const indexSnapshot = readJsonFile<RuntimeIndexStateSnapshot>(
    resolveRuntimeIndexStateSnapshotPath(config),
  );
  const activeFiles = new Map(
    (activeSnapshot?.files ?? []).map((item) => [normalizeRelativePath(item.path), {
      ...item,
      path: normalizeRelativePath(item.path),
    } satisfies RuntimeActiveIndexedFileStateRecord]),
  );
  const failedDocuments = new Map(
    (indexSnapshot?.failedDocuments ?? []).map((item) => [normalizeRelativePath(item.path), {
      ...item,
      path: normalizeRelativePath(item.path),
    } satisfies RuntimeActiveIndexedFileStateRecord]),
  );
  const skippedDocuments = new Map(
    (indexSnapshot?.skippedDocuments ?? []).map((item) => [normalizeRelativePath(item.path), {
      ...item,
      path: normalizeRelativePath(item.path),
    } satisfies RuntimeActiveIndexedFileStateRecord]),
  );
  const parserSkips = Array.isArray(indexSnapshot?.parserSkips) ? [...indexSnapshot.parserSkips] : [];

  const persist = (): void => {
    writeJsonFile(resolveRuntimeActiveFileStateSnapshotPath(config), {
      version: 1,
      generatedAt: new Date().toISOString(),
      files: [...activeFiles.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
    } satisfies RuntimeActiveFileStateSnapshot);
    writeJsonFile(resolveRuntimeIndexStateSnapshotPath(config), {
      version: 1,
      generatedAt: new Date().toISOString(),
      failedDocuments: [...failedDocuments.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
      skippedDocuments: [...skippedDocuments.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
      parserSkips,
    } satisfies RuntimeIndexStateSnapshot);
  };

  const clearDerivedState = (pathValue: string): void => {
    failedDocuments.delete(pathValue);
    skippedDocuments.delete(pathValue);
  };

  return {
    countActiveFiles(): number {
      return activeFiles.size;
    },
    listActiveFiles(scope: ReconcileScope = { kind: "all" }): ActiveIndexedFileState[] {
      return [...activeFiles.values()]
        .filter((item) => matchesScope(item.path, scope))
        .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
    },
    getActiveIndexedFileState(relativePath: string): ActiveIndexedFileState | null {
      return activeFiles.get(normalizeRelativePath(relativePath)) ?? null;
    },
    batchUpsertIndexedDocuments(entries, observedAt = new Date().toISOString()) {
      for (const file of entries) {
        const record = toRuntimeState(file, "indexed");
        activeFiles.set(record.path, record);
        clearDerivedState(record.path);
      }
      persist();
      return mirrorStore?.batchUpsertIndexedDocuments(entries, observedAt) ?? entries.map((file) => ({
        fileId: makeStableId("file", file.relativePath),
        documentId: makeStableId("doc", file.relativePath),
      }));
    },
    batchUpsertParseFailures(entries, observedAt = new Date().toISOString()) {
      for (const entry of entries) {
        const record = toRuntimeState(entry.file, "failed");
        activeFiles.set(record.path, record);
        skippedDocuments.delete(record.path);
        failedDocuments.set(record.path, record);
      }
      persist();
      return mirrorStore?.batchUpsertParseFailures(entries, observedAt) ?? entries.map(({ file }) => ({
        fileId: makeStableId("file", file.relativePath),
        documentId: makeStableId("doc", file.relativePath),
      }));
    },
    batchMarkSkippedDocuments(entries, observedAt = new Date().toISOString()) {
      for (const entry of entries) {
        const record = toRuntimeState(entry.file, "skipped");
        activeFiles.set(record.path, record);
        failedDocuments.delete(record.path);
        skippedDocuments.set(record.path, record);
      }
      persist();
      return mirrorStore?.batchMarkSkippedDocuments(entries, observedAt) ?? entries.map(({ file }) => ({
        fileId: makeStableId("file", file.relativePath),
        documentId: makeStableId("doc", file.relativePath),
      }));
    },
    deleteActiveFilesByPaths(relativePaths, deletedAt = new Date().toISOString()) {
      const deletedPaths = [...new Set(relativePaths.map((item) => normalizeRelativePath(item)).filter(Boolean))]
        .filter((item) => activeFiles.delete(item));
      for (const pathValue of deletedPaths) {
        clearDerivedState(pathValue);
      }
      persist();
      const mirrored = mirrorStore?.deleteActiveFilesByPaths(deletedPaths, deletedAt);
      return mirrored ?? {
        deletedCount: deletedPaths.length,
        deletedPaths,
      };
    },
  };
}

function normalizeFileIdentityValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function createSqliteTextIndexStatusStore(input: {
  dbPath: string;
  dbDriver?: LibraryIndexerDatabaseDriver | null;
}): TextIndexStatusStore {
  const openConnection = (): LibraryIndexerDatabase => (
    input.dbDriver
      ? input.dbDriver.open(input.dbPath)
      : openDatabase(input.dbPath)
  );

  const withConnection = <T>(handler: (db: LibraryIndexerDatabase, statements: StatusStatements) => T): T => {
    const db = openConnection();
    const statements = prepareStatements(db);
    try {
      return handler(db, statements);
    } finally {
      db.close();
    }
  };

  const upsertFileStatus = (
    statements: StatusStatements,
    file: FileScanResult,
    observedAt: string,
  ): { fileId: string; documentId: string } => {
    const fileId = makeStableId("file", file.relativePath);
    const documentId = makeStableId("doc", file.relativePath);
    statements.upsertFile.run(
      fileId,
      file.relativePath,
      file.relativePath.includes("/") ? file.relativePath.slice(0, file.relativePath.lastIndexOf("/")) : ".",
      file.name,
      file.extension,
      file.size,
      file.mtime,
      file.ctime,
      normalizeFileIdentityValue(file.inodeKey),
      observedAt,
    );
    return { fileId, documentId };
  };

  const markDeleted = (
    db: LibraryIndexerDatabase,
    statements: StatusStatements,
    relativePath: string,
    deletedAt: string,
  ): boolean => {
    const normalizedPath = normalizeRelativePath(relativePath);
    const fileRow = statements.selectFileByPath.get(normalizedPath) as { id?: string } | undefined;
    if (!fileRow?.id) {
      return false;
    }
    const documentRow = statements.selectDocumentByFileId.get(fileRow.id) as { id?: string } | undefined;
    if (documentRow?.id) {
      statements.deleteChunksByDocumentId.run(documentRow.id);
      statements.deleteDocumentTags.run(documentRow.id);
      statements.deleteDerivedDocumentTags.run(documentRow.id);
    }
    statements.markFileDeleted.run(deletedAt, fileRow.id);
    return true;
  };

  return {
    countActiveFiles(): number {
      return withConnection((_, statements) => {
        const row = statements.countActiveFiles.get() as { count?: number } | undefined;
        return Number(row?.count ?? 0);
      });
    },
    listActiveFiles(scope: ReconcileScope = { kind: "all" }): ActiveIndexedFileState[] {
      return withConnection((_, statements) => {
        let rows: Array<{ path: string }> = [];
        if (scope.kind === "exact" && scope.value) {
          rows = statements.listActiveFilesExact.all(normalizeRelativePath(scope.value)) as Array<{ path: string }>;
        } else if (scope.kind === "prefix" && scope.value) {
          const normalizedPrefix = normalizeRelativePath(scope.value).replace(/\/+$/, "");
          rows = statements.listActiveFilesPrefix.all(normalizedPrefix, `${normalizedPrefix}/%`) as Array<{ path: string }>;
        } else {
          rows = statements.listActiveFilesAll.all() as Array<{ path: string }>;
        }
        return rows
          .map((row) => this.getActiveIndexedFileState(row.path))
          .filter((item): item is ActiveIndexedFileState => Boolean(item));
      });
    },
    getActiveIndexedFileState(relativePath: string): ActiveIndexedFileState | null {
      return withConnection((_, statements) => {
        const row = statements.selectActiveIndexedFileStateByPath.get(
          normalizeRelativePath(relativePath),
        ) as Record<string, unknown> | undefined;
        if (!row?.path) {
          return null;
        }
        return {
          path: String(row.path),
          extension: String(row.extension ?? ""),
          size: Number(row.size ?? 0),
          mtime: String(row.mtime ?? ""),
          indexStatus: String(row.index_status ?? ""),
        };
      });
    },
    batchUpsertIndexedDocuments(entries, observedAt = new Date().toISOString()) {
      if (entries.length === 0) {
        return [];
      }
      return withConnection((db, statements) => {
        try {
          db.exec("BEGIN IMMEDIATE");
          const results = entries.map((file) => {
            const status = upsertFileStatus(statements, file, observedAt);
            statements.upsertDocumentStatus.run(
              status.documentId,
              status.fileId,
              file.name,
              "",
              "parsed",
              null,
              "indexed",
              observedAt,
            );
            return status;
          });
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    },
    batchUpsertParseFailures(entries, observedAt = new Date().toISOString()) {
      if (entries.length === 0) {
        return [];
      }
      return withConnection((db, statements) => {
        try {
          db.exec("BEGIN IMMEDIATE");
          const results = entries.map(({ file, error }) => {
            const status = upsertFileStatus(statements, file, observedAt);
            statements.upsertDocumentStatus.run(
              status.documentId,
              status.fileId,
              file.name,
              "",
              "failed",
              error.message,
              "failed",
              observedAt,
            );
            statements.deleteChunksByDocumentId.run(status.documentId);
            statements.deleteDocumentTags.run(status.documentId);
            statements.deleteDerivedDocumentTags.run(status.documentId);
            return status;
          });
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    },
    batchMarkSkippedDocuments(entries, observedAt = new Date().toISOString()) {
      if (entries.length === 0) {
        return [];
      }
      return withConnection((db, statements) => {
        try {
          db.exec("BEGIN IMMEDIATE");
          const results = entries.map((entry) => {
            const { file, adapter, reasonCode, message } = entry;
            const status = upsertFileStatus(statements, file, observedAt);
            statements.upsertDocumentStatus.run(
              status.documentId,
              status.fileId,
              file.name,
              "",
              "skipped",
              `${reasonCode}: ${adapter}${message ? ` - ${message}` : ""}`,
              "skipped",
              observedAt,
            );
            statements.deleteChunksByDocumentId.run(status.documentId);
            statements.deleteDocumentTags.run(status.documentId);
            statements.deleteDerivedDocumentTags.run(status.documentId);
            return status;
          });
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    },
    deleteActiveFilesByPaths(relativePaths, deletedAt = new Date().toISOString()) {
      const uniquePaths = [...new Set(relativePaths.map((item) => normalizeRelativePath(item)).filter(Boolean))];
      if (uniquePaths.length === 0) {
        return { deletedCount: 0, deletedPaths: [] };
      }
      return withConnection((db, statements) => {
        try {
          db.exec("BEGIN IMMEDIATE");
          const deletedPaths: string[] = [];
          for (const relativePath of uniquePaths) {
            if (markDeleted(db, statements, relativePath, deletedAt)) {
              deletedPaths.push(relativePath);
            }
          }
          db.exec("COMMIT");
          return {
            deletedCount: deletedPaths.length,
            deletedPaths,
          };
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    },
  };
}

function prepareStatements(db: LibraryIndexerDatabase): StatusStatements {
  return {
    upsertFile: db.prepare(`
      INSERT INTO files(id, path, dir_path, name, extension, size, mtime, ctime, inode_key, content_hash, status, last_seen_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', ?)
      ON CONFLICT(path) DO UPDATE SET
        dir_path = excluded.dir_path,
        name = excluded.name,
        extension = excluded.extension,
        size = excluded.size,
        mtime = excluded.mtime,
        ctime = excluded.ctime,
        inode_key = excluded.inode_key,
        content_hash = NULL,
        status = 'active',
        last_seen_at = excluded.last_seen_at
    `),
    upsertDocumentStatus: db.prepare(`
      INSERT INTO documents(id, file_id, title, summary, language, parse_status, parse_error, index_status, chunk_count, last_indexed_at)
      VALUES(?, ?, ?, ?, 'zh', ?, ?, ?, 0, ?)
      ON CONFLICT(file_id) DO UPDATE SET
        id = excluded.id,
        title = excluded.title,
        summary = excluded.summary,
        parse_status = excluded.parse_status,
        parse_error = excluded.parse_error,
        index_status = excluded.index_status,
        chunk_count = 0,
        last_indexed_at = excluded.last_indexed_at
    `),
    selectFileByPath: db.prepare(`SELECT id FROM files WHERE path = ?`),
    selectDocumentByFileId: db.prepare(`SELECT id FROM documents WHERE file_id = ?`),
    markFileDeleted: db.prepare(`
      UPDATE files
      SET status = 'deleted',
          last_seen_at = ?
      WHERE id = ?
    `),
    deleteDocumentTags: db.prepare(`DELETE FROM document_tags WHERE document_id = ?`),
    deleteDerivedDocumentTags: db.prepare(`DELETE FROM derived_document_tags WHERE document_id = ?`),
    deleteChunksByDocumentId: db.prepare(`DELETE FROM chunks WHERE document_id = ?`),
    listActiveFilesAll: db.prepare(`SELECT path FROM files WHERE status = 'active'`),
    listActiveFilesExact: db.prepare(`SELECT path FROM files WHERE status = 'active' AND path = ?`),
    listActiveFilesPrefix: db.prepare(`SELECT path FROM files WHERE status = 'active' AND (path = ? OR path LIKE ?)`),
    countActiveFiles: db.prepare(`SELECT COUNT(*) AS count FROM files WHERE status = 'active'`),
    selectActiveIndexedFileStateByPath: db.prepare(`
      SELECT
        f.path,
        f.extension,
        f.size,
        f.mtime,
        d.index_status
      FROM files f
      JOIN documents d ON d.file_id = f.id
      WHERE f.path = ?
        AND f.status = 'active'
        AND d.index_status IN ('indexed', 'failed', 'skipped')
      LIMIT 1
    `),
  };
}
