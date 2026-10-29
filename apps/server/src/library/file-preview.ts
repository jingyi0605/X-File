import path from "node:path";

import type {
  LibraryPreviewCapabilities,
  LibraryPreviewKind
} from "@x-file/shared";
import {
  LIBRARY_PREVIEW_BUDGETS,
  LIBRARY_PREVIEW_CONTENT_TYPES,
  LIBRARY_PREVIEW_FORMATS,
  resolveLibraryPreviewFormat,
} from "@x-file/shared";

export const MAX_TEXT_FILE_BYTES = LIBRARY_PREVIEW_BUDGETS.editMaxBytes;
export const MAX_PREVIEW_FILE_BYTES = LIBRARY_PREVIEW_BUDGETS.textMaxBytes;
export const MAX_RESOURCE_PREVIEW_FILE_BYTES = LIBRARY_PREVIEW_BUDGETS.resourceMaxBytes;

export const RESOURCE_PREVIEW_KINDS = new Set<LibraryPreviewKind>(
  LIBRARY_PREVIEW_FORMATS
    .filter((format) => format.previewable && format.resourceClass === "resource")
    .map((format) => format.previewKind),
);

export const PREVIEW_CONTENT_TYPES = new Map(Object.entries(LIBRARY_PREVIEW_CONTENT_TYPES));

export function detectPreviewKind(filePath: string): LibraryPreviewKind {
  const extension = path.extname(filePath).toLowerCase();
  return resolveLibraryPreviewFormat(filePath)?.previewKind ?? "text";
}

export function isResourcePreviewKind(kind: LibraryPreviewKind): boolean {
  return RESOURCE_PREVIEW_KINDS.has(kind);
}

export function resolvePreviewContentType(filePath: string): string | null {
  return PREVIEW_CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? null;
}

export function buildPreviewCapabilities(
  kind: LibraryPreviewKind,
  options: {
    supported: boolean;
    content: string | null;
    version: string | null;
  }
): LibraryPreviewCapabilities {
  if (!options.supported) {
    return {
      canEdit: false,
      canRefresh: false,
      canResize: false,
      canZoom: false,
      canPaginate: false
    };
  }

  return {
    canEdit: Boolean(
      options.content !== null
      && options.version !== null
      && (kind === "text" || kind === "markdown" || kind === "html")
    ),
    canRefresh: true,
    canResize: true,
    canZoom: kind === "image" || kind === "pdf",
    canPaginate: kind === "pdf"
  };
}
