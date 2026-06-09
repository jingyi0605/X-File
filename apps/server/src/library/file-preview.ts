import path from "node:path";

import type {
  LibraryPreviewCapabilities,
  LibraryPreviewKind
} from "@x-file/shared";

export const MAX_TEXT_FILE_BYTES = 256 * 1024;
export const MAX_PREVIEW_FILE_BYTES = 512 * 1024;
export const MAX_RESOURCE_PREVIEW_FILE_BYTES = 20 * 1024 * 1024;

const MARKDOWN_FILE_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const HTML_FILE_EXTENSIONS = new Set([".html", ".htm"]);
const IMAGE_FILE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico"
]);
const PDF_FILE_EXTENSIONS = new Set([".pdf"]);
const OFFICE_FILE_EXTENSIONS = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);

export const RESOURCE_PREVIEW_KINDS = new Set<LibraryPreviewKind>(["html", "image", "pdf", "office"]);

export const PREVIEW_CONTENT_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".htm", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".cjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".bmp", "image/bmp"],
  [".pdf", "application/pdf"],
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".eot", "application/vnd.ms-fontobject"]
]);

export function detectPreviewKind(filePath: string): LibraryPreviewKind {
  const extension = path.extname(filePath).toLowerCase();

  if (MARKDOWN_FILE_EXTENSIONS.has(extension)) {
    return "markdown";
  }

  if (HTML_FILE_EXTENSIONS.has(extension)) {
    return "html";
  }

  if (IMAGE_FILE_EXTENSIONS.has(extension)) {
    return "image";
  }

  if (PDF_FILE_EXTENSIONS.has(extension)) {
    return "pdf";
  }

  if (OFFICE_FILE_EXTENSIONS.has(extension)) {
    return "office";
  }

  return "text";
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
