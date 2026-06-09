import crypto from "node:crypto";
import path from "node:path";
import {
  CatalogRepository,
  CatalogWriteRepository,
  initCatalog,
  loadRuntimeConfig,
  TagRecomputeService,
  type RecomputeScope,
} from "@x-file/indexer";

import type {
  LibraryDocumentTagDetails,
  LibraryFolderTagDetails,
  LibraryTagDetailWithRules,
  LibraryTagNodeDetail,
} from "@x-file/shared";

import { LibraryError } from "./library-errors.js";
import type { LibraryBindingStore } from "../storage/library-binding-store.js";
import type {
  StoredLibraryTags,
  StoredTagDefinition,
  StoredTagRule,
  TagStore,
} from "../storage/tag-store.js";
import type { TaskManager, TaskSummary } from "../tasks/task-manager.js";

export const LIBRARY_TAG_RECOMPUTE_TASK_TYPE = "library.tag_recompute";

export interface ListTagsInput {
  includeDisabled?: boolean;
}

export interface CreateTagInput {
  name?: string;
  parentId?: string | null;
  description?: string | null;
  status?: "active" | "disabled";
  smartRules?: StoredTagRuleInput[];
}

export interface UpdateTagInput extends CreateTagInput {
  status?: "active" | "disabled";
}

export interface StoredTagRuleInput {
  id?: string;
  relation?: "and" | "or" | "not";
  ruleType?: StoredTagRule["ruleType"];
  matcher?: Record<string, unknown>;
  enabled?: boolean;
  priority?: number;
}

type TagRecommendationResult = {
  tagId: string;
  path: string;
  name: string;
  score: number;
  reason: "name_match" | "folder_context" | "smart_rule" | "time_pattern";
  evidence: string;
};

export interface EnsureTagInput {
  path?: string;
}

export interface SaveDocumentTagsInput {
  tagIds?: string[];
  createTagPaths?: string[];
}

export interface SaveFolderTagsInput extends SaveDocumentTagsInput {
  folderPath?: string;
}

export class TagService {
  constructor(
    private readonly bindingStore: LibraryBindingStore,
    private readonly tagStore: TagStore,
    private readonly taskManager: TaskManager | null = null,
  ) {}

  registerTasks(): void {
    if (
      !this.taskManager ||
      this.taskManager.has(LIBRARY_TAG_RECOMPUTE_TASK_TYPE)
    ) {
      return;
    }
    this.taskManager.register<
      LibraryTagRecomputeTaskInput,
      LibraryTagRecomputeTaskResult
    >({
      taskType: LIBRARY_TAG_RECOMPUTE_TASK_TYPE,
      timeoutMs: 30 * 60 * 1000,
      run: async (input, context) => {
        const config = loadRuntimeConfig(input.binding.rootDir, {
          args: {
            rootDir: input.binding.rootDir,
            allowedExtensions: input.binding.allowedExtensions,
            includedHiddenPaths: input.binding.includedHiddenPaths,
          },
        });
        initCatalog(config);
        const result = await new TagRecomputeService(config).run({
          scope: input.scope,
          signal: context.signal,
          onProgress: (progress) => context.setStage(progress.label),
        });
        return {
          scannedCount: result.scannedCount,
          updatedCount: result.updatedCount,
          directAssignedCount: result.directAssignedCount,
          derivedAssignedCount: result.derivedAssignedCount,
          exportedAt: result.exportResult?.exportedAt ?? null,
        };
      },
    });
  }

  listTags(input: ListTagsInput = {}) {
    const binding = this.requireCurrentBinding();
    const data = this.readStoreForBinding(binding);
    const items = data.tags
      .filter(
        (tag) => input.includeDisabled === true || tag.status === "active",
      )
      .map((tag) => this.toTagDetail(tag, data));

    return {
      items,
      summary: {
        totalActiveTags: data.tags.filter((tag) => tag.status === "active")
          .length,
        totalDisabledTags: data.tags.filter((tag) => tag.status === "disabled")
          .length,
        totalRuleEnabledTags: new Set(
          data.tagRules
            .filter((rule) => rule.enabled)
            .map((rule) => rule.tagId),
        ).size,
        totalBoundDocuments: data.documentTags.filter(
          (item) => item.manualTagIds.length > 0,
        ).length,
      },
      status: {
        ...this.resolveRecomputeStatus(binding.rootDir),
      },
    };
  }

  createTag(input: CreateTagInput): LibraryTagDetailWithRules {
    const name = normalizeTagSegment(input.name ?? "");
    if (!name) {
      throw new LibraryError(400, "INVALID_INPUT", "标签名称不能为空", "name");
    }

    const binding = this.requireCurrentBinding();
    const data = this.readStoreForBinding(binding);
    const parent = input.parentId
      ? (data.tags.find((tag) => tag.id === input.parentId) ?? null)
      : null;
    if (input.parentId && !parent) {
      throw new LibraryError(404, "INVALID_INPUT", "父标签不存在", "parentId");
    }

    const tagPath = parent ? `${parent.path}/${name}` : name;
    const tag = this.ensureTagInStore(data, tagPath, input.description ?? null);
    if (input.status === "disabled") {
      tag.status = "disabled";
      tag.disabledAt = tag.disabledAt ?? new Date().toISOString();
    } else if (input.status === "active") {
      tag.status = "active";
      tag.disabledAt = null;
    }
    if (Array.isArray(input.smartRules)) {
      replaceTagRules(data, tag.id, input.smartRules);
    }
    this.writeCurrentStore(data);
    this.syncTagCatalogAndMaybeRecompute(binding, data, {
      reason: `tag_definition_saved:${tag.id}`,
      scope: { kind: "full" },
      shouldRecompute: Array.isArray(input.smartRules),
    });
    return this.toTagDetail(tag, data);
  }

  ensureTag(input: EnsureTagInput): LibraryTagDetailWithRules {
    const binding = this.requireCurrentBinding();
    const data = this.readStoreForBinding(binding);
    const tag = this.ensureTagInStore(
      data,
      normalizeTagPath(input.path ?? ""),
      null,
    );
    this.writeCurrentStore(data);
    this.syncTagDefinitionsToCatalog(binding.rootDir, data);
    return this.toTagDetail(tag, data);
  }

  getTagDetail(tagId: string): LibraryTagDetailWithRules {
    const binding = this.requireCurrentBinding();
    const data = this.readStoreForBinding(binding);
    const tag = this.requireTag(data, tagId);
    return this.toTagDetail(tag, data);
  }

  updateTag(tagId: string, input: UpdateTagInput): LibraryTagDetailWithRules {
    const binding = this.requireCurrentBinding();
    const data = this.readStoreForBinding(binding);
    const tag = this.requireTag(data, tagId);
    const name = normalizeTagSegment(input.name ?? tag.name);
    if (!name) {
      throw new LibraryError(400, "INVALID_INPUT", "标签名称不能为空", "name");
    }

    const parentId =
      input.parentId === undefined ? tag.parentId : input.parentId;
    const parent = parentId
      ? (data.tags.find((item) => item.id === parentId) ?? null)
      : null;
    if (parentId && !parent) {
      throw new LibraryError(
        404,
        "LIBRARY_TAG_NOT_FOUND",
        "父标签不存在",
        "parentId",
      );
    }
    if (
      parent &&
      (parent.id === tag.id || isDescendantTag(data.tags, parent.id, tag.id))
    ) {
      throw new LibraryError(
        400,
        "INVALID_INPUT",
        "不能把标签移动到自己或子标签下面",
        "parentId",
      );
    }

    const oldPath = tag.path;
    const nextPath = parent ? `${parent.path}/${name}` : name;
    const duplicate = data.tags.find(
      (item) => item.id !== tag.id && item.path === nextPath,
    );
    if (duplicate) {
      throw new LibraryError(409, "INVALID_INPUT", "同级标签已存在", "name");
    }

    const now = new Date().toISOString();
    tag.name = name;
    tag.path = nextPath;
    tag.rootType = nextPath.split("/")[0] ?? name;
    tag.parentId = parent?.id ?? null;
    tag.parentPath = parent?.path ?? null;
    tag.description = input.description ?? tag.description;
    if (input.status === "disabled") {
      tag.status = "disabled";
      tag.disabledAt = tag.disabledAt ?? now;
    } else if (input.status === "active") {
      tag.status = "active";
      tag.disabledAt = null;
    }
    tag.updatedAt = now;

    if (oldPath !== nextPath) {
      updateDescendantPaths(data.tags, tag.id, oldPath, nextPath);
    }
    if (Array.isArray(input.smartRules)) {
      replaceTagRules(data, tag.id, input.smartRules);
    }

    this.writeCurrentStore(data);
    this.syncTagCatalogAndMaybeRecompute(binding, data, {
      reason: `tag_definition_saved:${tag.id}`,
      scope: { kind: "full" },
      shouldRecompute: Array.isArray(input.smartRules),
    });
    return this.toTagDetail(tag, data);
  }

  deleteTag(tagId: string): { deletedTagIds: string[] } {
    const binding = this.requireCurrentBinding();
    const data = this.readStoreForBinding(binding);
    const tag = this.requireTag(data, tagId);
    const deletedTagIds = [
      tag.id,
      ...collectDescendantTags(data.tags, tag.id).map((item) => item.id),
    ];
    const deleted = new Set(deletedTagIds);
    data.tags = data.tags.filter((item) => !deleted.has(item.id));
    data.tagRules = data.tagRules.filter((rule) => !deleted.has(rule.tagId));
    data.documentTags = data.documentTags.map((binding) => ({
      ...binding,
      manualTagIds: binding.manualTagIds.filter((id) => !deleted.has(id)),
    }));
    data.folderTags = data.folderTags.map((binding) => ({
      ...binding,
      bindingTagIds: binding.bindingTagIds.filter((id) => !deleted.has(id)),
    }));
    this.writeCurrentStore(data);
    deleteCatalogTags(binding.rootDir, deletedTagIds);
    this.syncTagCatalogAndMaybeRecompute(binding, data, {
      reason: `tag_definition_deleted:${tag.id}`,
      scope: { kind: "full" },
      shouldRecompute: true,
    });
    return { deletedTagIds };
  }

  getDocumentTagDetails(documentId: string): LibraryDocumentTagDetails {
    const binding = this.requireCurrentBinding();
    const data = this.readStoreForBinding(binding);
    const normalizedDocumentId = normalizeRequiredId(documentId, "documentId");
    const catalogContext = readCatalogDocumentContext(
      binding.rootDir,
      normalizedDocumentId,
      normalizedDocumentId,
    );
    const storedBinding = data.documentTags.find(
      (item) => item.documentId === normalizedDocumentId,
    );
    const documentPath =
      catalogContext?.path ?? storedBinding?.path ?? normalizedDocumentId;
    const effectiveFolderBindings = this.resolveFolderBindingsForPath(
      data,
      documentPath,
    );
    const catalogResolved = catalogContext
      ? readCatalogResolvedTags(binding.rootDir, catalogContext.documentId)
      : [];

    return {
      documentId: normalizedDocumentId,
      path: documentPath,
      title:
        catalogContext?.title ??
        storedBinding?.title ??
        path.basename(documentPath) ??
        documentPath,
      manualTagIds: storedBinding?.manualTagIds ?? [],
      effectiveFolderBindings,
      resolvedTags: mergeResolvedTagSources([
        ...(storedBinding?.manualTagIds ?? []).map((tagId) =>
          this.toResolvedTagSource(
            data,
            tagId,
            "manual_document",
            normalizedDocumentId,
          ),
        ),
        ...effectiveFolderBindings.map((item) =>
          this.toResolvedTagSource(data, item.tagId, "folder_binding", item.id),
        ),
        ...catalogResolved,
      ]).filter((item) => item.path.length > 0),
      recommendedTags: buildTagRecommendations(data, {
        targetKind: "document",
        targetPath: documentPath,
        title:
          catalogContext?.title ??
          storedBinding?.title ??
          path.basename(documentPath),
        excludedTagIds: [
          ...(storedBinding?.manualTagIds ?? []),
          ...effectiveFolderBindings.map((item) => item.tagId),
        ],
        modifiedAt: catalogContext?.modifiedAt,
      }),
    };
  }

  saveDocumentTags(
    documentId: string,
    input: SaveDocumentTagsInput,
  ): LibraryDocumentTagDetails {
    const binding = this.requireCurrentBinding();
    const data = this.readStoreForBinding(binding);
    const normalizedDocumentId = normalizeRequiredId(documentId, "documentId");
    const createdTagIds = this.ensureInputTagIds(data, input);
    const manualTagIds = normalizeKnownTagIds(data, [
      ...(input.tagIds ?? []),
      ...createdTagIds,
    ]);
    const existing = data.documentTags.find(
      (item) => item.documentId === normalizedDocumentId,
    );
    const next = {
      documentId: normalizedDocumentId,
      path: existing?.path ?? normalizedDocumentId,
      title:
        existing?.title ??
        (path.basename(normalizedDocumentId) || normalizedDocumentId),
      manualTagIds,
      updatedAt: new Date().toISOString(),
    };

    data.documentTags = [
      ...data.documentTags.filter(
        (item) => item.documentId !== normalizedDocumentId,
      ),
      next,
    ];
    this.writeCurrentStore(data);
    this.syncManualDocumentBindingToCatalog(binding.rootDir, data, next);
    const catalogContext = readCatalogDocumentContext(
      binding.rootDir,
      normalizedDocumentId,
      next.path,
    );
    this.enqueueTagRecompute(binding, {
      reason: `manual_document_tags_saved:${normalizedDocumentId}`,
      scope: {
        kind: "document",
        documentId: catalogContext?.documentId ?? normalizedDocumentId,
      },
    });
    return this.getDocumentTagDetails(normalizedDocumentId);
  }

  getFolderTagDetails(folderPath: string): LibraryFolderTagDetails {
    const currentBinding = this.requireCurrentBinding();
    const data = this.readStoreForBinding(currentBinding);
    const normalizedFolderPath = normalizeFolderPath(folderPath);
    const binding = data.folderTags.find(
      (item) => item.folderPath === normalizedFolderPath,
    );
    const bindingTagIds = binding?.bindingTagIds ?? [];

    return {
      folderPath: normalizedFolderPath,
      exists: true,
      bindingTagIds,
      bindings: bindingTagIds.map((tagId) => {
        const tag = data.tags.find((item) => item.id === tagId);
        return {
          id: folderBindingId(normalizedFolderPath, tagId),
          tagId,
          tagPath: tag?.path ?? "",
          applyMode: "recursive",
        };
      }),
      recommendedTags: buildTagRecommendations(data, {
        targetKind: "folder",
        targetPath: normalizedFolderPath,
        title: path.basename(normalizedFolderPath),
        excludedTagIds: bindingTagIds,
      }),
    };
  }

  saveFolderTags(input: SaveFolderTagsInput): LibraryFolderTagDetails {
    const binding = this.requireCurrentBinding();
    const data = this.readStoreForBinding(binding);
    const folderPath = normalizeFolderPath(input.folderPath ?? "");
    const createdTagIds = this.ensureInputTagIds(data, input);
    const bindingTagIds = normalizeKnownTagIds(data, [
      ...(input.tagIds ?? []),
      ...createdTagIds,
    ]);

    data.folderTags = [
      ...data.folderTags.filter((item) => item.folderPath !== folderPath),
      {
        folderPath,
        bindingTagIds,
        updatedAt: new Date().toISOString(),
      },
    ];
    this.writeCurrentStore(data);
    this.syncFolderBindingToCatalog(
      binding.rootDir,
      data,
      folderPath,
      bindingTagIds,
    );
    this.enqueueTagRecompute(binding, {
      reason: `folder_tags_saved:${folderPath}`,
      scope: { kind: "folder", folderPath, mode: "folder_bindings_only" },
    });
    return this.getFolderTagDetails(folderPath);
  }

  requestFullRecompute(): {
    taskId: string;
    deduped: boolean;
    status: "queued";
  } {
    const binding = this.requireCurrentBinding();
    const task = this.enqueueTagRecompute(binding, {
      reason: "manual_tag_recompute",
      scope: { kind: "full" },
    });
    return {
      taskId: task?.taskId ?? "",
      deduped: task?.deduped === true,
      status: "queued",
    };
  }

  getRecomputeTask(): TaskSummary | null {
    const binding = this.bindingStore.read();
    if (!binding || !this.taskManager) {
      return null;
    }
    return this.taskManager.get(
      LIBRARY_TAG_RECOMPUTE_TASK_TYPE,
      binding.rootDir,
    );
  }

  private readCurrentStore(): StoredLibraryTags {
    const binding = this.requireCurrentBinding();
    return this.readStoreForBinding(binding);
  }

  private requireCurrentBinding() {
    const binding = this.bindingStore.read();
    if (!binding) {
      throw new LibraryError(400, "LIBRARY_NOT_BOUND", "请先绑定文档库根目录");
    }
    return binding;
  }

  private readStoreForBinding(binding: {
    libraryId: string;
    rootDir: string;
  }): StoredLibraryTags {
    return this.tagStore.read(binding.libraryId, binding.rootDir);
  }

  private writeCurrentStore(data: StoredLibraryTags): StoredLibraryTags {
    return this.tagStore.write(data);
  }

  private ensureInputTagIds(
    data: StoredLibraryTags,
    input: SaveDocumentTagsInput,
  ): string[] {
    return (input.createTagPaths ?? []).map(
      (tagPath) =>
        this.ensureTagInStore(data, normalizeTagPath(tagPath), null).id,
    );
  }

  private requireTag(
    data: StoredLibraryTags,
    tagId: string,
  ): StoredTagDefinition {
    const normalizedTagId = normalizeRequiredId(tagId, "tagId");
    const tag = data.tags.find((item) => item.id === normalizedTagId);
    if (!tag) {
      throw new LibraryError(
        404,
        "LIBRARY_TAG_NOT_FOUND",
        "标签不存在",
        "tagId",
      );
    }
    return tag;
  }

  private ensureTagInStore(
    data: StoredLibraryTags,
    tagPath: string,
    description: string | null,
  ): StoredTagDefinition {
    if (!tagPath) {
      throw new LibraryError(400, "INVALID_INPUT", "标签路径不能为空", "path");
    }

    const definitionsByPath = new Map(data.tags.map((tag) => [tag.path, tag]));
    const segments = tagPath.split("/");
    let currentPath = "";
    let parentId: string | null = null;
    let parentPath: string | null = null;
    let lastTag: StoredTagDefinition | null = null;
    const now = new Date().toISOString();

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = definitionsByPath.get(currentPath);
      if (existing) {
        if (existing.status === "disabled") {
          existing.status = "active";
          existing.disabledAt = null;
          existing.updatedAt = now;
        }
        parentId = existing.id;
        parentPath = existing.path;
        lastTag = existing;
        continue;
      }

      const tag: StoredTagDefinition = {
        id: `tag_${crypto.randomUUID()}`,
        path: currentPath,
        name: segment,
        rootType: segments[0] ?? segment,
        parentId,
        parentPath,
        description: currentPath === tagPath ? description : null,
        status: "active",
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      };
      data.tags.push(tag);
      definitionsByPath.set(currentPath, tag);
      parentId = tag.id;
      parentPath = tag.path;
      lastTag = tag;
    }

    return lastTag as StoredTagDefinition;
  }

  private toTagDetail(
    tag: StoredTagDefinition,
    data: StoredLibraryTags,
  ): LibraryTagDetailWithRules {
    const node: LibraryTagNodeDetail = {
      ...tag,
      documentCount: countTagDocuments(data, tag.id),
    };
    return {
      ...node,
      smartRules: data.tagRules
        .filter((rule) => rule.tagId === tag.id)
        .sort((left, right) => left.priority - right.priority)
        .map(({ tagId: _tagId, ...rule }) => rule),
      smartRuleEnabled: data.tagRules.some(
        (rule) => rule.tagId === tag.id && rule.enabled,
      ),
    };
  }

  private resolveFolderBindingsForPath(
    data: StoredLibraryTags,
    documentPath: string,
  ) {
    return data.folderTags
      .filter(
        (binding) =>
          documentPath === binding.folderPath ||
          documentPath.startsWith(`${binding.folderPath}/`),
      )
      .flatMap((binding) =>
        binding.bindingTagIds.map((tagId) => {
          const tag = data.tags.find((item) => item.id === tagId);
          return {
            id: folderBindingId(binding.folderPath, tagId),
            folderPath: binding.folderPath,
            tagId,
            tagPath: tag?.path ?? "",
          };
        }),
      );
  }

  private toResolvedTagSource(
    data: StoredLibraryTags,
    tagId: string,
    sourceType: "manual_document" | "folder_binding",
    sourceRef: string,
  ) {
    const tag = data.tags.find((item) => item.id === tagId);
    return {
      path: tag?.path ?? "",
      sourceType,
      sourceRef,
      evidence: null,
      confidence: 1,
      priority: sourceType === "manual_document" ? 100 : 80,
    };
  }

  private syncTagCatalogAndMaybeRecompute(
    binding: LibraryTagRecomputeTaskInput["binding"],
    data: StoredLibraryTags,
    input: { reason: string; scope: RecomputeScope; shouldRecompute: boolean },
  ): void {
    this.syncTagDefinitionsToCatalog(binding.rootDir, data);
    if (input.shouldRecompute) {
      this.enqueueTagRecompute(binding, input);
    }
  }

  private syncTagDefinitionsToCatalog(
    rootDir: string,
    data: StoredLibraryTags,
  ): void {
    withCatalog(rootDir, ({ writer }) => {
      const sortedTags = [...data.tags].sort((left, right) =>
        left.path.localeCompare(right.path, "zh-Hans-CN"),
      );
      for (const tag of sortedTags) {
        writer.saveTagDefinition({
          id: tag.id,
          path: tag.path,
          name: tag.name,
          rootType: tag.rootType,
          parentId: tag.parentId,
          canonicalName: tag.name,
          description: tag.description,
          status: tag.status,
          createdBy: "user",
        });
        writer.replaceTagRules(
          tag.id,
          data.tagRules
            .filter((rule) => rule.tagId === tag.id)
            .map((rule) => ({
              relation: rule.relation,
              ruleType: rule.ruleType,
              matcher: rule.matcher as never,
              enabled: rule.enabled,
              priority: rule.priority,
            })),
        );
      }
    });
  }

  private syncManualDocumentBindingToCatalog(
    rootDir: string,
    data: StoredLibraryTags,
    binding: { documentId: string; path: string; manualTagIds: string[] },
  ): void {
    this.syncTagDefinitionsToCatalog(rootDir, data);
    withCatalog(rootDir, ({ repository, writer }) => {
      const context =
        repository.getDocumentContext(binding.documentId, binding.path) ??
        repository.getDocumentContext(undefined, binding.path);
      if (!context) {
        return;
      }
      writer.replaceManualDocumentTagBindings(
        {
          documentId: context.documentId,
          inodeKey: context.inodeKey,
          contentHash: context.contentHash,
          size: context.size,
          extension: context.extension,
        },
        binding.manualTagIds,
      );
    });
  }

  private syncFolderBindingToCatalog(
    rootDir: string,
    data: StoredLibraryTags,
    folderPath: string,
    tagIds: string[],
  ): void {
    this.syncTagDefinitionsToCatalog(rootDir, data);
    withCatalog(rootDir, ({ writer }) => {
      writer.replaceFolderTagBindings(folderPath, tagIds);
    });
  }

  private enqueueTagRecompute(
    binding: LibraryTagRecomputeTaskInput["binding"],
    input: { reason: string; scope: RecomputeScope },
  ): TaskSummary | null {
    if (!this.taskManager) {
      return null;
    }
    this.registerTasks();
    return this.taskManager.enqueue<
      LibraryTagRecomputeTaskInput,
      LibraryTagRecomputeTaskResult
    >(LIBRARY_TAG_RECOMPUTE_TASK_TYPE, {
      key: binding.rootDir,
      source: "library.tag_service",
      input: {
        binding,
        reason: input.reason,
        scope: input.scope,
      },
    });
  }

  private resolveRecomputeStatus(rootDir: string) {
    const task =
      this.taskManager?.get(LIBRARY_TAG_RECOMPUTE_TASK_TYPE, rootDir) ?? null;
    if (!task) {
      return {
        recomputeState: "idle" as const,
        lastRecomputedAt: null,
        lastError: null,
      };
    }
    return {
      recomputeState:
        task.state === "fresh"
          ? ("idle" as const)
          : task.state === "queued" || task.state === "queue_timeout"
            ? ("queued" as const)
            : task.state === "running"
              ? ("running" as const)
              : ("failed" as const),
      lastRecomputedAt: task.completedAt,
      lastError: task.errorSummary,
    };
  }
}

interface LibraryTagRecomputeTaskInput {
  binding: {
    libraryId: string;
    rootDir: string;
    allowedExtensions?: string[];
    includedHiddenPaths?: string[];
  };
  reason: string;
  scope: RecomputeScope;
}

interface LibraryTagRecomputeTaskResult {
  scannedCount: number;
  updatedCount: number;
  directAssignedCount: number;
  derivedAssignedCount: number;
  exportedAt: string | null;
}

type CatalogHandle = {
  repository: CatalogRepository;
  writer: CatalogWriteRepository;
};

function withCatalog<T>(
  rootDir: string,
  handler: (handle: CatalogHandle) => T,
): T {
  const config = loadRuntimeConfig(rootDir, { args: { rootDir } });
  initCatalog(config);
  return handler({
    repository: new CatalogRepository(config.dbPath),
    writer: new CatalogWriteRepository(config.dbPath),
  });
}

function deleteCatalogTags(rootDir: string, tagIds: string[]): void {
  withCatalog(rootDir, ({ writer }) => {
    writer.deleteTagDefinitions(tagIds);
  });
}

function readCatalogDocumentContext(
  rootDir: string,
  documentId: string,
  filePath: string,
) {
  try {
    return withCatalog(
      rootDir,
      ({ repository }) =>
        repository.getDocumentContext(documentId, filePath) ??
        repository.getDocumentContext(undefined, filePath),
    );
  } catch {
    return null;
  }
}

function readCatalogResolvedTags(rootDir: string, documentId: string) {
  try {
    return withCatalog(rootDir, ({ repository }) =>
      repository
        .listResolvedDocumentTagsByDocumentIds([documentId])
        .map((item) => ({
          path: item.path,
          sourceType: item.sourceType,
          sourceRef: item.sourceRef,
          evidence: item.evidence,
          confidence: item.confidence,
          priority: resolveResolvedTagPriority(item.sourceType),
        })),
    );
  } catch {
    return [];
  }
}

function resolveResolvedTagPriority(sourceType: string): number {
  switch (sourceType) {
    case "manual_document":
      return 100;
    case "folder_binding":
      return 80;
    case "smart_rule":
      return 60;
    case "system_derived":
      return 40;
    default:
      return 0;
  }
}

function mergeResolvedTagSources<
  T extends { path: string; priority: number; confidence: number },
>(items: T[]): T[] {
  const byPath = new Map<string, T>();
  for (const item of items) {
    const current = byPath.get(item.path);
    if (
      !current ||
      item.priority > current.priority ||
      (item.priority === current.priority &&
        item.confidence >= current.confidence)
    ) {
      byPath.set(item.path, item);
    }
  }
  return [...byPath.values()].sort(
    (left, right) =>
      right.priority - left.priority ||
      left.path.localeCompare(right.path, "zh-Hans-CN"),
  );
}

function normalizeTagPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .map(normalizeTagSegment)
    .filter(Boolean)
    .join("/");
}

function normalizeTagSegment(value: string): string {
  return value.trim().replaceAll("/", "");
}

function normalizeFolderPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

function normalizeRequiredId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new LibraryError(400, "INVALID_INPUT", "标签目标不能为空", field);
  }
  return normalized;
}

function normalizeKnownTagIds(
  data: StoredLibraryTags,
  tagIds: string[],
): string[] {
  const knownIds = new Set(data.tags.map((tag) => tag.id));
  return Array.from(
    new Set(
      tagIds
        .map((tagId) => tagId.trim())
        .filter((tagId) => knownIds.has(tagId)),
    ),
  );
}

function countTagDocuments(data: StoredLibraryTags, tagId: string): number {
  const documentCount = data.documentTags.filter((item) =>
    item.manualTagIds.includes(tagId),
  ).length;
  const folderCount = data.folderTags.filter((item) =>
    item.bindingTagIds.includes(tagId),
  ).length;
  return documentCount + folderCount;
}

function folderBindingId(folderPath: string, tagId: string): string {
  return `folder_${crypto.createHash("sha1").update(`${folderPath}:${tagId}`).digest("hex")}`;
}

function buildTagDocumentCountMap(
  data: StoredLibraryTags,
): Map<string, number> {
  const countByPath = new Map<string, number>();
  const tagById = new Map(data.tags.map((tag) => [tag.id, tag]));
  for (const document of data.documentTags) {
    for (const tagId of document.manualTagIds) {
      const tag = tagById.get(tagId);
      if (tag) {
        countByPath.set(tag.path, (countByPath.get(tag.path) ?? 0) + 1);
      }
    }
  }
  for (const folder of data.folderTags) {
    for (const tagId of folder.bindingTagIds) {
      const tag = tagById.get(tagId);
      if (tag) {
        countByPath.set(tag.path, (countByPath.get(tag.path) ?? 0) + 1);
      }
    }
  }
  return countByPath;
}

function replaceTagRules(
  data: StoredLibraryTags,
  tagId: string,
  rules: StoredTagRuleInput[],
): void {
  data.tagRules = data.tagRules.filter((rule) => rule.tagId !== tagId);
  data.tagRules.push(
    ...rules
      .map((rule, index): StoredTagRule => {
        const relation: StoredTagRule["relation"] =
          rule.relation === "or" || rule.relation === "not"
            ? rule.relation
            : "and";
        return {
          id: rule.id?.trim() || `rule_${crypto.randomUUID()}`,
          tagId,
          relation,
          ruleType: rule.ruleType ?? "file_name_contains",
          matcher: rule.matcher ?? {},
          enabled: rule.enabled !== false,
          priority: Number.isFinite(rule.priority)
            ? Number(rule.priority)
            : index,
        };
      })
      .sort((left, right) => left.priority - right.priority),
  );
}

function stableTagRuleId(
  tagId: string,
  priority: number,
  ruleType: StoredTagRule["ruleType"],
  matcher: Record<string, unknown>,
  relation: StoredTagRule["relation"],
): string {
  const matcherJson = JSON.stringify(matcher ?? {});
  const digest = crypto
    .createHash("sha1")
    .update(`${tagId}:${priority}:${ruleType}:${matcherJson}:${relation}`)
    .digest("hex");
  return `tag_rule_${digest}`;
}

function isBusinessTagDefinition(tag: StoredTagDefinition): boolean {
  if (tag.status === "disabled") {
    return false;
  }
  const rootType = tag.rootType.trim().toLowerCase();
  return (
    rootType !== "类型" &&
    rootType !== "type" &&
    rootType !== "时间" &&
    rootType !== "time"
  );
}

function buildRecommendationTargetText(
  targetPath: string,
  title: string,
): string {
  return buildSearchableRecommendationText([
    targetPath,
    path.posix.basename(targetPath),
    title,
    targetPath.split(/[\/._\-\s]+/g).join(" "),
  ]);
}

function normalizeRecommendationText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\\/_\-–—.()[\]{}【】（）]+/g, " ")
    .replace(/\s+/g, " ");
}

function buildSearchableRecommendationText(parts: string[]): string {
  const values = new Set<string>();
  for (const part of parts) {
    const normalized = normalizeRecommendationText(part);
    const compact = compactRecommendationText(part);
    const stripped = stripMeaninglessRecommendationWords(compact);
    if (normalized) {
      values.add(normalized);
    }
    if (compact) {
      values.add(compact);
    }
    if (stripped) {
      values.add(stripped);
    }
  }
  return [...values].join(" ");
}

function scoreTagNameMatch(
  tag: StoredTagDefinition,
  targetText: string,
): number {
  const tokens = splitRecommendationTokens(targetText);
  const tokenSet = new Set(tokens);
  const segments = tag.path
    .split("/")
    .map(normalizeRecommendationText)
    .filter((segment) => isUsefulRecommendationToken(segment));
  const tagName = normalizeRecommendationText(tag.name);
  const tagPath = normalizeRecommendationText(tag.path);
  const tagNameTokens = splitRecommendationTokens(tagName).filter(
    isUsefulRecommendationToken,
  );
  const tagMatchTexts = buildTagMatchTexts(tag);
  let score = 0;

  if (
    tagName &&
    isUsefulRecommendationToken(tagName) &&
    tokenSet.has(tagName)
  ) {
    score = Math.max(score, 90);
  }
  if (
    tagName &&
    isUsefulRecommendationToken(tagName) &&
    tokens.some(
      (token) => token.length > tagName.length && token.includes(tagName),
    )
  ) {
    score = Math.max(score, 86);
  }
  if (tagPath && targetText.includes(tagPath)) {
    score = Math.max(score, 94);
  }

  for (const tagText of tagMatchTexts) {
    const overlapLength = findLongestCommonChineseTextLength(
      tagText,
      targetText,
    );
    if (overlapLength >= MIN_RECOMMENDATION_OVERLAP_LENGTH) {
      score = Math.max(score, scoreTextOverlap(overlapLength, tagText.length));
      continue;
    }
    const bestSimilarity = Math.max(
      0,
      ...tokens.map((token) =>
        similarityRatio(tagText, stripMeaninglessRecommendationWords(token)),
      ),
    );
    if (tagText.length >= 4 && bestSimilarity >= 0.88) {
      score = Math.max(score, 76 + Math.round((bestSimilarity - 0.88) * 70));
    }
  }

  const matchedSegments = segments.filter((segment) => tokenSet.has(segment));
  if (matchedSegments.length >= 2) {
    score = Math.max(score, 84 + matchedSegments.length * 3);
  }

  const matchedNameTokens = tagNameTokens.filter((token) =>
    tokenSet.has(token),
  );
  if (
    tagNameTokens.length >= 2 &&
    matchedNameTokens.length === tagNameTokens.length
  ) {
    score = Math.max(score, 88);
  }

  if (score === 0 && tagName.length >= 3) {
    const bestSimilarity = Math.max(
      0,
      ...tokens.map((token) => similarityRatio(tagName, token)),
    );
    if (bestSimilarity >= 0.86) {
      score = Math.max(score, 78 + Math.round((bestSimilarity - 0.86) * 60));
    }
  }
  return Math.min(score, 94);
}

function buildTagMatchTexts(tag: StoredTagDefinition): string[] {
  const rawNames = [tag.name, path.posix.basename(tag.path)];
  const candidates = new Set<string>();
  for (const rawName of rawNames) {
    const compact = compactRecommendationText(rawName);
    const stripped = stripMeaninglessRecommendationWords(compact);
    for (const candidate of [compact, stripped]) {
      if (isUsefulTagMatchText(candidate)) {
        candidates.add(candidate);
      }
    }
  }
  return [...candidates].sort((left, right) => right.length - left.length);
}

function compactRecommendationText(value: string): string {
  return normalizeRecommendationText(value).replace(/\s+/g, "");
}

function stripMeaninglessRecommendationWords(value: string): string {
  let result = value;
  let changed = true;
  while (changed) {
    changed = false;
    for (const word of MEANINGLESS_RECOMMENDATION_WORDS) {
      if (word && result.includes(word)) {
        result = result.replaceAll(word, "");
        changed = true;
      }
    }
  }
  return result;
}

function isUsefulTagMatchText(value: string): boolean {
  if (value.length < MIN_RECOMMENDATION_OVERLAP_LENGTH) {
    return false;
  }
  if (GENERIC_RECOMMENDATION_TOKENS.has(value)) {
    return false;
  }
  return !MEANINGLESS_RECOMMENDATION_WORDS.includes(value);
}

function findLongestCommonChineseTextLength(
  left: string,
  right: string,
): number {
  const leftText = compactRecommendationText(left);
  const rightText = compactRecommendationText(right);
  const maxLength = Math.min(leftText.length, rightText.length);
  for (
    let length = maxLength;
    length >= MIN_RECOMMENDATION_OVERLAP_LENGTH;
    length -= 1
  ) {
    for (let index = 0; index + length <= leftText.length; index += 1) {
      const fragment = leftText.slice(index, index + length);
      if (isUsefulTagMatchText(fragment) && rightText.includes(fragment)) {
        return length;
      }
    }
  }
  return 0;
}

function scoreTextOverlap(
  overlapLength: number,
  tagTextLength: number,
): number {
  const coverage = tagTextLength > 0 ? overlapLength / tagTextLength : 0;
  if (overlapLength >= 6 || coverage >= 0.72) {
    return 92;
  }
  if (overlapLength >= 4 || coverage >= 0.56) {
    return 86;
  }
  return 80;
}

function splitRecommendationTokens(value: string): string[] {
  return value
    .split(/\s+/g)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isUsefulRecommendationToken(value: string): boolean {
  const token = value.trim().toLowerCase();
  if (token.length < 2) {
    return false;
  }
  return !GENERIC_RECOMMENDATION_TOKENS.has(token);
}

const GENERIC_RECOMMENDATION_TOKENS = new Set([
  "文档",
  "文件",
  "资料",
  "附件",
  "其他",
  "相关",
  "临时",
  "新建",
  "默认",
  "document",
  "documents",
  "file",
  "files",
  "other",
  "misc",
  "temp",
  "有限公司",
  "有限责任公司",
  "股份有限公司",
  "集团有限公司",
  "公司",
  "集团",
]);

const MEANINGLESS_RECOMMENDATION_WORDS = [
  "集团有限公司",
  "股份有限公司",
  "有限责任公司",
  "有限公司",
  "集团公司",
  "总公司",
  "分公司",
  "公司",
  "集团",
  "co.,ltd",
  "coltd",
  "ltd",
  "inc",
  "llc",
  "corp",
  "corporation",
  "company",
  "采购",
  "服务",
  "管理",
  "建设",
];

const MIN_RECOMMENDATION_OVERLAP_LENGTH = 3;

function similarityRatio(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }
  if (left === right) {
    return 1;
  }
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) {
    return 1;
  }
  const distance = levenshteinDistance(left, right);
  return (maxLength - distance) / maxLength;
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  const current = Array.from({ length: right.length + 1 }, () => 0);

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const substitutionCost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + substitutionCost,
      );
    }
    for (let j = 0; j < previous.length; j += 1) {
      previous[j] = current[j]!;
    }
  }

  return previous[right.length] ?? 0;
}

function setTagRecommendation(
  target: Map<string, TagRecommendationResult>,
  tag: StoredTagDefinition,
  input: {
    score: number;
    reason: "name_match" | "folder_context" | "smart_rule" | "time_pattern";
    evidence: string;
  },
): void {
  const current = target.get(tag.id);
  if (current && current.score > input.score) {
    return;
  }
  target.set(tag.id, {
    tagId: tag.id,
    path: tag.path,
    name: tag.name,
    score: input.score,
    reason: input.reason,
    evidence: input.evidence,
  });
}

function scoreFolderContext(
  targetKind: "document" | "folder",
  targetPath: string,
  bindingFolderPath: string,
): number {
  const targetFolderPath =
    targetKind === "document"
      ? normalizeFolderPath(
          targetPath.includes("/") ? path.posix.dirname(targetPath) : ".",
        )
      : normalizeFolderPath(targetPath);
  const bindingPath = normalizeFolderPath(bindingFolderPath);
  if (bindingPath === ".") {
    return 0;
  }
  if (bindingPath === targetFolderPath) {
    return 86;
  }
  if (targetFolderPath.startsWith(`${bindingPath}/`)) {
    return 80;
  }
  const parentPath = normalizeFolderPath(path.posix.dirname(targetFolderPath));
  if (bindingPath === parentPath) {
    return 76;
  }
  if (
    parentPath !== "." &&
    path.posix.dirname(bindingPath) === parentPath &&
    areSiblingFolderNamesRelated(targetFolderPath, bindingPath)
  ) {
    return 72;
  }
  return 0;
}

function areSiblingFolderNamesRelated(
  leftPath: string,
  rightPath: string,
): boolean {
  const leftName = normalizeRecommendationText(path.posix.basename(leftPath));
  const rightName = normalizeRecommendationText(path.posix.basename(rightPath));
  if (!leftName || !rightName) {
    return false;
  }
  const leftTokens = splitRecommendationTokens(leftName).filter(
    isUsefulRecommendationToken,
  );
  const rightTokens = splitRecommendationTokens(rightName).filter(
    isUsefulRecommendationToken,
  );
  if (leftTokens.some((token) => rightTokens.includes(token))) {
    return true;
  }
  return similarityRatio(leftName, rightName) >= 0.82;
}

function matchesRecommendationRule(
  target: {
    kind: "document" | "folder";
    path: string;
    title: string;
    extension?: string;
    modifiedAt?: string;
  },
  rule: StoredTagRule,
): boolean {
  switch (rule.ruleType) {
    case "file_name_contains": {
      const keyword = String(
        (rule.matcher as { keyword?: string }).keyword ?? "",
      )
        .trim()
        .toLowerCase();
      return (
        keyword.length > 0 &&
        path.posix.basename(target.path).toLowerCase().includes(keyword)
      );
    }
    case "file_content_contains": {
      const keyword = String(
        (rule.matcher as { keyword?: string }).keyword ?? "",
      )
        .trim()
        .toLowerCase();
      const text = `${target.title}\n${target.path}`.toLowerCase();
      return keyword.length > 0 && text.includes(keyword);
    }
    case "file_extension_in": {
      if (target.kind !== "document") {
        return false;
      }
      const rawExtensions = Array.isArray(
        (rule.matcher as { extensions?: string[] }).extensions,
      )
        ? ((rule.matcher as { extensions?: string[] }).extensions ?? [])
        : [];
      const extensions = rawExtensions
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
        .map((item) => (item.startsWith(".") ? item : `.${item}`));
      return (
        Boolean(target.extension) &&
        extensions.includes(String(target.extension).toLowerCase())
      );
    }
    case "modified_time_between": {
      if (target.kind !== "document" || !target.modifiedAt) {
        return false;
      }
      const matcher = rule.matcher as {
        start?: string | null;
        end?: string | null;
      };
      const modifiedAt = new Date(target.modifiedAt).getTime();
      if (Number.isNaN(modifiedAt)) {
        return false;
      }
      const startTime = matcher.start
        ? new Date(matcher.start).getTime()
        : null;
      const endTime = matcher.end ? new Date(matcher.end).getTime() : null;
      if (
        startTime !== null &&
        (Number.isNaN(startTime) || modifiedAt < startTime)
      ) {
        return false;
      }
      if (endTime !== null && (Number.isNaN(endTime) || modifiedAt > endTime)) {
        return false;
      }
      return startTime !== null || endTime !== null;
    }
    case "document_path_in_folder": {
      const folderPath = normalizeFolderPath(
        (rule.matcher as { folderPath?: string | null }).folderPath ?? "",
      );
      return matchesPathInFolderScope(target.path, folderPath);
    }
  }
}

function resolveMatchedRecommendationRule(
  target: {
    kind: "document" | "folder";
    path: string;
    title: string;
    extension?: string;
    modifiedAt?: string;
  },
  rules: StoredTagRule[],
): StoredTagRule | null {
  const sortedRules = [...rules].sort(
    (left, right) => left.priority - right.priority,
  );
  const matchedAnd: StoredTagRule[] = [];
  const matchedOr: StoredTagRule[] = [];
  let hasOrRule = false;

  for (const rule of sortedRules) {
    const matched = matchesRecommendationRule(target, rule);
    if (rule.relation === "not") {
      if (matched) {
        return null;
      }
      continue;
    }
    if (rule.relation === "or") {
      hasOrRule = true;
      if (matched) {
        matchedOr.push(rule);
      }
      continue;
    }
    if (!matched) {
      return null;
    }
    matchedAnd.push(rule);
  }

  if (hasOrRule && matchedOr.length === 0) {
    return null;
  }
  return matchedAnd[0] ?? matchedOr[0] ?? null;
}

function resolveRecommendationRuleEvidence(rule: StoredTagRule): string {
  switch (rule.ruleType) {
    case "file_name_contains":
      return `智能规则：文件名包含“${String((rule.matcher as { keyword?: string }).keyword ?? "").trim()}”`;
    case "file_content_contains":
      return `智能规则：标题、路径或内容包含“${String((rule.matcher as { keyword?: string }).keyword ?? "").trim()}”`;
    case "file_extension_in": {
      const extensions = Array.isArray(
        (rule.matcher as { extensions?: string[] }).extensions,
      )
        ? ((rule.matcher as { extensions?: string[] }).extensions ?? [])
        : [];
      return `智能规则：文件类型命中 ${extensions.join("、")}`;
    }
    case "modified_time_between":
      return "智能规则：修改时间命中";
    case "document_path_in_folder": {
      const folderPath = normalizeFolderPath(
        (rule.matcher as { folderPath?: string | null }).folderPath ?? "",
      );
      return folderPath === "."
        ? "智能规则：位于根目录下"
        : `智能规则：位于“${folderPath}”下`;
    }
  }
}

function matchesPathInFolderScope(
  targetPath: string,
  folderPath: string,
): boolean {
  if (folderPath === ".") {
    return true;
  }
  return targetPath === folderPath || targetPath.startsWith(`${folderPath}/`);
}

function scoreRecentModifiedAt(modifiedAt: string): number {
  const time = new Date(modifiedAt).getTime();
  if (Number.isNaN(time)) {
    return 0;
  }
  const dayDistance = Math.floor((Date.now() - time) / 86400000);
  if (dayDistance <= 7) {
    return 54;
  }
  if (dayDistance <= 30) {
    return 44;
  }
  return 0;
}

function isTimeLikeBusinessTag(tag: StoredTagDefinition): boolean {
  const text = `${tag.path}/${tag.name}`.toLowerCase();
  return /最近|近期|本周|本月|待处理|跟进|urgent|recent|week|month|todo|follow/.test(
    text,
  );
}

function buildTagRecommendations(
  data: StoredLibraryTags,
  input: {
    targetKind: "document" | "folder";
    targetPath: string;
    title: string;
    excludedTagIds: string[];
    modifiedAt?: string;
  },
) {
  const excludedTagIds = new Set(input.excludedTagIds);
  const definitions = data.tags.filter(
    (tag) => isBusinessTagDefinition(tag) && !excludedTagIds.has(tag.id),
  );
  if (definitions.length === 0) {
    return [];
  }

  const candidates = new Map<string, TagRecommendationResult>();
  const tagById = new Map(definitions.map((tag) => [tag.id, tag]));
  const countByPath = buildTagDocumentCountMap(data);
  const target = {
    kind: input.targetKind,
    path: input.targetPath,
    title: input.title,
    extension:
      input.targetKind === "document"
        ? path.extname(input.targetPath).toLowerCase()
        : undefined,
    modifiedAt: input.modifiedAt,
  };
  const targetText = buildRecommendationTargetText(target.path, target.title);

  for (const tag of definitions) {
    const score = scoreTagNameMatch(tag, targetText);
    if (score <= 0) {
      continue;
    }
    setTagRecommendation(candidates, tag, {
      score,
      reason: "name_match",
      evidence: "文件夹或文件名称里出现了这个标签的关键词",
    });
  }

  for (const binding of data.folderTags) {
    for (const tagId of binding.bindingTagIds) {
      const tag = tagById.get(tagId);
      if (!tag) {
        continue;
      }
      const relationScore = scoreFolderContext(
        target.kind,
        target.path,
        binding.folderPath,
      );
      if (relationScore <= 0) {
        continue;
      }
      setTagRecommendation(candidates, tag, {
        score: relationScore,
        reason: "folder_context",
        evidence:
          binding.folderPath === "."
            ? "根目录已经配置过这个标签"
            : `相关文件夹“${binding.folderPath}”已经配置过这个标签`,
      });
    }
  }

  const rulesByTagId = new Map<string, StoredTagRule[]>();
  for (const rule of data.tagRules.filter((rule) => rule.enabled)) {
    const rules = rulesByTagId.get(rule.tagId) ?? [];
    rules.push(rule);
    rulesByTagId.set(rule.tagId, rules);
  }
  for (const [tagId, rules] of rulesByTagId) {
    const tag = tagById.get(tagId);
    const matchedRule = tag
      ? resolveMatchedRecommendationRule(target, rules)
      : null;
    if (!tag || !matchedRule) {
      continue;
    }
    setTagRecommendation(candidates, tag, {
      score: 82,
      reason: "smart_rule",
      evidence: resolveRecommendationRuleEvidence(matchedRule),
    });
  }

  if (target.kind === "document" && target.modifiedAt) {
    const timeScore = scoreRecentModifiedAt(target.modifiedAt);
    if (timeScore > 0) {
      for (const tag of definitions) {
        if (!isTimeLikeBusinessTag(tag)) {
          continue;
        }
        setTagRecommendation(candidates, tag, {
          score: timeScore,
          reason: "time_pattern",
          evidence: "最近修改时间和这个标签有关",
        });
      }
    }
  }

  return [...candidates.values()]
    .map((item) => ({
      ...item,
      score: Math.min(
        100,
        item.score +
          Math.min(8, Math.log2((countByPath.get(item.path) ?? 0) + 1) * 1.5),
      ),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.path.localeCompare(right.path, "zh-Hans-CN"),
    )
    .slice(0, 8)
    .map((item) => ({ ...item, score: Number(item.score.toFixed(2)) }));
}

function isDescendantTag(
  tags: StoredTagDefinition[],
  candidateId: string,
  ancestorId: string,
): boolean {
  let current = tags.find((tag) => tag.id === candidateId) ?? null;
  while (current?.parentId) {
    if (current.parentId === ancestorId) {
      return true;
    }
    current = tags.find((tag) => tag.id === current?.parentId) ?? null;
  }
  return false;
}

function collectDescendantTags(
  tags: StoredTagDefinition[],
  ancestorId: string,
): StoredTagDefinition[] {
  const result: StoredTagDefinition[] = [];
  const visit = (parentId: string) => {
    for (const tag of tags.filter((item) => item.parentId === parentId)) {
      result.push(tag);
      visit(tag.id);
    }
  };
  visit(ancestorId);
  return result;
}

function updateDescendantPaths(
  tags: StoredTagDefinition[],
  tagId: string,
  oldPath: string,
  nextPath: string,
): void {
  const descendants = collectDescendantTags(tags, tagId);
  for (const descendant of descendants) {
    if (
      descendant.path === oldPath ||
      descendant.path.startsWith(`${oldPath}/`)
    ) {
      descendant.path = `${nextPath}${descendant.path.slice(oldPath.length)}`;
      descendant.rootType = descendant.path.split("/")[0] ?? descendant.name;
      descendant.updatedAt = new Date().toISOString();
    }
    const parent = tags.find((item) => item.id === descendant.parentId) ?? null;
    descendant.parentPath = parent?.path ?? null;
  }
}
