import {
  CatalogRepository,
  type ExportDocumentRecord,
} from "../../repositories/catalog-repository.js";
import { CatalogWriteRepository } from "../../repositories/catalog-write-repository.js";
import type { LibraryIndexerDatabaseDriver } from "../../sqlite/open-database.js";

export interface AllowedExtensionsStore {
  getSchemaMeta(key: string): string | null;
  setSchemaMeta(key: string, value: string): void;
  listActiveFileExtensions(): string[];
  listExportDocumentsByPaths(paths: string[]): ExportDocumentRecord[];
  listExportDocumentsByExtensions(extensions: string[]): ExportDocumentRecord[];
  deleteActiveFilesByExtensions(extensions: string[]): { deletedCount: number; deletedPaths: string[] };
}

export function createSqliteAllowedExtensionsStore(input: {
  dbPath: string;
  dbDriver?: LibraryIndexerDatabaseDriver | null;
}): AllowedExtensionsStore {
  const writer = new CatalogWriteRepository(input.dbPath, input.dbDriver ?? null);
  const repository = new CatalogRepository(input.dbPath, {}, input.dbDriver ?? null);
  return {
    getSchemaMeta(key: string): string | null {
      return writer.getSchemaMeta(key);
    },
    setSchemaMeta(key: string, value: string): void {
      writer.setSchemaMeta(key, value);
    },
    listActiveFileExtensions(): string[] {
      return repository.listActiveFileExtensions();
    },
    listExportDocumentsByPaths(paths: string[]): ExportDocumentRecord[] {
      return repository.listExportDocumentsByPaths(paths);
    },
    listExportDocumentsByExtensions(extensions: string[]): ExportDocumentRecord[] {
      return repository.listExportDocumentsByExtensions(extensions);
    },
    deleteActiveFilesByExtensions(extensions: string[]): { deletedCount: number; deletedPaths: string[] } {
      return writer.deleteActiveFilesByExtensions(extensions);
    },
  };
}
