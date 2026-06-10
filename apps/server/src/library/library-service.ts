import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

import type {
  LibraryBinding,
  LibraryDownload,
  LibraryDocumentList,
  LibraryFavoriteRecord,
  LibraryFileList,
  LibraryIndexStatus,
  LibraryOperationResult,
  LibraryOperationType,
  LibraryPreview,
  LibraryRefreshResult,
  LibrarySnapshot
} from "@x-file/shared";

import {
  buildPreviewCapabilities,
  detectPreviewKind,
  isResourcePreviewKind,
  MAX_PREVIEW_FILE_BYTES,
  MAX_RESOURCE_PREVIEW_FILE_BYTES,
  MAX_TEXT_FILE_BYTES
} from "./file-preview.js";
import type { LibraryBindingStore } from "../storage/library-binding-store.js";
import { resolveDefaultLibraryRootDir } from "../storage/library-binding-store.js";
import { LibraryConfigStore } from "../storage/library-config-store.js";
import { IndexRuntimeStore } from "../storage/index-runtime-store.js";
import { LibraryExportReader } from "../storage/library-export-reader.js";
import { LibraryFavoritesStore } from "../storage/library-favorites-store.js";
import { LibraryError } from "./library-errors.js";
import { LibraryIndexService } from "./index-service.js";
import { TaskManager } from "../tasks/task-manager.js";

const DEFAULT_LIBRARY_ID = "default";
const DEFAULT_CONFIG_RELATIVE_PATH = ".ai-index/doc-semantic-index.config.json";
const DEFAULT_ALLOWED_EXTENSIONS = [
  ".md",
  ".markdown",
  ".txt",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx"
];

export interface SaveLibraryBindingInput {
  rootDir?: string;
  completeInitialization?: boolean;
}

export interface ListLibraryDocumentsInput {
  browseMode?: string;
  selectedFolderPath?: string | null;
  selectedTagPath?: string | null;
  selectedTagPaths?: string[] | null;
  selectedFavoriteId?: string | null;
  keyword?: string | null;
  offset?: number;
  limit?: number;
}

export interface ListLibraryFilesInput {
  path?: string | null;
  limit?: number;
}

export interface PreviewLibraryFileInput {
  path?: string | null;
  displayMode?: string | null;
}

export interface LibraryOperationInput {
  opType?: string;
  srcPath?: string | null;
  dstPath?: string | null;
  content?: string | null;
  expectedVersion?: string | null;
}

export interface RefreshLibraryInput {
  reason?: string | null;
  targetPath?: string | null;
}

export interface UpdateLibraryFavoritesInput {
  favorites?: LibraryFavoriteRecord[];
}

export interface ResolvedLibraryPath {
  binding: LibraryBinding;
  rootDir: string;
  rootRealPath: string;
  relativePath: string;
  absolutePath: string;
  exists: boolean;
  stats: fs.Stats | null;
}

export class LibraryService {
  constructor(
    private readonly bindingStore: LibraryBindingStore,
    private readonly exportReader = new LibraryExportReader(),
    private readonly indexService: LibraryIndexService | null = createDefaultIndexService(),
    private readonly configStore = new LibraryConfigStore(),
    private readonly favoritesStore = new LibraryFavoritesStore()
  ) {}

  getBinding(): LibraryBinding | null {
    return this.bindingStore.read();
  }

  saveBinding(input: SaveLibraryBindingInput): LibraryBinding {
    const rootDir = input.rootDir?.trim() ?? "";
    if (!rootDir) {
      throw new LibraryError(400, "LIBRARY_PATH_INVALID", "文档库根目录不能为空", "rootDir");
    }

    const resolvedRootDir = path.resolve(rootDir);
    ensureDefaultLibraryRootDir(resolvedRootDir);
    assertReadableDirectory(resolvedRootDir);

    const existing = this.bindingStore.read();
    const now = new Date().toISOString();
    const keepsExistingInitialization = existing?.initialized === true && existing.rootDir === resolvedRootDir;
    const binding: LibraryBinding = {
      libraryId: existing?.libraryId ?? DEFAULT_LIBRARY_ID,
      rootDir: resolvedRootDir,
      enabled: true,
      mirrorRoot: existing?.mirrorRoot ?? null,
      allowedExtensions: existing?.allowedExtensions?.length
        ? existing.allowedExtensions
        : DEFAULT_ALLOWED_EXTENSIONS,
      includedHiddenPaths: existing?.includedHiddenPaths ?? [],
      folderOpenBehavior: existing?.folderOpenBehavior ?? "double_click",
      configRelativePath: existing?.configRelativePath ?? DEFAULT_CONFIG_RELATIVE_PATH,
      exportMode: "v2",
      initialized: true,
      initializedAt: keepsExistingInitialization ? existing.initializedAt : now,
      updatedAt: now
    };

    this.configStore.writeForBinding(binding);
    return this.bindingStore.write(binding);
  }

  getSnapshot(): LibrarySnapshot {
    const binding = this.bindingStore.read();
    const status = binding && this.indexService
      ? this.indexService.getStatus(binding.rootDir)
      : createEmptyStatus();
    return this.exportReader.readSnapshot(binding, status, binding ? this.readFavorites(binding) : []);
  }

  listDocuments(input: ListLibraryDocumentsInput): LibraryDocumentList {
    const binding = this.bindingStore.read();
    return this.exportReader.listDocuments(binding, {
      browseMode: input.browseMode,
      selectedFolderPath: input.selectedFolderPath,
      selectedTagPath: input.selectedTagPath,
      selectedTagPaths: input.selectedTagPaths,
      selectedFavoriteId: input.selectedFavoriteId,
      keyword: input.keyword,
      offset: normalizeNonNegativeInteger(input.offset, 0),
      limit: normalizeLimit(input.limit, 50),
      favorites: binding ? this.readFavorites(binding) : []
    });
  }

  listFiles(input: ListLibraryFilesInput): LibraryFileList {
    const binding = this.requireBinding();
    const relativePath = normalizeRelativePath(input.path ?? "");
    const absolutePath = resolveInsideRoot(binding.rootDir, relativePath);
    const limit = normalizeLimit(input.limit, 200);

    if (!fs.existsSync(absolutePath)) {
      return { items: [], path: relativePath, total: 0, limit };
    }

    const stats = fs.statSync(absolutePath);
    if (!stats.isDirectory()) {
      throw new LibraryError(400, "LIBRARY_PATH_INVALID", "路径不是目录", "path");
    }

    const items = fs.readdirSync(absolutePath, { withFileTypes: true }).slice(0, limit).map((entry) => {
      const entryRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
      const entryStats = fs.statSync(path.join(absolutePath, entry.name));
      return {
        path: entryRelativePath,
        name: entry.name,
        kind: entry.isDirectory() ? "directory" as const : "file" as const,
        size: entry.isDirectory() ? null : entryStats.size,
        updatedAt: entryStats.mtime.toISOString()
      };
    });

    return {
      items,
      path: relativePath,
      total: items.length,
      limit
    };
  }

  previewFile(input: PreviewLibraryFileInput): LibraryPreview {
    const resolved = this.resolveLibraryPath(input.path ?? "", {
      mustExist: true,
      kind: "file"
    });
    const previewKind = detectPreviewKind(resolved.relativePath);
    const fileSize = resolved.stats?.size ?? 0;
    const updatedAt = resolved.stats?.mtime.toISOString() ?? null;

    if (
      isResourcePreviewKind(previewKind)
      && previewKind !== "office"
      && fileSize > MAX_RESOURCE_PREVIEW_FILE_BYTES
    ) {
      return buildPreviewResult({
        libraryId: resolved.binding.libraryId,
        path: resolved.relativePath,
        supported: false,
        kind: "unsupported",
        reason: "文件过大，当前内置资源预览暂不处理这么大的文件",
        content: null,
        version: null,
        size: fileSize,
        updatedAt
      });
    }

    if (!isResourcePreviewKind(previewKind) && fileSize > MAX_PREVIEW_FILE_BYTES) {
      return buildPreviewResult({
        libraryId: resolved.binding.libraryId,
        path: resolved.relativePath,
        supported: false,
        kind: "unsupported",
        reason: "文件过大，本轮只提供轻量预览",
        content: null,
        version: null,
        size: fileSize,
        updatedAt
      });
    }

    if (previewKind === "image" || previewKind === "pdf" || previewKind === "office") {
      return buildPreviewResult({
        libraryId: resolved.binding.libraryId,
        path: resolved.relativePath,
        supported: true,
        kind: previewKind,
        reason: null,
        content: null,
        version: previewKind === "office" ? buildOfficeDocumentVersion(fileSize, updatedAt) : null,
        size: fileSize,
        updatedAt
      });
    }

    const buffer = fs.readFileSync(resolved.absolutePath);
    if (buffer.includes(0)) {
      return buildPreviewResult({
        libraryId: resolved.binding.libraryId,
        path: resolved.relativePath,
        supported: false,
        kind: "binary",
        reason: "二进制文件暂不支持直接预览",
        content: null,
        version: null,
        size: fileSize || buffer.byteLength,
        updatedAt
      });
    }

    return buildPreviewResult({
      libraryId: resolved.binding.libraryId,
      path: resolved.relativePath,
      supported: true,
      kind: previewKind,
      reason: null,
      content: buffer.toString("utf8"),
      version: shouldEnableInlineEditing(previewKind, fileSize || buffer.byteLength)
        ? hashContent(buffer)
        : null,
      size: fileSize || buffer.byteLength,
      updatedAt
    });
  }

  downloadFile(input: PreviewLibraryFileInput): LibraryDownload {
    const resolved = this.resolveLibraryPath(input.path ?? "", {
      mustExist: true,
      kind: "file"
    });
    ensureUserContentPath(resolved.relativePath);
    const buffer = fs.readFileSync(resolved.absolutePath);
    const stats = resolved.stats ?? fs.statSync(resolved.absolutePath);
    return {
      libraryId: resolved.binding.libraryId,
      path: resolved.relativePath,
      fileName: path.basename(resolved.relativePath) || resolved.relativePath,
      contentBase64: buffer.toString("base64"),
      size: buffer.byteLength,
      updatedAt: stats.mtime.toISOString()
    };
  }

  operateFile(input: LibraryOperationInput): LibraryOperationResult {
    const opType = normalizeOperationType(input.opType);
    if (opType === "create_directory" || opType === "create_file") {
      const target = this.resolveLibraryPath(input.dstPath ?? "", {
        mustExist: false,
        kind: opType === "create_directory" ? "directory" : "file"
      });
      ensureUserContentPath(target.relativePath);

      if (target.exists) {
        throw new LibraryError(409, "FILE_ALREADY_EXISTS", "目标路径已存在", "dstPath");
      }

      fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
      if (opType === "create_directory") {
        fs.mkdirSync(target.absolutePath);
      } else {
        fs.writeFileSync(target.absolutePath, input.content ?? "", "utf8");
      }
      this.enqueueRefreshAfterMutation(`file_${opType}`, target.relativePath);

      return {
        success: true,
        opType,
        sourcePath: target.relativePath,
        targetPath: target.relativePath
      };
    }

    const source = this.resolveLibraryPath(input.srcPath ?? "", {
      mustExist: true,
      kind: "any"
    });
    ensureUserContentPath(source.relativePath);

    if (opType === "write") {
      if (!source.stats?.isFile()) {
        throw new LibraryError(400, "NOT_A_FILE", "指定路径不是文件", "srcPath");
      }

      const currentBuffer = fs.readFileSync(source.absolutePath);
      ensureEditableTextBuffer(currentBuffer);
      const currentVersion = hashContent(currentBuffer);
      const expectedVersion = input.expectedVersion?.trim() ?? "";

      if (!expectedVersion) {
        throw new LibraryError(400, "INVALID_CONTENT", "保存文件必须提供 expectedVersion", "expectedVersion");
      }

      if (expectedVersion !== currentVersion) {
        throw new LibraryError(409, "FILE_VERSION_CONFLICT", "文件已被其他修改覆盖，请先刷新再保存", "expectedVersion");
      }

      const nextBuffer = Buffer.from(input.content ?? "", "utf8");
      ensureWritableTextBuffer(nextBuffer);
      fs.writeFileSync(source.absolutePath, nextBuffer);
      this.enqueueRefreshAfterMutation("file_write", source.relativePath);
      return {
        success: true,
        opType,
        sourcePath: source.relativePath,
        targetPath: source.relativePath
      };
    }

    if (opType === "delete") {
      if (source.stats?.isDirectory()) {
        fs.rmSync(source.absolutePath, { recursive: true, force: false });
      } else {
        fs.rmSync(source.absolutePath, { force: false });
      }
      this.enqueueRefreshAfterMutation("file_delete", source.relativePath);
      return {
        success: true,
        opType,
        sourcePath: source.relativePath,
        targetPath: null
      };
    }

    const target = this.resolveLibraryPath(input.dstPath ?? "", {
      mustExist: false,
      kind: "any"
    });
    ensureUserContentPath(target.relativePath);

    if (target.exists) {
      throw new LibraryError(409, "FILE_ALREADY_EXISTS", "目标路径已存在", "dstPath");
    }

    if (source.relativePath === target.relativePath) {
      throw new LibraryError(400, "INVALID_FILE_OPERATION", "源路径和目标路径不能相同", "dstPath");
    }

    if (source.stats?.isDirectory() && isSameOrDescendantRelativePath(source.relativePath, target.relativePath)) {
      throw new LibraryError(
        400,
        "INVALID_FILE_OPERATION",
        opType === "move" ? "目录不能移动到自己内部" : "目录不能复制到自己内部",
        "dstPath"
      );
    }

    fs.mkdirSync(path.dirname(target.absolutePath), { recursive: true });
    if (opType === "move") {
      fs.renameSync(source.absolutePath, target.absolutePath);
    } else {
      fs.cpSync(source.absolutePath, target.absolutePath, {
        recursive: source.stats?.isDirectory() ?? false,
        errorOnExist: true,
        force: false
      });
    }
    this.enqueueRefreshAfterMutation(`file_${opType}`, target.relativePath);

    return {
      success: true,
      opType,
      sourcePath: source.relativePath,
      targetPath: target.relativePath
    };
  }

  requestRefresh(input: RefreshLibraryInput): LibraryRefreshResult {
    const binding = this.requireBinding();
    if (this.indexService) {
      return this.indexService.requestRefresh(binding, input);
    }

    return {
      accepted: true,
      libraryId: binding.libraryId,
      reason: input.reason?.trim() || "manual_refresh",
      targetPath: input.targetPath?.trim() || null,
      status: createEmptyStatus("queued")
    };
  }

  updateFavorites(input: UpdateLibraryFavoritesInput): { items: LibraryFavoriteRecord[] } {
    const binding = this.requireBinding();
    return {
      items: this.favoritesStore.write(binding.libraryId, binding.rootDir, Array.isArray(input.favorites) ? input.favorites : [])
    };
  }

  private readFavorites(binding: LibraryBinding): LibraryFavoriteRecord[] {
    return this.favoritesStore.read(binding.libraryId, binding.rootDir);
  }

  private requireBinding(): LibraryBinding {
    const binding = this.bindingStore.read();
    if (!binding) {
      throw new LibraryError(400, "LIBRARY_NOT_BOUND", "请先绑定文档库根目录");
    }
    return binding;
  }

  resolveLibraryPath(
    requestedPath: string,
    options: {
      mustExist?: boolean;
      kind?: "file" | "directory" | "any";
      allowRoot?: boolean;
    } = {}
  ): ResolvedLibraryPath {
    const binding = this.requireBinding();
    assertReadableDirectory(binding.rootDir);
    const rootRealPath = fs.realpathSync.native(binding.rootDir);
    const relativePath = normalizeRelativePath(requestedPath, options.allowRoot ?? false);
    const absolutePath = path.resolve(binding.rootDir, relativePath);
    const relativeToRoot = path.relative(binding.rootDir, absolutePath);

    if (
      relativeToRoot === ".."
      || relativeToRoot.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeToRoot)
    ) {
      throw new LibraryError(400, "LIBRARY_PATH_INVALID", "路径不能越过文档库根目录", "path");
    }

    const exists = fs.existsSync(absolutePath);
    let stats: fs.Stats | null = null;

    if (exists) {
      const targetRealPath = fs.realpathSync.native(absolutePath);
      const relativeToRealRoot = path.relative(rootRealPath, targetRealPath);

      if (
        relativeToRealRoot === ".."
        || relativeToRealRoot.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeToRealRoot)
      ) {
        throw new LibraryError(400, "LIBRARY_PATH_INVALID", "路径不能越过文档库根目录", "path");
      }

      stats = fs.statSync(absolutePath);
    } else if (options.mustExist ?? true) {
      throw new LibraryError(404, "FILE_NOT_FOUND", "指定文件不存在", "path");
    }

    if (stats && options.kind === "file" && !stats.isFile()) {
      throw new LibraryError(400, "NOT_A_FILE", "指定路径不是文件", "path");
    }

    if (stats && options.kind === "directory" && !stats.isDirectory()) {
      throw new LibraryError(400, "NOT_A_DIRECTORY", "指定路径不是目录", "path");
    }

    return {
      binding,
      rootDir: binding.rootDir,
      rootRealPath,
      relativePath,
      absolutePath,
      exists,
      stats
    };
  }

  notifyFileChanged(reason: string, targetPath: string | null): LibraryRefreshResult | null {
    const binding = this.bindingStore.read();
    if (!binding || !this.indexService) {
      return null;
    }

    return this.indexService.requestRefresh(binding, {
      reason,
      targetPath
    });
  }

  private enqueueRefreshAfterMutation(reason: string, targetPath: string): void {
    const binding = this.bindingStore.read();
    if (!binding || !this.indexService) {
      return;
    }

    this.indexService.requestRefresh(binding, {
      reason,
      targetPath
    });
  }
}

function createEmptyStatus(state: LibraryIndexStatus["state"] = "fresh"): LibraryIndexStatus {
  return {
    state,
    dirtyReasons: [],
    lastRequestedAt: state === "queued" ? new Date().toISOString() : null,
    lastStartedAt: null,
    lastCompletedAt: null,
    lastFailedAt: null,
    nextAllowedAt: null,
    runningTaskId: null,
    runningStage: null,
    errorSummary: null,
    workerHealth: null,
    progress: null
  };
}

function createDefaultIndexService(): LibraryIndexService {
  return new LibraryIndexService(new TaskManager(), new IndexRuntimeStore());
}

function assertReadableDirectory(rootDir: string): void {
  try {
    const stats = fs.statSync(rootDir);
    if (!stats.isDirectory()) {
      throw new LibraryError(400, "LIBRARY_PATH_INVALID", "文档库根目录必须是目录", "rootDir");
    }
    fs.accessSync(rootDir, fs.constants.R_OK);
  } catch (error) {
    if (error instanceof LibraryError) {
      throw error;
    }
    throw new LibraryError(400, "LIBRARY_PATH_INVALID", "文档库根目录不存在或不可读", "rootDir");
  }
}

function ensureDefaultLibraryRootDir(rootDir: string): void {
  if (rootDir !== path.resolve(resolveDefaultLibraryRootDir())) {
    return;
  }

  fs.mkdirSync(rootDir, { recursive: true });
}

function normalizeRelativePath(value: string, allowRoot = true): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "").trim();
  const segments = normalized
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    if (allowRoot) {
      return "";
    }
    throw new LibraryError(400, "LIBRARY_PATH_INVALID", "路径不能为空", "path");
  }

  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new LibraryError(400, "LIBRARY_PATH_INVALID", "路径不能包含 . 或 ..", "path");
  }

  const result = path.posix.normalize(segments.join("/")).replace(/^\/+|\/+$/g, "");
  if (!result || result === "." || result === ".." || result.startsWith("../")) {
    throw new LibraryError(400, "LIBRARY_PATH_INVALID", "路径无效", "path");
  }
  return result;
}

function resolveInsideRoot(rootDir: string, relativePath: string): string {
  const rootRealPath = fs.realpathSync(rootDir);
  const absolutePath = path.resolve(rootRealPath, relativePath);
  const parentPath = fs.existsSync(absolutePath) ? fs.realpathSync(absolutePath) : path.dirname(absolutePath);

  if (parentPath !== rootRealPath && !parentPath.startsWith(`${rootRealPath}${path.sep}`)) {
    throw new LibraryError(400, "LIBRARY_PATH_INVALID", "路径不能越过文档库根目录", "path");
  }

  return absolutePath;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value < 0) {
    return fallback;
  }
  return Math.floor(value);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  const limit = normalizeNonNegativeInteger(value, fallback);
  return Math.min(Math.max(limit, 1), 500);
}

function buildPreviewResult(
  input: Omit<LibraryPreview, "previewPath" | "previewUrl" | "onlyOffice" | "capabilities">
): LibraryPreview {
  return {
    ...input,
    previewPath: null,
    previewUrl: null,
    onlyOffice: null,
    capabilities: buildPreviewCapabilities(input.kind, {
      supported: input.supported,
      content: input.content,
      version: input.version
    })
  };
}

function buildOfficeDocumentVersion(fileSize: number, updatedAt: string | null): string | null {
  if (!updatedAt) {
    return null;
  }

  return `${updatedAt}:${fileSize}`;
}

function shouldEnableInlineEditing(previewKind: LibraryPreview["kind"], fileSize: number): boolean {
  return fileSize <= MAX_TEXT_FILE_BYTES
    && (previewKind === "text" || previewKind === "markdown" || previewKind === "html");
}

function ensureUserContentPath(relativePath: string): void {
  const normalized = relativePath.trim().replace(/^\.\/+/, "");
  if (!normalized || normalized === ".ai-index" || normalized.startsWith(".ai-index/")) {
    throw new LibraryError(400, "INVALID_FILE_OPERATION", "文档库内部索引文件不能在这里操作", "path");
  }
}

function ensureEditableTextBuffer(buffer: Buffer): void {
  if (buffer.byteLength > MAX_TEXT_FILE_BYTES) {
    throw new LibraryError(400, "FILE_TOO_LARGE", "文件过大，暂不支持直接编辑", "srcPath");
  }

  if (buffer.includes(0)) {
    throw new LibraryError(400, "BINARY_FILE_NOT_SUPPORTED", "二进制文件暂不支持直接编辑", "srcPath");
  }
}

function ensureWritableTextBuffer(buffer: Buffer): void {
  if (buffer.byteLength > MAX_TEXT_FILE_BYTES) {
    throw new LibraryError(400, "FILE_TOO_LARGE", "文件过大，暂不支持直接保存", "content");
  }
}

function hashContent(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeOperationType(value: string | undefined): LibraryOperationType {
  if (
    value === "delete"
    || value === "move"
    || value === "copy"
    || value === "create_directory"
    || value === "create_file"
    || value === "write"
  ) {
    return value;
  }

  throw new LibraryError(400, "INVALID_FILE_OPERATION", "不支持的文档库文件操作", "opType");
}

function isSameOrDescendantRelativePath(targetPath: string, candidatePath: string): boolean {
  return candidatePath === targetPath || candidatePath.startsWith(`${targetPath}/`);
}
