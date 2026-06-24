import fs from "node:fs";
import path from "node:path";
import { openDatabase, type LibraryIndexerDatabase, type LibraryIndexerDatabaseDriver, type LibraryIndexerStatement } from "../../sqlite/open-database.js";
import type { IndexedDocumentBatchEntry } from "../../repositories/catalog-write-repository.js";
import type { RuntimeConfig } from "../../types/runtime-config.js";
import { makeStableId } from "./text-index-write-helpers.js";

export interface ChunkWriteStore {
  batchUpsertDocuments(
    entries: IndexedDocumentBatchEntry[],
    observedAt?: string,
  ): Array<{ fileId: string; documentId: string }>;
  deleteChunksByPaths?(relativePaths: string[]): void;
}

interface ChunkStatements {
  deleteChunksByDocumentId: LibraryIndexerStatement;
  insertChunk: LibraryIndexerStatement;
}

function openConnection(dbPath: string, dbDriver?: LibraryIndexerDatabaseDriver | null): LibraryIndexerDatabase {
  return dbDriver ? dbDriver.open(dbPath) : openDatabase(dbPath);
}

function prepareStatements(db: LibraryIndexerDatabase): ChunkStatements {
  return {
    deleteChunksByDocumentId: db.prepare(`DELETE FROM chunks WHERE document_id = ?`),
    insertChunk: db.prepare(`
      INSERT INTO chunks(id, document_id, chunk_index, content, content_hash, page_no, sheet_name, heading_path, token_count, vector_point_id)
      VALUES(?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)
    `),
  };
}

export function createSqliteChunkWriteStore(input: {
  dbPath: string;
  dbDriver?: LibraryIndexerDatabaseDriver | null;
}): ChunkWriteStore {
  return {
    batchUpsertDocuments(entries, observedAt = new Date().toISOString()) {
      if (entries.length === 0) {
        return [];
      }
      const db = openConnection(input.dbPath, input.dbDriver ?? null);
      const statements = prepareStatements(db);
      void observedAt;
      try {
        db.exec("BEGIN IMMEDIATE");
        const results = entries.map((entry) => {
          const documentId = makeStableId("doc", entry.file.relativePath);
          statements.deleteChunksByDocumentId.run(documentId);
          if (entry.document.text.trim()) {
            statements.insertChunk.run(
              makeStableId("chunk", `${documentId}:0`),
              documentId,
              0,
              entry.document.text,
            );
          }
          return {
            fileId: makeStableId("file", entry.file.relativePath),
            documentId,
          };
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

interface RuntimeChunkSnapshot {
  version: 1;
  generatedAt: string;
  chunks: Array<{
    documentId: string;
    path: string;
    chunkIndex: number;
    content: string;
  }>;
}

function resolveRuntimeChunkSnapshotPath(config: RuntimeConfig): string {
  return `${config.indexDir}/runtime/chunk-state-snapshot.json`;
}

function readRuntimeChunkSnapshot(snapshotPath: string): RuntimeChunkSnapshot {
  if (!fs.existsSync(snapshotPath)) {
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      chunks: [],
    };
  }
  return JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as RuntimeChunkSnapshot;
}

function writeRuntimeChunkSnapshot(snapshotPath: string, snapshot: RuntimeChunkSnapshot): void {
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
}

export function createRuntimeChunkWriteStore(
  config: RuntimeConfig,
  mirrorStore: ChunkWriteStore | null = null,
): ChunkWriteStore {
  const snapshotPath = resolveRuntimeChunkSnapshotPath(config);
  return {
    batchUpsertDocuments(entries, observedAt = new Date().toISOString()) {
      if (entries.length === 0) {
        return [];
      }
      const snapshot = readRuntimeChunkSnapshot(snapshotPath);
      const chunkMap = new Map(snapshot.chunks.map((item) => [`${item.path}:${item.chunkIndex}`, item]));
      const results = entries.map((entry) => {
        const documentId = makeStableId("doc", entry.file.relativePath);
        for (const key of [...chunkMap.keys()]) {
          if (key.startsWith(`${entry.file.relativePath}:`)) {
            chunkMap.delete(key);
          }
        }
        if (entry.document.text.trim()) {
          chunkMap.set(`${entry.file.relativePath}:0`, {
            documentId,
            path: entry.file.relativePath,
            chunkIndex: 0,
            content: entry.document.text,
          });
        }
        return {
          fileId: makeStableId("file", entry.file.relativePath),
          documentId,
        };
      });
      writeRuntimeChunkSnapshot(snapshotPath, {
        version: 1,
        generatedAt: observedAt,
        chunks: [...chunkMap.values()].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN") || left.chunkIndex - right.chunkIndex),
      });
      mirrorStore?.batchUpsertDocuments(entries, observedAt);
      return results;
    },
    deleteChunksByPaths(relativePaths: string[]): void {
      const deleted = new Set(relativePaths);
      if (deleted.size === 0) {
        return;
      }
      const snapshot = readRuntimeChunkSnapshot(snapshotPath);
      writeRuntimeChunkSnapshot(snapshotPath, {
        version: 1,
        generatedAt: new Date().toISOString(),
        chunks: snapshot.chunks.filter((item) => !deleted.has(item.path)),
      });
      mirrorStore?.deleteChunksByPaths?.(relativePaths);
    },
  };
}
