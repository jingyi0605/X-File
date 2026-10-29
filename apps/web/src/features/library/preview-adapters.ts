import type { LibraryPreview } from "@x-file/shared";

import { readPreviewResource } from "./preview-resource-controller";

export interface PreviewSource {
  path: string;
  previewUrl: string | null;
  revision: string;
  content: string;
}

export interface PreviewLimits {
  maxBytes: number;
  timeoutMs?: number;
}

export interface PreviewAdapterContext {
  signal: AbortSignal;
  limits: PreviewLimits;
}

export interface PreviewAdapterResult<Model> {
  model: Model;
  quality: "ready" | "partial";
  warnings: string[];
  dispose: () => void;
}

export interface PreviewAdapter<Model> {
  id: string;
  family: string;
  load: (
    source: PreviewSource,
    context: PreviewAdapterContext,
  ) => Promise<PreviewAdapterResult<Model>>;
}

export interface ResourcePreviewModel {
  bytes: Uint8Array;
}

export interface InlinePreviewModel {
  content: string;
}

export type PreviewModel = ResourcePreviewModel | InlinePreviewModel;

export function createPreviewSource(preview: LibraryPreview): PreviewSource {
  return {
    path: preview.path,
    previewUrl: preview.previewUrl,
    revision: `${preview.size}:${preview.updatedAt ?? ""}`,
    content: preview.content ?? "",
  };
}

export function createInlineAdapter(id: string, family: string): PreviewAdapter<InlinePreviewModel> {
  return {
    id,
    family,
    async load(source) {
      let disposed = false;
      return {
        model: { content: source.content },
        quality: "ready",
        warnings: [],
        dispose: () => {
          if (disposed) return;
          disposed = true;
        },
      };
    },
  };
}

export function createResourceAdapter(
  id: string,
  family: string,
): PreviewAdapter<ResourcePreviewModel> {
  return {
    id,
    family,
    async load(source, context) {
      const bytes = await readPreviewResource({
        path: source.path,
        previewUrl: source.previewUrl,
        revision: source.revision,
        maxBytes: context.limits.maxBytes,
        timeoutMs: context.limits.timeoutMs,
        signal: context.signal,
      });
      let disposed = false;
      return {
        model: { bytes },
        quality: "ready",
        warnings: [],
        dispose: () => {
          if (disposed) return;
          disposed = true;
          bytes.fill(0);
        },
      };
    },
  };
}

export const IMAGE_PREVIEW_ADAPTER = createResourceAdapter("image-bytes", "image");
export const PDF_PREVIEW_ADAPTER = createResourceAdapter("pdf-bytes", "pdf");
export const OFFICE_DOCUMENT_PREVIEW_ADAPTER = createResourceAdapter("office-document-bytes", "office-document");
export const SPREADSHEET_PREVIEW_ADAPTER = createResourceAdapter("spreadsheet-bytes", "spreadsheet");
