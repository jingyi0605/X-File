import fs from "node:fs";
import path from "node:path";
import type { FileScanResult } from "../../scanner/file-scanner.js";
import { openDatabase, type LibraryIndexerDatabase, type LibraryIndexerDatabaseDriver, type LibraryIndexerStatement } from "../../sqlite/open-database.js";
import type { IndexedDocumentBatchEntry } from "../../repositories/catalog-write-repository.js";
import type { RuntimeConfig } from "../../types/runtime-config.js";
import { resolveExportCatalogSnapshotPath, type ExportCatalogSnapshot } from "../export/export-data-source.js";
import { makeStableId, normalizeRelativePath } from "./text-index-write-helpers.js";

export interface TextIndexDocumentStore {
  batchUpsertDocuments(
    entries: IndexedDocumentBatchEntry[],
    observedAt?: string,
  ): Array<{ fileId: string; documentId: string }>;
  deleteDocumentsByPaths?(relativePaths: string[]): void;
}

interface DocumentStatements {
  upsertFile: LibraryIndexerStatement;
  upsertDocument: LibraryIndexerStatement;
}

function openConnection(dbPath: string, dbDriver?: LibraryIndexerDatabaseDriver | null): LibraryIndexerDatabase {
  return dbDriver ? dbDriver.open(dbPath) : openDatabase(dbPath);
}

function prepareStatements(db: LibraryIndexerDatabase): DocumentStatements {
  return {
    upsertFile: db.prepare(`
      INSERT INTO files(id, path, dir_path, name, extension, size, mtime, ctime, inode_key, content_hash, status, last_seen_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(path) DO UPDATE SET
        dir_path = excluded.dir_path,
        name = excluded.name,
        extension = excluded.extension,
        size = excluded.size,
        mtime = excluded.mtime,
        ctime = excluded.ctime,
        inode_key = excluded.inode_key,
        content_hash = excluded.content_hash,
        status = 'active',
        last_seen_at = excluded.last_seen_at
    `),
    upsertDocument: db.prepare(`
      INSERT INTO documents(id, file_id, title, summary, language, parse_status, parse_error, index_status, chunk_count, last_indexed_at)
      VALUES(?, ?, ?, ?, 'zh', ?, ?, ?, ?, ?)
      ON CONFLICT(file_id) DO UPDATE SET
        id = excluded.id,
        title = excluded.title,
        summary = excluded.summary,
        parse_status = excluded.parse_status,
        parse_error = excluded.parse_error,
        index_status = excluded.index_status,
        chunk_count = excluded.chunk_count,
        last_indexed_at = excluded.last_indexed_at
    `),
  };
}

export function createSqliteTextIndexDocumentStore(input: {
  dbPath: string;
  dbDriver?: LibraryIndexerDatabaseDriver | null;
}): TextIndexDocumentStore {
  return {
    batchUpsertDocuments(entries, observedAt = new Date().toISOString()) {
      if (entries.length === 0) {
        return [];
      }
      const db = openConnection(input.dbPath, input.dbDriver ?? null);
      const statements = prepareStatements(db);
      try {
        db.exec("BEGIN IMMEDIATE");
        const results = entries.map((entry) => {
          const fileId = makeStableId("file", entry.file.relativePath);
          const documentId = makeStableId("doc", entry.file.relativePath);
          statements.upsertFile.run(
            fileId,
            normalizeRelativePath(entry.file.relativePath),
            normalizeRelativePath(entry.file.relativePath).includes("/") ? normalizeRelativePath(entry.file.relativePath).slice(0, normalizeRelativePath(entry.file.relativePath).lastIndexOf("/")) : ".",
            entry.file.name,
            entry.file.extension,
            entry.file.size,
            entry.file.mtime,
            entry.file.ctime,
            entry.file.inodeKey ?? null,
            null,
            observedAt,
          );
          statements.upsertDocument.run(
            documentId,
            fileId,
            entry.document.title,
            entry.document.summary,
            "parsed",
            null,
            "indexed",
            entry.document.text.trim() ? 1 : 0,
            observedAt,
          );
          return { fileId, documentId };
        });
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        db.close();
      }
    },
  };
}

function readSnapshot(snapshotPath: string): ExportCatalogSnapshot {
  if (!fs.existsSync(snapshotPath)) {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      tags: [],
      documents: [],
    };
  }
  return JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as ExportCatalogSnapshot;
}

function writeSnapshot(snapshotPath: string, snapshot: ExportCatalogSnapshot): void {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
}

export function createRuntimeTextIndexDocumentStore(
  config: RuntimeConfig,
  mirrorStore: TextIndexDocumentStore | null = null,
): TextIndexDocumentStore {
  const snapshotPath = resolveExportCatalogSnapshotPath(config);
  return {
    batchUpsertDocuments(entries, observedAt = new Date().toISOString()) {
      if (entries.length === 0) {
        return [];
      }
      const snapshot = readSnapshot(snapshotPath);
      const documentMap = new Map(snapshot.documents.map((item) => [normalizeRelativePath(item.path), item]));
      const results = entries.map((entry) => {
        const relativePath = normalizeRelativePath(entry.file.relativePath);
        const existing = documentMap.get(relativePath);
        const fileId = makeStableId("file", relativePath);
        const documentId = makeStableId("doc", relativePath);
        documentMap.set(relativePath, {
          documentId,
          path: relativePath,
          title: entry.document.title,
          summary: entry.document.summary,
          tags: existing?.tags ? [...existing.tags] : [],
          derivedTags: existing?.derivedTags ? [...existing.derivedTags] : [],
          mtime: entry.file.mtime,
        });
        return { fileId, documentId };
      });
      writeSnapshot(snapshotPath, {
        version: 1,
        generatedAt: observedAt,
        tags: snapshot.tags,
        documents: [...documentMap.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
      });
      mirrorStore?.batchUpsertDocuments(entries, observedAt);
      return results;
    },
    deleteDocumentsByPaths(relativePaths: string[]): void {
      const normalizedPaths = new Set(relativePaths.map((item) => normalizeRelativePath(item)).filter(Boolean));
      if (normalizedPaths.size === 0) {
        return;
      }
      const snapshot = readSnapshot(snapshotPath);
      writeSnapshot(snapshotPath, {
        version: 1,
        generatedAt: new Date().toISOString(),
        tags: snapshot.tags,
        documents: snapshot.documents
          .filter((item) => !normalizedPaths.has(normalizeRelativePath(item.path)))
          .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN")),
      });
      mirrorStore?.deleteDocumentsByPaths?.([...normalizedPaths]);
    },
  };
}
