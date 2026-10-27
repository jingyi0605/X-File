import fs from "node:fs";
import path from "node:path";
import { readCatalogSnapshot, type CatalogSnapshot } from "@x-file/indexer";

import type {
  LibraryBinding,
  LibraryDocumentList,
  LibraryDocumentRecord,
  LibraryFavoriteRecord,
  LibraryFolderNode,
  LibraryIndexProgress,
  LibraryIndexStatus,
  LibrarySnapshot,
  LibraryTagDirectory,
  LibraryTagNode,
} from "@x-file/shared";

import { resolveDefaultLibraryRootDir } from "./library-binding-store.js";

export interface ReadLibraryDocumentsInput {
  browseMode?: string;
  selectedFolderPath?: string | null;
  selectedTagPath?: string | null;
  selectedTagPaths?: string[] | null;
  selectedFavoriteId?: string | null;
  keyword?: string | null;
  searchScope?: "all" | "current_directory" | "current_results";
  searchMode?: "all" | "name" | "content";
  updatedAtOrder?: "asc" | "desc";
  offset: number;
  limit: number;
  favorites?: LibraryFavoriteRecord[];
  tagDirectoryBindings?: Array<{ path: string; tagPaths: string[] }>;
}

interface SearchMatchState {
  readonly hasIndex: boolean;
  readonly keywords: string[];
  readonly groups: SearchKeywordMatchGroup[];
  readonly ranks: Map<string, number>;
}

interface SearchKeywordMatchGroup {
  readonly keyword: string;
  readonly documentIds: Set<string>;
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

interface SearchBucketPosting {
  term: string;
  document_count: number;
  document_ids?: string[];
  postings?: Array<{
    document_id: string;
  }>;
}

interface SearchBucketFile {
  terms?: SearchBucketPosting[];
}

interface SearchManifestFile {
  buckets?: Array<{ bucket: string; path: string }>;
}

const searchTermViews = new WeakMap<SearchBucketFile, Map<string, SearchBucketPosting>>();
const RECENT_TIME_TAGS = [
  { path: "时间/最近3天", days: 3 },
  { path: "时间/最近7天", days: 7 },
  { path: "时间/最近30天", days: 30 },
] as const;

export class LibraryExportReader {
  private readonly documentViews = new WeakMap<ManifestFile | CatalogSnapshot, LibraryDocumentRecord[]>();
  readSnapshot(
    binding: LibraryBinding | null,
    fallbackStatus: LibraryIndexStatus,
    favorites: LibraryFavoriteRecord[] = [],
  ): LibrarySnapshot {
    if (!binding || !binding.initialized) {
      return {
        binding,
        defaultRootDir: resolveDefaultLibraryRootDir(),
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
    const catalog = readCatalogSnapshot(binding.rootDir);
    const manifest = readJson<ManifestFile>(
      path.join(exportDir, "manifest.json"),
    ) ?? (catalog ? { generated_at: catalog.generatedAt } : null);
    if (!manifest) {
      return emptySnapshot(binding, fallbackStatus, favorites);
    }

    const statusFile = readJson<StatusFile>(
      path.join(exportDir, manifest.entries?.status ?? "status.json"),
    );
    const documents = refreshRecentTimeTags(this.readDocuments(exportDir, manifest, catalog));
    const tagCounts = countTags(documents);
    const documentCount = catalog?.documents.length ?? statusFile?.document_count ?? documents.length;
    return {
      binding,
      defaultRootDir: resolveDefaultLibraryRootDir(),
      requiresInitialization: false,
      initializationRedirectPath: "/init",
      status: {
        ...fallbackStatus,
        lastCompletedAt:
          fallbackStatus.lastCompletedAt ??
          catalog?.generatedAt ??
          statusFile?.exported_at ??
          manifest.generated_at ??
          null,
        // 稳态下面板摘要指标：优先使用上次运行记录的进度；缺失时用导出文档计数合成，
        // 让“总文件数 / 已扫描 / 已更新”等指标即使未重新索引也能正常展示。
        progress: fallbackStatus.progress ?? deriveSteadyProgress(documentCount),
        dirtyReasons: fallbackStatus.dirtyReasons,
        runtimeIndexState: fallbackStatus.runtimeIndexState ?? null,
      },
      tags: readTags(exportDir, manifest, tagCounts, catalog),
      favorites,
      folders: readFolders(exportDir, manifest),
      documentCount,
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
    const catalog = readCatalogSnapshot(binding.rootDir);
    const manifest = readJson<ManifestFile>(
      path.join(exportDir, "manifest.json"),
    ) ?? (catalog ? { generated_at: catalog.generatedAt } : null);
    if (!manifest) {
      return emptyDocumentList(input);
    }

    const allDocuments = refreshRecentTimeTags(this.readDocuments(exportDir, manifest, catalog));
    const searchMatch = readOfflineSearchMatchState(
      exportDir,
      input.keyword,
      input.searchMode,
    );
    const filtered = filterDocuments(
      markFavoriteDocuments(allDocuments, input.favorites ?? []),
      input,
      searchMatch,
    ).sort((left, right) => {
      if (input.updatedAtOrder === "asc" || input.updatedAtOrder === "desc") {
        const delta = (Date.parse(left.updatedAt) || 0) - (Date.parse(right.updatedAt) || 0);
        return delta * (input.updatedAtOrder === "asc" ? 1 : -1)
          || left.path.localeCompare(right.path, "zh-Hans-CN");
      }
      return compareSearchRank(left, right, searchMatch);
    });
    const selectedTags = input.browseMode === "tag" ? resolveSelectedTagPaths(input) : [];
    return {
      total: filtered.length,
      visibleEntryTotal: filtered.length,
      offset: input.offset,
      limit: input.limit,
      items: filtered.slice(input.offset, input.offset + input.limit),
      tagDirectories: buildTagDirectories(filtered, input.tagDirectoryBindings ?? [], selectedTags),
      tagFacetCounts: countTags(filtered),
      directoryStatus: {
        path: normalizeFolderPath(input.selectedFolderPath ?? ""),
        state: "fresh",
        source: "snapshot",
        lastRequestedAt: null,
        lastCompletedAt: catalog?.generatedAt ?? manifest.generated_at ?? null,
        lastFailedAt: null,
        runningTaskId: null,
        errorSummary: null,
        generatedAt: catalog?.generatedAt ?? manifest.generated_at ?? null,
      },
    };
  }

  private readDocuments(
    exportDir: string,
    manifest: ManifestFile,
    catalog: CatalogSnapshot | null,
  ): LibraryDocumentRecord[] {
    const source = catalog ?? manifest;
    const cached = this.documentViews.get(source);
    if (cached) return cached;
    // 与桌面端使用同一份原生快照，避免旧导出分片的修改时间和标签滞后。
    if (catalog) {
      const documents = catalog.documents.map((document): LibraryDocumentRecord => ({
        documentId: document.documentId,
        path: normalizeDocumentPath(document.path),
        title: document.title?.trim() || path.posix.basename(document.path),
        summary: document.summary ?? "",
        updatedAt: document.mtime ?? catalog.generatedAt ?? new Date(0).toISOString(),
        createdAt: null,
        sizeBytes: null,
        tags: document.tags ?? [],
        derivedTags: document.derivedTags ?? [],
        isFavorite: false,
      })).sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
      this.documentViews.set(source, documents);
      return documents;
    }
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
    documents.sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
    this.documentViews.set(source, documents);
    return documents;
  }
}

function resolveSelectedTagPaths(input: ReadLibraryDocumentsInput): string[] {
  return input.selectedTagPaths?.length
    ? input.selectedTagPaths
    : input.selectedTagPath
      ? [input.selectedTagPath]
      : [];
}

function buildTagDirectories(
  documents: LibraryDocumentRecord[],
  bindings: Array<{ path: string; tagPaths: string[] }>,
  selectedTags: string[],
): LibraryTagDirectory[] {
  if (selectedTags.length === 0 || bindings.length === 0) {
    return [];
  }

  const countsByDirectory = new Map<string, { count: number; updatedAt: string | null }>();
  for (const document of documents) {
    const segments = normalizeFolderPath(path.posix.dirname(document.path))
      .split("/")
      .filter((segment) => segment && segment !== ".");
    const directoryPaths = [".", ...segments.map((_, index) => segments.slice(0, index + 1).join("/"))];
    for (const directoryPath of directoryPaths) {
      const current = countsByDirectory.get(directoryPath) ?? { count: 0, updatedAt: null };
      current.count += 1;
      current.updatedAt = !current.updatedAt || document.updatedAt > current.updatedAt
        ? document.updatedAt
        : current.updatedAt;
      countsByDirectory.set(directoryPath, current);
    }
  }

  return bindings.flatMap(({ path: folderPath, tagPaths }) => {
    const normalizedPath = normalizeFolderPath(folderPath);
    const matchedTagPaths = Array.from(new Set(tagPaths.filter((tagPath) =>
      selectedTags.some((selectedPath) => tagPath === selectedPath || tagPath.startsWith(`${selectedPath}/`)),
    )));
    if (!normalizedPath || matchedTagPaths.length === 0) {
      return [];
    }

    const directoryStats = countsByDirectory.get(normalizedPath);
    return [{
      path: normalizedPath,
      documentCount: directoryStats?.count ?? 0,
      updatedAt: directoryStats?.updatedAt ?? null,
      matchedTagPaths,
    }];
  });
}

function resolveExportDir(rootDir: string): string {
  return path.join(rootDir, ".ai-index", "exports");
}

function refreshRecentTimeTags(documents: LibraryDocumentRecord[]): LibraryDocumentRecord[] {
  const today = localCalendarDay(new Date());
  const isRecentTag = (tag: string) => RECENT_TIME_TAGS.some((item) => item.path === tag);
  return documents.map((document) => {
    const age = (today - localCalendarDay(new Date(document.updatedAt))) / 86_400_000;
    // 相对日期在读取时计算，不能复用索引时写入的“最近”标签；按自然日处理以避开夏令时偏差。
    return {
      ...document,
      tags: document.tags.filter((tag) => !isRecentTag(tag)),
      derivedTags: [
        ...document.derivedTags.filter((tag) => !isRecentTag(tag)),
        ...RECENT_TIME_TAGS.filter((tag) => age >= 0 && age < tag.days).map((tag) => tag.path),
      ],
    };
  });
}

function localCalendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * 稳态进度合成：导出产物存在即代表这批文档已全部扫描并可读。
 * 面板文案已经改为“已扫描数量 / 已索引数量”，所以稳态下两者都应等于 documentCount，
 * 避免在未重新索引时出现“已索引数量 = 0”这种误导展示。
 */
function deriveSteadyProgress(documentCount: number): LibraryIndexProgress | null {
  if (!Number.isFinite(documentCount) || documentCount <= 0) {
    return null;
  }
  return {
    scannedCount: documentCount,
    indexedCount: documentCount,
    skippedCount: 0,
    failedCount: 0,
    unchangedCount: 0,
    totalCount: documentCount,
    maxConcurrency: null,
    activeTaskCount: 0, pendingTaskCount: 0, completedTaskCount: documentCount,
  };
}

function emptySnapshot(
  binding: LibraryBinding,
  status: LibraryIndexStatus,
  favorites: LibraryFavoriteRecord[] = [],
): LibrarySnapshot {
  return {
    binding,
    defaultRootDir: resolveDefaultLibraryRootDir(),
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
    tagDirectories: [],
    tagFacetCounts: {},
    directoryStatus: null,
  };
}

function readTags(
  exportDir: string,
  manifest: ManifestFile,
  tagCounts: Record<string, number>,
  catalog: CatalogSnapshot | null,
): LibraryTagNode[] {
  const taxonomy = catalog ? null : readJson<TaxonomyFile>(
    path.join(exportDir, manifest.entries?.taxonomy ?? "taxonomy.json"),
  );
  const tags: LibraryTagNode[] = catalog ? catalog.tags.map((node) => ({
    ...node,
    documentCount: tagCounts[node.path] ?? 0,
  })) : (taxonomy?.nodes ?? []).map((node) => ({
    path: node.path,
    name: node.name,
    rootType: node.root_type,
    parentPath: node.parent_path,
    depth: node.depth,
    documentCount: tagCounts[node.path] ?? 0,
  }));
  // 旧索引可能没有近期标签节点，新进入日期范围的文件仍需有对应入口。
  for (const tagPath of ["时间", ...RECENT_TIME_TAGS.map((tag) => tag.path)]) {
    if ((tagCounts[tagPath] ?? 0) > 0 && !tags.some((tag) => tag.path === tagPath)) {
      tags.push({
        path: tagPath,
        name: tagPath.split("/").at(-1)!,
        rootType: "时间",
        parentPath: tagPath === "时间" ? null : "时间",
        depth: tagPath === "时间" ? 0 : 1,
        documentCount: tagCounts[tagPath] ?? 0,
      });
    }
  }
  return tags;
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
  searchMatch: SearchMatchState,
): LibraryDocumentRecord[] {
  const folderPath = normalizeFolderPath(input.selectedFolderPath ?? "");
  const searchScope = input.searchScope ?? "current_results";
  const usesCurrentResults = searchScope === "current_results";
  const selectedFavorite = resolveSelectedFavorite(
    input.favorites ?? [],
    input.selectedFavoriteId,
  );
  const selectedTags = input.selectedTagPaths?.length
    ? input.selectedTagPaths
    : input.selectedTagPath
      ? [input.selectedTagPath]
      : [];

  return documents.filter((document) => {
    if (
      usesCurrentResults
      && selectedFavorite
      && !matchesFavorite(document, selectedFavorite)
    ) {
      return false;
    }

    if (
      searchScope !== "all"
      && (
        searchScope === "current_directory"
        || input.browseMode !== "tag"
      )
    ) {
      const documentDir = normalizeFolderPath(
        path.posix.dirname(document.path),
      );
      const normalizedDocumentDir = documentDir === "." ? "" : documentDir;
      const normalizedFolderPath = folderPath === "." ? "" : folderPath;
      if (normalizedDocumentDir !== normalizedFolderPath) {
        return false;
      }
    }

    if (usesCurrentResults && selectedTags.length > 0) {
      // 子树匹配：文档命中选中标签 ⟺ 文档某个标签等于选中标签、或是选中标签的子孙路径。
      // 这样点击父标签能筛出所有子标签文档，与父标签 badge 的聚合计数保持一致。
      const documentTagPaths = [...document.tags, ...document.derivedTags];
      const matchesSelectedTag = (selectedPath: string) => documentTagPaths.some(
        (tagPath) => tagPath === selectedPath || tagPath.startsWith(`${selectedPath}/`),
      );
      if (!selectedTags.every(matchesSelectedTag)) {
        return false;
      }
    }

    if (searchMatch.keywords.length > 0) {
      const searchMode = input.searchMode ?? "all";
      const searchText = searchMode === "name"
        ? path.posix.basename(document.path)
        : searchMode === "content"
          ? document.summary
          : `${document.title}\n${document.path}\n${document.summary}`;
      const haystack = searchText.toLowerCase();
      const matchedEveryKeyword = searchMode === "all"
        ? searchMatch.groups.every((group) => (
            haystack.includes(group.keyword)
            || group.documentIds.has(document.documentId)
          ))
        : searchMatch.keywords.every((keyword) => haystack.includes(keyword));
      if (!matchedEveryKeyword) {
        return false;
      }
    }

    return true;
  });
}

function compareSearchRank(
  left: LibraryDocumentRecord,
  right: LibraryDocumentRecord,
  searchMatch: SearchMatchState,
): number {
  if (!searchMatch.hasIndex) {
    return 0;
  }
  const rankDelta =
    (searchMatch.ranks.get(right.documentId) ?? 0) -
    (searchMatch.ranks.get(left.documentId) ?? 0);
  if (rankDelta !== 0) {
    return rankDelta;
  }
  return right.updatedAt.localeCompare(left.updatedAt) || left.path.localeCompare(right.path, "zh-Hans-CN");
}

function readOfflineSearchMatchState(
  exportDir: string,
  keyword: string | null | undefined,
  searchMode: "all" | "name" | "content" | undefined,
): SearchMatchState {
  const keywords = splitSearchKeywords(keyword ?? "");
  if (keywords.length === 0) {
    return createEmptySearchMatchState([]);
  }
  if (searchMode === "name") {
    return createEmptySearchMatchState(keywords);
  }

  const manifestPath = path.join(exportDir, "search", "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    return createEmptySearchMatchState(keywords);
  }
  const manifest = readJson<SearchManifestFile>(manifestPath);

  const ranks = new Map<string, number>();
  const groups = keywords.map((keywordItem) => {
    const documentIds = new Set<string>();
    for (const term of tokenizeSearchQuery(keywordItem)) {
      const prefix = resolveSearchBucketName(term);
      const buckets = manifest?.buckets?.filter(
        (bucket) => bucket.bucket === prefix || bucket.bucket.startsWith(`${prefix}-`),
      ) ?? [{ bucket: prefix, path: `search/${prefix}.json` }];
      for (const entry of buckets) {
        const bucket = readJson<SearchBucketFile>(path.join(exportDir, entry.path));
        if (!bucket) continue;
        let terms = searchTermViews.get(bucket);
        if (!terms) {
          terms = new Map((bucket.terms ?? []).map((posting) => [posting.term, posting]));
          searchTermViews.set(bucket, terms);
        }
        const posting = terms.get(term);
        if (!posting) continue;
        const postingDocumentIds = Array.isArray(posting.document_ids)
          ? posting.document_ids
          : (posting.postings ?? []).map((item) => item.document_id);
        for (const documentId of postingDocumentIds) {
          documentIds.add(documentId);
          ranks.set(documentId, (ranks.get(documentId) ?? 0) + 1);
        }
      }
    }

    return { keyword: keywordItem, documentIds };
  });

  return { hasIndex: ranks.size > 0, keywords, groups, ranks };
}

function createEmptySearchMatchState(keywords: string[]): SearchMatchState {
  return {
    hasIndex: false,
    keywords,
    groups: keywords.map((keywordItem) => ({
      keyword: keywordItem,
      documentIds: new Set<string>(),
    })),
    ranks: new Map(),
  };
}

function splitSearchKeywords(value: string): string[] {
  const seen = new Set<string>();
  return value
    .trim()
    .split(/\s+/)
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
    .filter((item) => {
      if (seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });
}

function tokenizeSearchQuery(value: string): string[] {
  const terms = new Set<string>();
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const wordMatches = normalized.match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
  for (const word of wordMatches) {
    if (word.length >= 2) {
      terms.add(word);
    }
  }

  const compact = normalized.replace(/\s+/g, "");
  const hanMatches = compact.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  for (const block of hanMatches) {
    if (block.length <= 4) {
      terms.add(block);
      continue;
    }
    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index <= block.length - size; index += 1) {
        terms.add(block.slice(index, index + size));
      }
    }
  }

  return [...terms];
}

function resolveSearchBucketName(term: string): string {
  const first = term[0] ?? "_";
  if (/[a-z0-9]/.test(first)) {
    return first;
  }
  return "han";
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

// 把标签路径展开为「自身 + 所有祖先」路径数组，复用项目既有的 "/" 分隔 + 前缀语义。
// 例："时间/2026/06" → ["时间", "时间/2026", "时间/2026/06"]
function expandTagAncestorPaths(tagPath: string): string[] {
  const segments = tagPath
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const paths: string[] = [];
  for (let index = 1; index <= segments.length; index += 1) {
    paths.push(segments.slice(0, index).join("/"));
  }
  return paths;
}

// 父标签应聚合子标签的文件数量：对每个文档，先把它的标签路径展开到所有祖先路径并用
// Set 去重，再给每个路径 +1。这样每个文档对每个祖先最多贡献 1，避免「文档同时打父子
// 标签」时重复计数。readTags 只遍历 taxonomy 节点，不在 taxonomy 的孤儿祖先键会被忽略。
function countTags(documents: LibraryDocumentRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const document of documents) {
    const expandedPaths = new Set<string>();
    for (const tagPath of new Set([
      ...document.tags,
      ...document.derivedTags,
    ])) {
      for (const ancestorPath of expandTagAncestorPaths(tagPath)) {
        expandedPaths.add(ancestorPath);
      }
    }
    for (const expandedPath of expandedPaths) {
      counts[expandedPath] = (counts[expandedPath] ?? 0) + 1;
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

const jsonViews = new Map<string, { version: string; value: unknown }>();

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const stat = fs.statSync(filePath, { bigint: true });
    const version = `${stat.ino}:${stat.mtimeNs}:${stat.size}`;
    const cached = jsonViews.get(filePath);
    if (cached?.version === version) return cached.value as T;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
    jsonViews.set(filePath, { version, value });
    return value;
  } catch {
    return null;
  }
}
