import fs from "node:fs";
import path from "node:path";

import type {
  LibraryBinding,
  LibraryDocumentList,
  LibraryDocumentRecord,
  LibraryFavoriteRecord,
  LibraryFolderNode,
  LibraryIndexStatus,
  LibrarySnapshot,
  LibraryTagNode,
} from "@x-file/shared";

export interface ReadLibraryDocumentsInput {
  browseMode?: string;
  selectedFolderPath?: string | null;
  selectedTagPath?: string | null;
  selectedTagPaths?: string[] | null;
  selectedFavoriteId?: string | null;
  keyword?: string | null;
  offset: number;
  limit: number;
  favorites?: LibraryFavoriteRecord[];
}

interface ManifestFile {
  generated_at?: string;
  entries?: {
    status?: string;
    taxonomy?: string;
    bootstrap?: string;
  };
  meta_shards?: Array<{
    path: string;
    document_count?: number;
  }>;
}

interface StatusFile {
  exported_at?: string;
  document_count?: number;
}

interface TaxonomyFile {
  nodes?: Array<{
    path: string;
    name: string;
    root_type: string;
    parent_path: string | null;
    depth: number;
  }>;
}

interface BootstrapFile {
  folders?: Array<{
    path: string;
    name: string;
    parent_path: string | null;
    direct_document_count: number;
    document_count: number;
  }>;
}

interface MetaShardFile {
  documents?: Array<{
    document_id: string;
    path: string;
    title?: string;
    summary?: string;
    mtime?: string;
    direct_tags?: string[];
    derived_tags?: string[];
  }>;
}

export class LibraryExportReader {
  readSnapshot(
    binding: LibraryBinding | null,
    fallbackStatus: LibraryIndexStatus,
    favorites: LibraryFavoriteRecord[] = [],
  ): LibrarySnapshot {
    if (!binding || !binding.initialized) {
      return {
        binding,
        requiresInitialization: true,
        initializationRedirectPath: "/init",
        status: fallbackStatus,
        tags: [],
        favorites,
        folders: [],
        documentCount: 0,
        lastError: null,
      };
    }

    const exportDir = resolveExportDir(binding.rootDir);
    const manifest = readJson<ManifestFile>(
      path.join(exportDir, "manifest.json"),
    );
    if (!manifest) {
      return emptySnapshot(binding, fallbackStatus, favorites);
    }

    const statusFile = readJson<StatusFile>(
      path.join(exportDir, manifest.entries?.status ?? "status.json"),
    );
    const documents = this.readDocumentsFromManifest(exportDir, manifest);
    const tagCounts = countTags(documents);
    return {
      binding,
      requiresInitialization: false,
      initializationRedirectPath: "/init",
      status: {
        ...fallbackStatus,
        lastCompletedAt:
          fallbackStatus.lastCompletedAt ??
          statusFile?.exported_at ??
          manifest.generated_at ??
          null,
        dirtyReasons: fallbackStatus.dirtyReasons,
      },
      tags: readTags(exportDir, manifest, tagCounts),
      favorites,
      folders: readFolders(exportDir, manifest),
      documentCount: statusFile?.document_count ?? documents.length,
      lastError: fallbackStatus.errorSummary,
    };
  }

  listDocuments(
    binding: LibraryBinding | null,
    input: ReadLibraryDocumentsInput,
  ): LibraryDocumentList {
    if (!binding) {
      return emptyDocumentList(input);
    }

    const exportDir = resolveExportDir(binding.rootDir);
    const manifest = readJson<ManifestFile>(
      path.join(exportDir, "manifest.json"),
    );
    if (!manifest) {
      return emptyDocumentList(input);
    }

    const allDocuments = this.readDocumentsFromManifest(exportDir, manifest);
    const filtered = filterDocuments(
      markFavoriteDocuments(allDocuments, input.favorites ?? []),
      input,
    );
    return {
      total: filtered.length,
      visibleEntryTotal: filtered.length,
      offset: input.offset,
      limit: input.limit,
      items: filtered.slice(input.offset, input.offset + input.limit),
      tagFacetCounts: countTags(filtered),
      directoryStatus: {
        path: normalizeFolderPath(input.selectedFolderPath ?? ""),
        state: "fresh",
        source: "snapshot",
        lastRequestedAt: null,
        lastCompletedAt: manifest.generated_at ?? null,
        lastFailedAt: null,
        runningTaskId: null,
        errorSummary: null,
        generatedAt: manifest.generated_at ?? null,
      },
    };
  }

  private readDocumentsFromManifest(
    exportDir: string,
    manifest: ManifestFile,
  ): LibraryDocumentRecord[] {
    const documents: LibraryDocumentRecord[] = [];
    for (const shard of manifest.meta_shards ?? []) {
      const shardFile = readJson<MetaShardFile>(
        path.join(exportDir, shard.path),
      );
      for (const document of shardFile?.documents ?? []) {
        documents.push({
          documentId: document.document_id,
          path: normalizeDocumentPath(document.path),
          title: document.title?.trim() || path.posix.basename(document.path),
          summary: document.summary ?? "",
          updatedAt:
            document.mtime ??
            manifest.generated_at ??
            new Date(0).toISOString(),
          createdAt: null,
          sizeBytes: null,
          tags: Array.isArray(document.direct_tags) ? document.direct_tags : [],
          derivedTags: Array.isArray(document.derived_tags)
            ? document.derived_tags
            : [],
          isFavorite: false,
        });
      }
    }
    return documents.sort((left, right) =>
      left.path.localeCompare(right.path, "zh-Hans-CN"),
    );
  }
}

function resolveExportDir(rootDir: string): string {
  return path.join(rootDir, ".ai-index", "exports");
}

function emptySnapshot(
  binding: LibraryBinding,
  status: LibraryIndexStatus,
  favorites: LibraryFavoriteRecord[] = [],
): LibrarySnapshot {
  return {
    binding,
    requiresInitialization: false,
    initializationRedirectPath: "/init",
    status,
    tags: [],
    favorites,
    folders: [],
    documentCount: 0,
    lastError: status.errorSummary,
  };
}

function emptyDocumentList(
  input: ReadLibraryDocumentsInput,
): LibraryDocumentList {
  return {
    total: 0,
    visibleEntryTotal: 0,
    offset: input.offset,
    limit: input.limit,
    items: [],
    tagFacetCounts: {},
    directoryStatus: null,
  };
}

function readTags(
  exportDir: string,
  manifest: ManifestFile,
  tagCounts: Record<string, number>,
): LibraryTagNode[] {
  const taxonomy = readJson<TaxonomyFile>(
    path.join(exportDir, manifest.entries?.taxonomy ?? "taxonomy.json"),
  );
  return (taxonomy?.nodes ?? []).map((node) => ({
    path: node.path,
    name: node.name,
    rootType: node.root_type,
    parentPath: node.parent_path,
    depth: node.depth,
    documentCount: tagCounts[node.path] ?? 0,
  }));
}

function readFolders(
  exportDir: string,
  manifest: ManifestFile,
): LibraryFolderNode[] {
  const bootstrap = readJson<BootstrapFile>(
    path.join(exportDir, manifest.entries?.bootstrap ?? "bootstrap.json"),
  );
  return (bootstrap?.folders ?? []).map((folder) => ({
    path: folder.path,
    name: folder.name,
    parentPath: folder.parent_path,
    directDocumentCount: folder.direct_document_count,
    documentCount: folder.document_count,
    createdAt: null,
    updatedAt: null,
  }));
}

function filterDocuments(
  documents: LibraryDocumentRecord[],
  input: ReadLibraryDocumentsInput,
): LibraryDocumentRecord[] {
  const folderPath = normalizeFolderPath(input.selectedFolderPath ?? "");
  const selectedFavorite = resolveSelectedFavorite(
    input.favorites ?? [],
    input.selectedFavoriteId,
  );
  const selectedTags = input.selectedTagPaths?.length
    ? input.selectedTagPaths
    : input.selectedTagPath
      ? [input.selectedTagPath]
      : [];
  const keyword = input.keyword?.trim().toLowerCase() ?? "";

  return documents.filter((document) => {
    if (selectedFavorite && !matchesFavorite(document, selectedFavorite)) {
      return false;
    }

    if (input.browseMode !== "tag" && folderPath && folderPath !== ".") {
      const documentDir = normalizeFolderPath(
        path.posix.dirname(document.path),
      );
      if (
        documentDir !== folderPath &&
        !documentDir.startsWith(`${folderPath}/`)
      ) {
        return false;
      }
    }

    if (selectedTags.length > 0) {
      const documentTags = new Set([...document.tags, ...document.derivedTags]);
      if (!selectedTags.every((tagPath) => documentTags.has(tagPath))) {
        return false;
      }
    }

    if (keyword) {
      const haystack =
        `${document.title}\n${document.path}\n${document.summary}`.toLowerCase();
      if (!haystack.includes(keyword)) {
        return false;
      }
    }

    return true;
  });
}

function markFavoriteDocuments(
  documents: LibraryDocumentRecord[],
  favorites: LibraryFavoriteRecord[],
): LibraryDocumentRecord[] {
  if (favorites.length === 0) {
    return documents;
  }
  return documents.map((document) => ({
    ...document,
    isFavorite: favorites.some(
      (favorite) =>
        favorite.kind !== "folder" && matchesFavorite(document, favorite),
    ),
  }));
}

function resolveSelectedFavorite(
  favorites: LibraryFavoriteRecord[],
  selectedFavoriteId: string | null | undefined,
): LibraryFavoriteRecord | null {
  const id = selectedFavoriteId?.trim();
  if (!id) {
    return null;
  }
  return favorites.find((favorite) => favorite.path === id) ?? null;
}

function matchesFavorite(
  document: LibraryDocumentRecord,
  favorite: LibraryFavoriteRecord,
): boolean {
  if (favorite.kind === "folder") {
    const folderPath = normalizeFolderPath(favorite.path);
    if (!folderPath || folderPath === ".") {
      return true;
    }
    const documentDir = normalizeFolderPath(path.posix.dirname(document.path));
    return (
      documentDir === folderPath || documentDir.startsWith(`${folderPath}/`)
    );
  }

  const requiredTags =
    favorite.kind === "tag_filter"
      ? favorite.tagPaths?.length
        ? favorite.tagPaths
        : favorite.path.split("|")
      : [favorite.path];
  const documentTags = new Set([...document.tags, ...document.derivedTags]);
  return requiredTags
    .map((item) => item.trim())
    .filter(Boolean)
    .every((tagPath) => documentTags.has(tagPath));
}

function countTags(documents: LibraryDocumentRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const document of documents) {
    for (const tagPath of new Set([
      ...document.tags,
      ...document.derivedTags,
    ])) {
      counts[tagPath] = (counts[tagPath] ?? 0) + 1;
    }
  }
  return counts;
}

function normalizeFolderPath(value: string): string {
  const normalized = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  return normalized || ".";
}

function normalizeDocumentPath(value: string): string {
  return value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}
