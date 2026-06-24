import fs from "node:fs";
import path from "node:path";

import type { RuntimeConfig } from "../../types/runtime-config.js";
import {
  CatalogRepository,
  type ExportDocumentRecord,
  type ExportTagPostingRow,
  type ExportTagRecord,
} from "../../repositories/catalog-repository.js";
import type { LibraryIndexerDatabaseDriver } from "../../sqlite/open-database.js";

export interface ExportCatalogSnapshot {
  version: 1;
  generatedAt: string;
  tags: ExportTagRecord[];
  documents: ExportDocumentRecord[];
}

export interface ExportCatalogDataSource {
  listExportTags(): ExportTagRecord[];
  iterateExportDocumentRecords(batchSize?: number): Generator<ExportDocumentRecord[]>;
  iterateTagPostingRows(batchSize?: number): Generator<ExportTagPostingRow[]>;
  iterateDirectTagPostingRows(batchSize?: number): Generator<ExportTagPostingRow[]>;
  listExportDocumentsByPaths(paths: string[]): ExportDocumentRecord[];
}

export type ExportCatalogDataSourceMode = "auto" | "snapshot" | "sqlite";

export interface ResolvedExportCatalogDataSource {
  dataSource: ExportCatalogDataSource;
  resolvedMode: Exclude<ExportCatalogDataSourceMode, "auto">;
  snapshotPath: string;
}

export function createSqliteExportCatalogDataSource(
  dbPath: string,
  dbDriver: LibraryIndexerDatabaseDriver | null = null,
): ExportCatalogDataSource {
  return new CatalogRepository(dbPath, {}, dbDriver);
}

export function resolveExportCatalogSnapshotPath(config: RuntimeConfig): string {
  return path.join(config.indexDir, "runtime", "export-catalog-snapshot.json");
}

export function writeExportCatalogSnapshot(
  config: RuntimeConfig,
  dataSource: ExportCatalogDataSource = createSqliteExportCatalogDataSource(config.dbPath),
): string {
  const snapshotPath = resolveExportCatalogSnapshotPath(config);
  const documents: ExportDocumentRecord[] = [];
  for (const batch of dataSource.iterateExportDocumentRecords(2000)) {
    documents.push(...batch);
  }
  const snapshot: ExportCatalogSnapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    tags: dataSource.listExportTags(),
    documents,
  };
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  return snapshotPath;
}

export function createExportCatalogDataSource(
  config: RuntimeConfig,
  mode: ExportCatalogDataSourceMode = "auto",
  dbDriver: LibraryIndexerDatabaseDriver | null = null,
): ExportCatalogDataSource {
  return resolveExportCatalogDataSource(config, mode, dbDriver).dataSource;
}

export function resolveExportCatalogDataSource(
  config: RuntimeConfig,
  mode: ExportCatalogDataSourceMode = "auto",
  dbDriver: LibraryIndexerDatabaseDriver | null = null,
): ResolvedExportCatalogDataSource {
  const snapshotPath = resolveExportCatalogSnapshotPath(config);
  if (mode === "sqlite") {
    return {
      dataSource: createSqliteExportCatalogDataSource(config.dbPath, dbDriver),
      resolvedMode: "sqlite",
      snapshotPath,
    };
  }
  if (mode === "snapshot") {
    if (!fs.existsSync(snapshotPath)) {
      throw new Error(`export catalog snapshot 不存在：${snapshotPath}`);
    }
    return {
      dataSource: createSnapshotExportCatalogDataSource(snapshotPath),
      resolvedMode: "snapshot",
      snapshotPath,
    };
  }
  if (fs.existsSync(snapshotPath)) {
    return {
      dataSource: createSnapshotExportCatalogDataSource(snapshotPath),
      resolvedMode: "snapshot",
      snapshotPath,
    };
  }
  return {
    dataSource: createSqliteExportCatalogDataSource(config.dbPath, dbDriver),
    resolvedMode: "sqlite",
    snapshotPath,
  };
}

export function createSnapshotExportCatalogDataSource(snapshotPath: string): ExportCatalogDataSource {
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf-8")) as ExportCatalogSnapshot;
  return new SnapshotExportCatalogDataSource(snapshot);
}

class SnapshotExportCatalogDataSource implements ExportCatalogDataSource {
  private readonly documents: ExportDocumentRecord[];
  private readonly tags: ExportTagRecord[];
  private readonly tagMap: Map<string, ExportTagRecord>;

  constructor(snapshot: ExportCatalogSnapshot) {
    this.documents = [...snapshot.documents].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
    this.tags = [...snapshot.tags].sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
    this.tagMap = new Map(this.tags.map((tag) => [tag.path, tag]));
  }

  listExportTags(): ExportTagRecord[] {
    return this.tags.map((tag) => ({ ...tag }));
  }

  *iterateExportDocumentRecords(batchSize = 1000): Generator<ExportDocumentRecord[]> {
    for (let index = 0; index < this.documents.length; index += batchSize) {
      yield this.documents.slice(index, index + batchSize).map(cloneExportDocumentRecord);
    }
  }

  *iterateTagPostingRows(batchSize = 5000): Generator<ExportTagPostingRow[]> {
    const rows = [
      ...this.buildTagPostingRows(false),
      ...this.buildTagPostingRows(true),
    ].sort(compareTagPostingRows);
    for (let index = 0; index < rows.length; index += batchSize) {
      yield rows.slice(index, index + batchSize).map(cloneExportTagPostingRow);
    }
  }

  *iterateDirectTagPostingRows(batchSize = 5000): Generator<ExportTagPostingRow[]> {
    const rows = this.buildTagPostingRows(false);
    for (let index = 0; index < rows.length; index += batchSize) {
      yield rows.slice(index, index + batchSize).map(cloneExportTagPostingRow);
    }
  }

  listExportDocumentsByPaths(paths: string[]): ExportDocumentRecord[] {
    const wanted = new Set(paths.map((item) => item.trim()).filter(Boolean));
    return this.documents
      .filter((document) => wanted.has(document.path))
      .map(cloneExportDocumentRecord);
  }

  private buildTagPostingRows(derived: boolean): ExportTagPostingRow[] {
    const rows: ExportTagPostingRow[] = [];
    for (const document of this.documents) {
      const tagPaths = derived ? document.derivedTags : document.tags;
      for (const tagPath of tagPaths) {
        const tag = this.tagMap.get(tagPath);
        rows.push({
          rootType: tag?.rootType ?? inferRootType(tagPath),
          tagPath,
          documentId: document.documentId,
          path: document.path,
          title: document.title,
          derived,
        });
      }
    }
    return rows.sort(compareTagPostingRows);
  }
}

function inferRootType(tagPath: string): string {
  return tagPath.split("/").filter(Boolean)[0] ?? "";
}

function compareTagPostingRows(left: ExportTagPostingRow, right: ExportTagPostingRow): number {
  return left.rootType.localeCompare(right.rootType, "zh-Hans-CN")
    || left.tagPath.localeCompare(right.tagPath, "zh-Hans-CN")
    || left.path.localeCompare(right.path, "zh-Hans-CN")
    || left.documentId.localeCompare(right.documentId, "zh-Hans-CN");
}

function cloneExportDocumentRecord(document: ExportDocumentRecord): ExportDocumentRecord {
  return {
    ...document,
    tags: [...document.tags],
    derivedTags: [...document.derivedTags],
  };
}

function cloneExportTagPostingRow(row: ExportTagPostingRow): ExportTagPostingRow {
  return { ...row };
}
