import fs from "node:fs";
import path from "node:path";

import type {
  LibraryBackup,
  LibraryBackupImportResult,
  LibraryBinding,
} from "@x-file/shared";

import type { LibraryBindingStore } from "../storage/library-binding-store.js";
import type { LibraryFavoritesStore } from "../storage/library-favorites-store.js";
import type { TagStore, StoredLibraryTags } from "../storage/tag-store.js";
import type { LibraryIndexService } from "./index-service.js";
import { LibraryError } from "./library-errors.js";

const BACKUP_FORMAT = "x-file-library-backup";
const BACKUP_VERSION = 1;

export class LibraryBackupService {
  private static readonly activeImports = new Set<string>();

  constructor(
    private readonly bindingStore: LibraryBindingStore,
    private readonly tagStore: TagStore,
    private readonly favoritesStore: LibraryFavoritesStore,
    private readonly indexService: LibraryIndexService | null,
  ) {}

  createBackup(): LibraryBackup {
    const binding = this.requireBinding();
    this.assertIndexIdle(binding);
    const lockKey = path.resolve(binding.rootDir);
    if (LibraryBackupService.activeImports.has(lockKey)) {
      throw new LibraryError(409, "LIBRARY_BACKUP_CONFLICT", "该资料库正在导入备份，请稍后重试");
    }
    LibraryBackupService.activeImports.add(lockKey);
    try {
    const snapshot = readDirectoryFingerprint(binding.rootDir);
    const indexDir = path.join(binding.rootDir, ".ai-index", "runtime");
    const storedTags = this.tagStore.read(binding.libraryId, binding.rootDir);
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: new Date().toISOString(),
      library: snapshot,
      tags: {
        tags: storedTags.tags,
        tagRules: storedTags.tagRules,
        documentTags: storedTags.documentTags,
        folderTags: storedTags.folderTags,
      } as unknown as LibraryBackup["tags"],
      favorites: this.favoritesStore.read(binding.libraryId, binding.rootDir),
      index: {
        catalog: readJsonIfPresent(path.join(indexDir, "export-catalog-snapshot.json")),
        activeFileStateSnapshot: readJsonIfPresent(path.join(indexDir, "active-file-state-snapshot.json")),
        indexStateSnapshot: readJsonIfPresent(path.join(indexDir, "index-state.json")),
        runtimeStatus: null,
      },
    };
    } finally {
      LibraryBackupService.activeImports.delete(lockKey);
    }
  }

  importBackup(input: unknown): LibraryBackupImportResult {
    const backup = validateBackup(input);
    const binding = this.requireBinding();
    this.assertIndexIdle(binding);
    const lockKey = path.resolve(binding.rootDir);
    if (LibraryBackupService.activeImports.has(lockKey)) {
      throw new LibraryError(409, "LIBRARY_BACKUP_CONFLICT", "该资料库正在导入备份，请稍后重试");
    }
    LibraryBackupService.activeImports.add(lockKey);
    try {
      const currentStructure = readDirectoryFingerprint(binding.rootDir);
      const differences = compareDirectoryFingerprints(backup.library, currentStructure);
      if (differences.length > 0) {
        throw new LibraryError(
          409,
          "LIBRARY_BACKUP_MISMATCH",
          `备份与当前资料库目录结构不匹配：${differences.join("；")}`,
        );
      }

      const remappedTags: StoredLibraryTags = {
        ...backup.tags,
        libraryId: binding.libraryId,
        rootDir: binding.rootDir,
        updatedAt: new Date().toISOString(),
      } as unknown as StoredLibraryTags;
      const runtimeDir = path.join(binding.rootDir, ".ai-index", "runtime");
      const runtimeFiles = [
        path.join(runtimeDir, "export-catalog-snapshot.json"),
        path.join(runtimeDir, "active-file-state-snapshot.json"),
        path.join(runtimeDir, "index-state.json"),
        path.join(binding.rootDir, ".ai-index", "runtime-status.json"),
      ];
      const tagStoreCheckpoint = this.tagStore.createCheckpoint();
      const favoritesStoreCheckpoint = this.favoritesStore.createCheckpoint();
      const previousRuntimeFiles = runtimeFiles.map((filePath) => [filePath, readJsonIfPresent(filePath)] as const);
      try {
        this.tagStore.write(remappedTags);
        this.favoritesStore.write(binding.libraryId, binding.rootDir, backup.favorites);
        writeJsonIfPresent(runtimeFiles[0]!, backup.index.catalog);
        writeJsonIfPresent(runtimeFiles[1]!, backup.index.activeFileStateSnapshot);
        writeJsonIfPresent(runtimeFiles[2]!, backup.index.indexStateSnapshot);
        writeJsonIfPresent(runtimeFiles[3]!, null);
      } catch (error) {
        this.tagStore.restoreCheckpoint(tagStoreCheckpoint);
        this.favoritesStore.restoreCheckpoint(favoritesStoreCheckpoint);
        for (const [filePath, value] of previousRuntimeFiles) restoreJsonFile(filePath, value);
        throw error;
      }

      const refresh = this.indexService?.requestRefresh(binding, {
        reason: "library_backup_imported",
      }) ?? createQueuedRefresh(binding);
      const documentCount = readCatalogDocumentCount(backup.index.catalog);
      return {
        imported: true,
        tagCount: backup.tags.tags.length,
        documentBindingCount: backup.tags.documentTags.length,
        folderBindingCount: backup.tags.folderTags.length,
        documentCount,
        refresh,
      };
    } finally {
      LibraryBackupService.activeImports.delete(lockKey);
    }
  }

  private requireBinding(): LibraryBinding {
    const binding = this.bindingStore.read();
    if (!binding) {
      throw new LibraryError(400, "LIBRARY_NOT_BOUND", "请先绑定文档库根目录");
    }
    return binding;
  }

  private assertIndexIdle(binding: LibraryBinding): void {
    const state = this.indexService?.getStatus(binding.rootDir).state;
    if (state === "queued" || state === "running") {
      throw new LibraryError(409, "LIBRARY_BACKUP_CONFLICT", "索引任务正在运行，请等待后重试");
    }
  }
}

export function readDirectoryFingerprint(rootDir: string): LibraryBackup["library"] {
  const rootName = path.basename(path.resolve(rootDir));
  const directories: string[] = [];
  const rootEntries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of rootEntries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || isInternalDirectory(entry.name)) continue;
    directories.push(entry.name);
    const firstLevelPath = path.join(rootDir, entry.name);
    for (const child of fs.readdirSync(firstLevelPath, { withFileTypes: true })) {
      if (!child.isDirectory() || child.isSymbolicLink()) continue;
      directories.push(`${entry.name}/${child.name}`);
    }
  }
  directories.sort();
  return { rootName, directories };
}

function validateBackup(value: unknown): LibraryBackup {
  if (!value || typeof value !== "object") throw invalidBackup("备份内容不是有效对象");
  const backup = value as Partial<LibraryBackup>;
  if (backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION) {
    throw invalidBackup("备份格式不受支持");
  }
  if (!backup.library || typeof backup.library.rootName !== "string" || !Array.isArray(backup.library.directories)) {
    throw invalidBackup("备份缺少资料库目录指纹");
  }
  if (!backup.library.rootName.trim() || /[\\/]/.test(backup.library.rootName)) {
    throw invalidBackup("备份资料库根目录名称无效");
  }
  if (!backup.tags || !Array.isArray(backup.tags.tags) || !Array.isArray(backup.tags.tagRules)
    || !Array.isArray(backup.tags.documentTags) || !Array.isArray(backup.tags.folderTags)) {
    throw invalidBackup("备份标签数据不完整");
  }
  if (!Array.isArray(backup.favorites) || !backup.index || typeof backup.index !== "object") {
    throw invalidBackup("备份收藏或索引数据不完整");
  }
  for (const key of ["catalog", "activeFileStateSnapshot", "indexStateSnapshot"] as const) {
    if (!Object.hasOwn(backup.index, key)
      || (backup.index[key] !== null && !isRecord(backup.index[key]))) {
      throw invalidBackup("备份索引数据格式不完整");
    }
  }
  const directories = backup.library.directories;
  if (directories.some((item) => typeof item !== "string" || !isSafeRelativeDirectory(item))) {
    throw invalidBackup("备份目录指纹包含无效路径");
  }
  if (new Set(directories).size !== directories.length || directories.some((item) => item.split("/").length > 2)) {
    throw invalidBackup("备份目录指纹包含重复或超过两层的目录");
  }
  if (backup.favorites.some((favorite) => !isRecord(favorite)
    || !["folder", "tag", "tag_filter"].includes(String(favorite.kind))
    || typeof favorite.path !== "string"
    || typeof favorite.label !== "string"
    || (favorite.path !== "" && !isSafeRelativeDirectory(favorite.path))
    || (favorite.tagPaths !== undefined && (!Array.isArray(favorite.tagPaths)
      || favorite.tagPaths.some((tagPath) => typeof tagPath !== "string" || !isSafeRelativeDirectory(tagPath))))
    || favorite.tagPaths?.some((tagPath) => !isSafeRelativeDirectory(tagPath)))) {
    throw invalidBackup("备份收藏包含无效路径");
  }
  if (!Object.hasOwn(backup.index, "runtimeStatus") || backup.index.runtimeStatus !== null) {
    throw invalidBackup("备份运行状态必须为空，导入时会重新建立索引状态");
  }
  validateTagData(backup.tags);
  validateCatalog(backup.index.catalog);
  validateRuntimeSnapshot(backup.index.activeFileStateSnapshot, ["files"]);
  validateRuntimeSnapshot(backup.index.indexStateSnapshot, ["failedDocuments", "skippedDocuments"]);
  if (backup.index.indexStateSnapshot !== null) {
    const parserSkips = isRecord(backup.index.indexStateSnapshot)
      ? backup.index.indexStateSnapshot.parserSkips
      : undefined;
    if (!Array.isArray(parserSkips) || parserSkips.some((item) => !isRecord(item)
      || !Array.isArray(item.samplePaths)
      || item.samplePaths.some((itemPath) => typeof itemPath !== "string" || !isSafeRelativeDirectory(itemPath)))) {
      throw invalidBackup("备份解析状态包含无效路径");
    }
  }
  return backup as LibraryBackup;
}

function validateRuntimeSnapshot(snapshot: unknown, fields: string[]): void {
  if (!isRecord(snapshot)) return;
  for (const field of fields) {
    const entries = snapshot[field];
    if (!Array.isArray(entries) || entries.some((item) => !isRecord(item)
      || typeof item.path !== "string" || !isSafeRelativeDirectory(item.path))) {
      throw invalidBackup("备份索引状态包含无效路径");
    }
  }
}

function validateTagData(tags: LibraryBackup["tags"]): void {
  const ids = new Set<string>();
  for (const tag of tags.tags) {
    if (!isRecord(tag) || typeof tag.id !== "string" || typeof tag.path !== "string" || !isSafeTagPath(tag.path)) {
      throw invalidBackup("备份包含无效标签定义");
    }
    if (ids.has(tag.id)) throw invalidBackup("备份包含重复标签 ID");
    ids.add(tag.id);
  }
  for (const tag of tags.tags) {
    if (isRecord(tag) && typeof tag.parentId === "string" && !ids.has(tag.parentId)) {
      throw invalidBackup("备份标签引用了不存在的父标签");
    }
  }
  for (const rule of tags.tagRules) {
    if (!isRecord(rule) || typeof rule.tagId !== "string" || !ids.has(rule.tagId)) {
      throw invalidBackup("备份规则引用了不存在的标签");
    }
  }
  for (const binding of tags.documentTags) {
    if (!isRecord(binding) || typeof binding.documentId !== "string" || typeof binding.path !== "string"
      || !isSafeRelativeDirectory(binding.path) || !Array.isArray(binding.manualTagIds)
      || binding.manualTagIds.some((id) => typeof id !== "string" || !ids.has(id))) {
      throw invalidBackup("备份包含无效文档标签绑定");
    }
  }
  for (const binding of tags.folderTags) {
    if (!isRecord(binding) || typeof binding.folderPath !== "string"
      || (binding.folderPath !== "" && !isSafeRelativeDirectory(binding.folderPath))
      || !Array.isArray(binding.bindingTagIds)
      || binding.bindingTagIds.some((id) => typeof id !== "string" || !ids.has(id))) {
      throw invalidBackup("备份包含无效文件夹标签绑定");
    }
  }
}

function isSafeTagPath(value: string): boolean {
  return value.trim().split("/").every((segment) => segment.trim().length > 0
    && segment.trim() !== "." && segment.trim() !== "..");
}

function validateCatalog(catalog: unknown): void {
  if (catalog === null) return;
  if (!isRecord(catalog) || !Array.isArray(catalog.tags) || !Array.isArray(catalog.documents)) {
    throw invalidBackup("备份索引快照无效");
  }
  if (catalog.documents.some((document) => !isRecord(document) || typeof document.path !== "string"
    || !isSafeRelativeDirectory(document.path))) {
    throw invalidBackup("备份索引包含无效文档路径");
  }
}

function compareDirectoryFingerprints(
  backup: LibraryBackup["library"],
  current: LibraryBackup["library"],
): string[] {
  const differences: string[] = [];
  if (backup.rootName !== current.rootName) differences.push("资料库根目录名称不同");
  const backupDirectories = new Set(backup.directories);
  const currentDirectories = new Set(current.directories);
  const missing = [...backupDirectories].filter((item) => !currentDirectories.has(item));
  const added = [...currentDirectories].filter((item) => !backupDirectories.has(item));
  if (missing.length || added.length) {
    differences.push(`浅层目录不同（缺少：${missing.slice(0, 5).join(", ") || "无"}；新增：${added.slice(0, 5).join(", ") || "无"}）`);
  }
  return differences;
}

function isInternalDirectory(name: string): boolean {
  return name === ".ai-index" || name === ".x-file";
}

function isSafeRelativeDirectory(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    && !isInternalDirectory(segments[0] ?? "");
}

function readJsonIfPresent(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function restoreJsonFile(filePath: string, value: unknown | null): void {
  if (value === null) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeJsonIfPresent(filePath: string, value: unknown): void {
  if (value === null) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  const backupPath = `${filePath}.restore-backup-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (fs.existsSync(filePath)) fs.renameSync(filePath, backupPath);
  try {
    fs.renameSync(temporaryPath, filePath);
    fs.rmSync(backupPath, { force: true });
  } catch (error) {
    if (fs.existsSync(backupPath)) fs.renameSync(backupPath, filePath);
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function readCatalogDocumentCount(catalog: unknown): number {
  return isRecord(catalog) && Array.isArray(catalog.documents) ? catalog.documents.length : 0;
}

function createQueuedRefresh(binding: LibraryBinding): LibraryBackupImportResult["refresh"] {
  return {
    accepted: true,
    libraryId: binding.libraryId,
    reason: "library_backup_imported",
    targetPath: null,
    taskId: "",
    deduped: false,
    status: {
      state: "queued",
      dirtyReasons: ["library_backup_imported"],
      lastRequestedAt: new Date().toISOString(),
      lastStartedAt: null,
      lastCompletedAt: null,
      lastFailedAt: null,
      nextAllowedAt: null,
      runningTaskId: null,
      runningStage: null,
      errorSummary: null,
    },
  };
}

function invalidBackup(message: string): LibraryError {
  return new LibraryError(400, "LIBRARY_BACKUP_INVALID", message);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
