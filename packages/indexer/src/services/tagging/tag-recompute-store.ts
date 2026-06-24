import {
  CatalogRepository,
  type ExportDocumentRecord,
  type EffectiveFolderTagBindingRow,
  type RecomputeScope,
  type ResolvedDocumentTagRow,
  type TagDefinitionRow,
  type TagRecomputeDocumentRow,
  type TagRuleRow,
  type ManualDocumentTagBindingRow,
} from "../../repositories/catalog-repository.js";
import {
  CatalogWriteRepository,
  type RecomputedResolvedTagEntry,
} from "../../repositories/catalog-write-repository.js";
import type { LibraryIndexerDatabaseDriver } from "../../sqlite/open-database.js";
import type { RuntimeConfig } from "../../types/runtime-config.js";
import {
  createRuntimePreferredTextIndexCatalogReadStore,
  createRuntimeTextIndexCatalogReadStore,
  createSqliteTextIndexCatalogReadStore,
  readRuntimeActiveFileStateSnapshot,
} from "../indexer/text-index-catalog-store.js";
import { resolveExportCatalogSnapshotPath, type ExportCatalogSnapshot } from "../export/export-data-source.js";
import fs from "node:fs";
import path from "node:path";

export interface TagRecomputeStore {
  listRecomputeCandidateDocuments(scope: RecomputeScope): TagRecomputeDocumentRow[];
  listManualDocumentTagBindingsByDocumentIds(documentIds: string[]): ManualDocumentTagBindingRow[];
  listEffectiveFolderTagBindingsForDocumentPaths(paths: string[]): EffectiveFolderTagBindingRow[];
  listEffectiveFolderTagBindingsForFolderScope(folderPath: string): EffectiveFolderTagBindingRow[];
  listResolvedDocumentTagsByDocumentIds(documentIds: string[]): ResolvedDocumentTagRow[];
  listAllEnabledTagRules(): TagRuleRow[];
  listTagDefinitions(includeDisabled?: boolean): TagDefinitionRow[];
  recomputeResolvedTags(
    entries: RecomputedResolvedTagEntry[],
    observedAt: string,
    documentIds: string[],
  ): { updatedCount: number; updatedDocumentIds: string[] };
}

export function createSqliteTagRecomputeStore(input: {
  dbPath: string;
  dbDriver?: LibraryIndexerDatabaseDriver | null;
}): TagRecomputeStore {
  const repository = new CatalogRepository(input.dbPath, {
    tempStore: "MEMORY",
  }, input.dbDriver ?? null);
  const writer = new CatalogWriteRepository(input.dbPath, input.dbDriver ?? null);
  return {
    listRecomputeCandidateDocuments(scope: RecomputeScope): TagRecomputeDocumentRow[] {
      return repository.listRecomputeCandidateDocuments(scope);
    },
    listManualDocumentTagBindingsByDocumentIds(documentIds: string[]): ManualDocumentTagBindingRow[] {
      return repository.listManualDocumentTagBindingsByDocumentIds(documentIds);
    },
    listEffectiveFolderTagBindingsForDocumentPaths(paths: string[]): EffectiveFolderTagBindingRow[] {
      return repository.listEffectiveFolderTagBindingsForDocumentPaths(paths);
    },
    listEffectiveFolderTagBindingsForFolderScope(folderPath: string): EffectiveFolderTagBindingRow[] {
      return repository.listEffectiveFolderTagBindingsForFolderScope(folderPath);
    },
    listResolvedDocumentTagsByDocumentIds(documentIds: string[]): ResolvedDocumentTagRow[] {
      return repository.listResolvedDocumentTagsByDocumentIds(documentIds);
    },
    listAllEnabledTagRules(): TagRuleRow[] {
      return repository.listAllEnabledTagRules();
    },
    listTagDefinitions(includeDisabled = false): TagDefinitionRow[] {
      return repository.listTagDefinitions(includeDisabled);
    },
    recomputeResolvedTags(
      entries: RecomputedResolvedTagEntry[],
      observedAt: string,
      documentIds: string[],
    ): { updatedCount: number; updatedDocumentIds: string[] } {
      return writer.recomputeResolvedTags(entries, observedAt, documentIds);
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
  return path.join(config.indexDir, "runtime", "chunk-state-snapshot.json");
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function readExportSnapshot(config: RuntimeConfig): ExportCatalogSnapshot | null {
  const snapshotPath = resolveExportCatalogSnapshotPath(config);
  if (!fs.existsSync(snapshotPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as ExportCatalogSnapshot;
  } catch {
    return null;
  }
}

function readChunkSnapshot(config: RuntimeConfig): RuntimeChunkSnapshot | null {
  const snapshotPath = resolveRuntimeChunkSnapshotPath(config);
  if (!fs.existsSync(snapshotPath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as RuntimeChunkSnapshot;
  } catch {
    return null;
  }
}

function matchesFolderScope(documentPath: string, folderPath: string): boolean {
  const normalizedFolder = normalizePath(folderPath).replace(/^\.\/+/, "").replace(/\/+$/g, "") || ".";
  if (normalizedFolder === ".") {
    return true;
  }
  const normalizedDocumentPath = normalizePath(documentPath);
  return normalizedDocumentPath === normalizedFolder
    || normalizedDocumentPath.startsWith(`${normalizedFolder}/`);
}

function buildRuntimeDocumentRows(
  config: RuntimeConfig,
  scope: RecomputeScope,
): TagRecomputeDocumentRow[] | null {
  const activeState = readRuntimeActiveFileStateSnapshot(config);
  const exportSnapshot = readExportSnapshot(config);
  const chunkSnapshot = readChunkSnapshot(config);
  if (!activeState || !exportSnapshot) {
    return null;
  }

  const activeMap = new Map(
    (activeState.files ?? [])
      .filter((item) => item.indexStatus === "indexed")
      .map((item) => [normalizePath(item.path), item]),
  );
  const chunkTextByPath = new Map<string, string>();
  for (const chunk of chunkSnapshot?.chunks ?? []) {
    const normalizedPath = normalizePath(chunk.path);
    const current = chunkTextByPath.get(normalizedPath);
    chunkTextByPath.set(
      normalizedPath,
      current ? `${current}\n${chunk.content}` : chunk.content,
    );
  }

  let documents = exportSnapshot.documents.filter((document) => {
    const active = activeMap.get(normalizePath(document.path));
    return Boolean(active);
  });

  if (scope.kind === "document" && scope.documentId) {
    documents = documents.filter((item) => item.documentId === scope.documentId);
  } else if (scope.kind === "folder" && scope.folderPath) {
    documents = documents.filter((item) => matchesFolderScope(item.path, scope.folderPath ?? "."));
  } else if (scope.kind === "tag" && scope.tagId) {
    return null;
  }

  return documents
    .map((document) => {
      const normalizedPath = normalizePath(document.path);
      const active = activeMap.get(normalizedPath);
      if (!active) {
        return null;
      }
      const includeContentText = !(scope.kind === "folder" && scope.mode === "folder_bindings_only");
      return {
        documentId: document.documentId,
        path: normalizedPath,
        title: document.title,
        summary: document.summary,
        contentText: includeContentText ? (chunkTextByPath.get(normalizedPath) ?? "") : "",
        mtime: active.mtime,
        ctime: active.mtime,
        extension: active.extension,
      } satisfies TagRecomputeDocumentRow;
    })
    .filter((item): item is TagRecomputeDocumentRow => Boolean(item))
    .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
}

export function createRuntimePreferredTagRecomputeStore(input: {
  config: RuntimeConfig;
  dbDriver?: LibraryIndexerDatabaseDriver | null;
}): TagRecomputeStore {
  const sqliteStore = createSqliteTagRecomputeStore({
    dbPath: input.config.dbPath,
    dbDriver: input.dbDriver ?? null,
  });
  const readStore = createRuntimePreferredTextIndexCatalogReadStore(
    input.config,
    createSqliteTextIndexCatalogReadStore({
      dbPath: input.config.dbPath,
      dbDriver: input.dbDriver ?? null,
    }),
  );

  return {
    listRecomputeCandidateDocuments(scope: RecomputeScope): TagRecomputeDocumentRow[] {
      const runtimeRows = buildRuntimeDocumentRows(input.config, scope);
      if (runtimeRows) {
        return runtimeRows;
      }
      return sqliteStore.listRecomputeCandidateDocuments(scope);
    },
    listManualDocumentTagBindingsByDocumentIds(documentIds: string[]): ManualDocumentTagBindingRow[] {
      return sqliteStore.listManualDocumentTagBindingsByDocumentIds(documentIds);
    },
    listEffectiveFolderTagBindingsForDocumentPaths(paths: string[]): EffectiveFolderTagBindingRow[] {
      const normalized = paths.map((item) => normalizePath(item));
      return sqliteStore.listEffectiveFolderTagBindingsForDocumentPaths(normalized);
    },
    listEffectiveFolderTagBindingsForFolderScope(folderPath: string): EffectiveFolderTagBindingRow[] {
      return sqliteStore.listEffectiveFolderTagBindingsForFolderScope(normalizePath(folderPath));
    },
    listResolvedDocumentTagsByDocumentIds(documentIds: string[]): ResolvedDocumentTagRow[] {
      const documents = readStore.listExportDocumentsByPaths(
        readStore.listActiveFiles({ kind: "all" }).map((item) => item.path),
      );
      const documentMap = new Map(documents.map((item) => [item.documentId, item]));
      const runtimeRows: ResolvedDocumentTagRow[] = [];
      for (const documentId of documentIds) {
        const document = documentMap.get(documentId);
        if (!document) {
          continue;
        }
        document.tags.forEach((tagPath) => {
          runtimeRows.push({
            documentId,
            path: tagPath,
            tagId: tagPath,
            sourceType: "manual_document",
            sourceRef: null,
            evidence: null,
            confidence: 1,
            updatedAt: new Date().toISOString(),
          });
        });
        document.derivedTags.forEach((tagPath) => {
          runtimeRows.push({
            documentId,
            path: tagPath,
            tagId: tagPath,
            sourceType: "system_derived",
            sourceRef: null,
            evidence: null,
            confidence: 1,
            updatedAt: new Date().toISOString(),
          });
        });
      }
      return runtimeRows.length > 0
        ? runtimeRows.sort((left, right) =>
          left.documentId.localeCompare(right.documentId, "zh-Hans-CN")
          || left.path.localeCompare(right.path, "zh-Hans-CN"))
        : sqliteStore.listResolvedDocumentTagsByDocumentIds(documentIds);
    },
    listAllEnabledTagRules(): TagRuleRow[] {
      return sqliteStore.listAllEnabledTagRules();
    },
    listTagDefinitions(includeDisabled = false): TagDefinitionRow[] {
      return sqliteStore.listTagDefinitions(includeDisabled);
    },
    recomputeResolvedTags(
      entries: RecomputedResolvedTagEntry[],
      observedAt: string,
      documentIds: string[],
    ): { updatedCount: number; updatedDocumentIds: string[] } {
      return sqliteStore.recomputeResolvedTags(entries, observedAt, documentIds);
    },
  };
}
