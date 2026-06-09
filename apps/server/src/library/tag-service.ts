import crypto from "node:crypto";
import path from "node:path";

import type {
  LibraryDocumentTagDetails,
  LibraryFolderTagDetails,
  LibraryTagDetailWithRules,
  LibraryTagNodeDetail
} from "@x-file/shared";

import { LibraryError } from "./library-errors.js";
import type { LibraryBindingStore } from "../storage/library-binding-store.js";
import type { StoredLibraryTags, StoredTagDefinition, TagStore } from "../storage/tag-store.js";

export interface ListTagsInput {
  includeDisabled?: boolean;
}

export interface CreateTagInput {
  name?: string;
  parentId?: string | null;
  description?: string | null;
}

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
    private readonly tagStore: TagStore
  ) {}

  listTags(input: ListTagsInput = {}) {
    const data = this.readCurrentStore();
    const items = data.tags
      .filter((tag) => input.includeDisabled === true || tag.status === "active")
      .map((tag) => this.toTagDetail(tag, data));

    return {
      items,
      summary: {
        totalActiveTags: data.tags.filter((tag) => tag.status === "active").length,
        totalDisabledTags: data.tags.filter((tag) => tag.status === "disabled").length,
        totalRuleEnabledTags: 0,
        totalBoundDocuments: data.documentTags.filter((item) => item.manualTagIds.length > 0).length
      },
      status: {
        recomputeState: "idle" as const,
        lastRecomputedAt: null,
        lastError: null
      }
    };
  }

  createTag(input: CreateTagInput): LibraryTagDetailWithRules {
    const name = normalizeTagSegment(input.name ?? "");
    if (!name) {
      throw new LibraryError(400, "INVALID_INPUT", "标签名称不能为空", "name");
    }

    const data = this.readCurrentStore();
    const parent = input.parentId ? data.tags.find((tag) => tag.id === input.parentId) ?? null : null;
    if (input.parentId && !parent) {
      throw new LibraryError(404, "INVALID_INPUT", "父标签不存在", "parentId");
    }

    const tagPath = parent ? `${parent.path}/${name}` : name;
    const tag = this.ensureTagInStore(data, tagPath, input.description ?? null);
    this.writeCurrentStore(data);
    return this.toTagDetail(tag, data);
  }

  ensureTag(input: EnsureTagInput): LibraryTagDetailWithRules {
    const data = this.readCurrentStore();
    const tag = this.ensureTagInStore(data, normalizeTagPath(input.path ?? ""), null);
    this.writeCurrentStore(data);
    return this.toTagDetail(tag, data);
  }

  getDocumentTagDetails(documentId: string): LibraryDocumentTagDetails {
    const data = this.readCurrentStore();
    const normalizedDocumentId = normalizeRequiredId(documentId, "documentId");
    const binding = data.documentTags.find((item) => item.documentId === normalizedDocumentId);
    const documentPath = binding?.path ?? normalizedDocumentId;

    return {
      documentId: normalizedDocumentId,
      path: documentPath,
      title: path.basename(documentPath) || documentPath,
      manualTagIds: binding?.manualTagIds ?? [],
      effectiveFolderBindings: this.resolveFolderBindingsForPath(data, documentPath),
      resolvedTags: [
        ...(binding?.manualTagIds ?? []).map((tagId) => this.toResolvedTagSource(data, tagId, "manual_document", normalizedDocumentId)),
        ...this.resolveFolderBindingsForPath(data, documentPath).map((item) => this.toResolvedTagSource(data, item.tagId, "folder_binding", item.id))
      ].filter((item) => item.path.length > 0),
      recommendedTags: []
    };
  }

  saveDocumentTags(documentId: string, input: SaveDocumentTagsInput): LibraryDocumentTagDetails {
    const data = this.readCurrentStore();
    const normalizedDocumentId = normalizeRequiredId(documentId, "documentId");
    const createdTagIds = this.ensureInputTagIds(data, input);
    const manualTagIds = normalizeKnownTagIds(data, [...(input.tagIds ?? []), ...createdTagIds]);
    const existing = data.documentTags.find((item) => item.documentId === normalizedDocumentId);
    const next = {
      documentId: normalizedDocumentId,
      path: existing?.path ?? normalizedDocumentId,
      title: existing?.title ?? (path.basename(normalizedDocumentId) || normalizedDocumentId),
      manualTagIds,
      updatedAt: new Date().toISOString()
    };

    data.documentTags = [
      ...data.documentTags.filter((item) => item.documentId !== normalizedDocumentId),
      next
    ];
    this.writeCurrentStore(data);
    return this.getDocumentTagDetails(normalizedDocumentId);
  }

  getFolderTagDetails(folderPath: string): LibraryFolderTagDetails {
    const data = this.readCurrentStore();
    const normalizedFolderPath = normalizeFolderPath(folderPath);
    const binding = data.folderTags.find((item) => item.folderPath === normalizedFolderPath);
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
          applyMode: "recursive"
        };
      }),
      recommendedTags: []
    };
  }

  saveFolderTags(input: SaveFolderTagsInput): LibraryFolderTagDetails {
    const data = this.readCurrentStore();
    const folderPath = normalizeFolderPath(input.folderPath ?? "");
    const createdTagIds = this.ensureInputTagIds(data, input);
    const bindingTagIds = normalizeKnownTagIds(data, [...(input.tagIds ?? []), ...createdTagIds]);

    data.folderTags = [
      ...data.folderTags.filter((item) => item.folderPath !== folderPath),
      {
        folderPath,
        bindingTagIds,
        updatedAt: new Date().toISOString()
      }
    ];
    this.writeCurrentStore(data);
    return this.getFolderTagDetails(folderPath);
  }

  private readCurrentStore(): StoredLibraryTags {
    const binding = this.bindingStore.read();
    if (!binding) {
      throw new LibraryError(400, "LIBRARY_NOT_BOUND", "请先绑定文档库根目录");
    }

    return this.tagStore.read(binding.libraryId, binding.rootDir);
  }

  private writeCurrentStore(data: StoredLibraryTags): StoredLibraryTags {
    return this.tagStore.write(data);
  }

  private ensureInputTagIds(data: StoredLibraryTags, input: SaveDocumentTagsInput): string[] {
    return (input.createTagPaths ?? []).map((tagPath) => this.ensureTagInStore(data, normalizeTagPath(tagPath), null).id);
  }

  private ensureTagInStore(data: StoredLibraryTags, tagPath: string, description: string | null): StoredTagDefinition {
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
        disabledAt: null
      };
      data.tags.push(tag);
      definitionsByPath.set(currentPath, tag);
      parentId = tag.id;
      parentPath = tag.path;
      lastTag = tag;
    }

    return lastTag as StoredTagDefinition;
  }

  private toTagDetail(tag: StoredTagDefinition, data: StoredLibraryTags): LibraryTagDetailWithRules {
    const node: LibraryTagNodeDetail = {
      ...tag,
      documentCount: countTagDocuments(data, tag.id)
    };
    return {
      ...node,
      smartRules: [],
      smartRuleEnabled: false
    };
  }

  private resolveFolderBindingsForPath(data: StoredLibraryTags, documentPath: string) {
    return data.folderTags
      .filter((binding) => documentPath === binding.folderPath || documentPath.startsWith(`${binding.folderPath}/`))
      .flatMap((binding) => binding.bindingTagIds.map((tagId) => {
        const tag = data.tags.find((item) => item.id === tagId);
        return {
          id: folderBindingId(binding.folderPath, tagId),
          folderPath: binding.folderPath,
          tagId,
          tagPath: tag?.path ?? ""
        };
      }));
  }

  private toResolvedTagSource(
    data: StoredLibraryTags,
    tagId: string,
    sourceType: "manual_document" | "folder_binding",
    sourceRef: string
  ) {
    const tag = data.tags.find((item) => item.id === tagId);
    return {
      path: tag?.path ?? "",
      sourceType,
      sourceRef,
      evidence: null,
      confidence: 1,
      priority: sourceType === "manual_document" ? 100 : 80
    };
  }
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

function normalizeKnownTagIds(data: StoredLibraryTags, tagIds: string[]): string[] {
  const knownIds = new Set(data.tags.map((tag) => tag.id));
  return Array.from(new Set(tagIds.map((tagId) => tagId.trim()).filter((tagId) => knownIds.has(tagId))));
}

function countTagDocuments(data: StoredLibraryTags, tagId: string): number {
  const documentCount = data.documentTags.filter((item) => item.manualTagIds.includes(tagId)).length;
  const folderCount = data.folderTags.filter((item) => item.bindingTagIds.includes(tagId)).length;
  return documentCount + folderCount;
}

function folderBindingId(folderPath: string, tagId: string): string {
  return `folder_${crypto.createHash("sha1").update(`${folderPath}:${tagId}`).digest("hex")}`;
}
