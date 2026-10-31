import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  LIBRARY_PREVIEW_BUDGETS,
  resolveLibraryPreviewFormat,
  type LibraryPreview,
} from "@x-file/shared";

import { t } from "../../i18n";
import { getHttpAuthSessionToken } from "../../api/http-auth-session";
import { resolveApiUrl } from "../../api/http";
import { CodePreview, MarkdownPreview, detectLanguage } from "./LibraryFileCodeViewer";
import { LibraryPdfPreview } from "./LibraryPdfPreview";
import { OfficePreview } from "./OfficePreview";
import {
  IMAGE_PREVIEW_ADAPTER,
  OFFICE_DOCUMENT_PREVIEW_ADAPTER,
  PDF_PREVIEW_ADAPTER,
  SPREADSHEET_PREVIEW_ADAPTER,
  createInlineAdapter,
  createPreviewSource,
  type PreviewAdapter,
  type PreviewModel,
} from "./preview-adapters";

const DelimitedTextPreview = lazy(() => import("./office-preview-content").then(({ DelimitedTextPreview: Preview }) => ({ default: Preview })));

export type LibraryPreviewLayout = "viewer" | "detail" | "standalone";

export interface LibraryPreviewRendererProps {
  preview: LibraryPreview;
  content: string;
  layout: LibraryPreviewLayout;
  localFilePath?: string | null;
  compact?: boolean;
  resourceBytes?: Uint8Array;
  resourceLoadError?: boolean;
}

type PreviewRendererComponent = ComponentType<LibraryPreviewRendererProps>;

interface PreviewRegistryEntry {
  renderer: PreviewRendererComponent;
  adapter: PreviewAdapter<PreviewModel>;
  maxBytes?: number;
}

const RENDERER_REGISTRY: Readonly<Record<string, PreviewRegistryEntry>> = {
  "text-code": { renderer: TextCodeRenderer, adapter: createInlineAdapter("text-code-model", "text-code") },
  markdown: { renderer: MarkdownRenderer, adapter: createInlineAdapter("markdown-model", "markdown") },
  html: { renderer: HtmlRenderer, adapter: createInlineAdapter("html-model", "html") },
  image: { renderer: ImageRenderer, adapter: IMAGE_PREVIEW_ADAPTER, maxBytes: LIBRARY_PREVIEW_BUDGETS.resourceMaxBytes },
  pdf: { renderer: PdfRenderer, adapter: PDF_PREVIEW_ADAPTER, maxBytes: LIBRARY_PREVIEW_BUDGETS.resourceMaxBytes },
  "office-document": { renderer: OfficeRenderer, adapter: OFFICE_DOCUMENT_PREVIEW_ADAPTER, maxBytes: LIBRARY_PREVIEW_BUDGETS.resourceMaxBytes },
  spreadsheet: { renderer: OfficeRenderer, adapter: SPREADSHEET_PREVIEW_ADAPTER, maxBytes: LIBRARY_PREVIEW_BUDGETS.resourceMaxBytes },
  "delimited-text": { renderer: DelimitedTextRenderer, adapter: createInlineAdapter("delimited-text-model", "delimited-text") },
};

export function resolvePreviewRendererFamily(filePath: string): string | null {
  const format = resolveLibraryPreviewFormat(filePath);
  return format?.previewable ? format.adapterFamily : null;
}

export function LibraryPreviewRenderer(props: LibraryPreviewRendererProps) {
  const { preview, content, compact = false } = props;
  const format = resolveLibraryPreviewFormat(preview.path);
  const adapterFamily = format?.previewable
    ? format.adapterFamily
    : preview.kind === "text"
      ? "text-code"
      : null;
  if (!preview.supported || !adapterFamily) {
    return (
      <div className={resolveStateClass(props.layout)} role="status">
        {preview.reason || t("libraryPreviewUnsupported")}
      </div>
    );
  }

  if (compact && (adapterFamily === "markdown" || adapterFamily === "text-code")) {
    return <pre className="preview-box text compact">{limitCompactText(content || t("libraryPreviewEmpty"))}</pre>;
  }

  const entry = RENDERER_REGISTRY[adapterFamily] ?? RENDERER_REGISTRY["text-code"];
  return <ResourceAdapterRenderer entry={entry} {...props} />;
}

function ResourceAdapterRenderer({
  entry,
  ...props
}: LibraryPreviewRendererProps & { entry: PreviewRegistryEntry }) {
  const [result, setResult] = useState<PreviewAdapterResultState | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setResult(null);
    setError(false);
    void entry.adapter.load({ ...createPreviewSource(props.preview), content: props.content }, {
      signal: controller.signal,
      limits: { maxBytes: entry.maxBytes ?? 20 * 1024 * 1024 },
    }).then((nextResult) => {
      if (!active) {
        nextResult.dispose();
        return;
      }
      setResult(nextResult);
    }).catch(() => {
      if (active && !controller.signal.aborted) setError(true);
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [entry, props.preview.path, props.preview.previewUrl, props.preview.size, props.preview.updatedAt]);

  useEffect(() => () => {
    result?.dispose();
  }, [result]);

  if (error && (entry.adapter.family === "office-document" || entry.adapter.family === "spreadsheet")) {
    const Renderer = entry.renderer;
    return <Renderer {...props} resourceLoadError />;
  }
  if (error) {
    return <div className={resolveStateClass(props.layout)} role="status">{t("fileViewerOfficeResourceUnavailable")}</div>;
  }
  if (!result) {
    return <div className={resolveStateClass(props.layout)} role="status">{t("fileViewerOfficeLoading")}</div>;
  }
  const Renderer = entry.renderer;
  const resourceBytes = "bytes" in result.model ? result.model.bytes : undefined;
  const content = "content" in result.model ? result.model.content : props.content;
  return <Renderer {...props} content={content} resourceBytes={resourceBytes} />;
}

interface PreviewAdapterResultState {
  model: PreviewModel;
  dispose: () => void;
}

function resolveStateClass(layout: LibraryPreviewLayout): string {
  return layout === "detail" ? "preview-box" : "office-preview-state";
}

function RendererFrame({ children, layout, className = "" }: {
  children: ReactNode;
  layout: LibraryPreviewLayout;
  className?: string;
}) {
  const layoutClass = layout === "detail"
    ? "library-detail-preview-shell"
    : layout === "standalone"
      ? "library-detached-preview-content"
      : "";
  return <div className={[layoutClass, className].filter(Boolean).join(" ")}>{children}</div>;
}

function TextCodeRenderer({ preview, content, layout }: LibraryPreviewRendererProps) {
  return (
    <RendererFrame layout={layout} className="library-detail-text-preview-shell">
      <CodePreview
        content={content || t("libraryPreviewEmpty")}
        language={detectLanguage(preview.path)}
        overviewTotalLines={Math.max(1, content.split(/\r?\n/).length)}
      />
    </RendererFrame>
  );
}

function MarkdownRenderer({ content, layout }: LibraryPreviewRendererProps) {
  return (
    <RendererFrame layout={layout} className="library-detail-text-preview-shell">
      <MarkdownPreview content={content || t("libraryPreviewEmpty")} />
    </RendererFrame>
  );
}

function HtmlRenderer({ preview, content, layout }: LibraryPreviewRendererProps) {
  const resolvedPreviewUrl = preview.previewUrl && /^https?:/i.test(preview.previewUrl)
    ? preview.previewUrl
    : null;
  const requiresAuthenticatedDocument = Boolean(
    resolvedPreviewUrl
    && getHttpAuthSessionToken(resolveApiUrl(resolvedPreviewUrl)),
  );
  const httpPreviewUrl = requiresAuthenticatedDocument ? null : resolvedPreviewUrl;
  return (
    <RendererFrame layout={layout} className="file-viewer-html-frame-shell">
      <iframe
        className="library-file-viewer-frame file-viewer-html-frame"
        src={httpPreviewUrl ?? undefined}
        srcDoc={httpPreviewUrl ? undefined : content}
        title={preview.path}
        sandbox=""
        referrerPolicy="no-referrer"
      />
    </RendererFrame>
  );
}

function ImageRenderer({ preview, layout, resourceBytes }: LibraryPreviewRendererProps & { resourceBytes?: Uint8Array }) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    setObjectUrl(null);
    if (!resourceBytes) return;
    const arrayBuffer = resourceBytes.buffer.slice(resourceBytes.byteOffset, resourceBytes.byteOffset + resourceBytes.byteLength) as ArrayBuffer;
    const nextObjectUrl = URL.createObjectURL(new Blob([arrayBuffer]));
    setObjectUrl(nextObjectUrl);
    return () => {
      URL.revokeObjectURL(nextObjectUrl);
    };
  }, [resourceBytes]);

  if (!objectUrl) return <div className={resolveStateClass(layout)} role="status">{t("fileViewerOfficeLoading")}</div>;
  return (
    <RendererFrame layout={layout} className={layout === "viewer" ? "library-file-viewer-image-wrap file-viewer-media-shell" : "file-viewer-media-shell"}>
      <div className="file-viewer-image-stage">
        <img className="library-file-viewer-image file-viewer-image" src={objectUrl} alt={preview.path} />
      </div>
    </RendererFrame>
  );
}

function PdfRenderer({ preview, layout, resourceBytes }: LibraryPreviewRendererProps & { resourceBytes?: Uint8Array }) {
  return (
    <RendererFrame layout={layout} className="file-viewer-pdf-shell">
      <LibraryPdfPreview
        path={preview.path}
        previewUrl={preview.previewUrl}
        revision={`${preview.size}:${preview.updatedAt ?? ""}`}
        bytes={resourceBytes}
      />
    </RendererFrame>
  );
}

function OfficeRenderer({ preview, localFilePath, layout, resourceBytes, resourceLoadError }: LibraryPreviewRendererProps & { resourceBytes?: Uint8Array }) {
  const className = layout === "detail"
    ? "library-detail-preview-shell"
    : layout === "standalone"
      ? "office-preview-renderer library-detached-preview-content"
      : "office-preview-renderer file-viewer-office-preview";

  return (
    <OfficePreview
      fileName={preview.path.split(/[\\/]/).pop() ?? preview.path}
      relativePath={preview.path}
      previewUrl={resourceLoadError ? null : preview.previewUrl}
      localFilePath={localFilePath ?? null}
      size={preview.size}
      revision={`${preview.size}:${preview.updatedAt ?? ""}`}
      resourceBytes={resourceBytes}
      hideToolbar={layout === "detail" || layout === "viewer"}
      readOnlyPreview={layout === "detail"}
      className={className}
    />
  );
}

function DelimitedTextRenderer({ preview, content, layout }: LibraryPreviewRendererProps) {
  const delimiter = preview.path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
  return (
    <RendererFrame layout={layout} className="library-detail-text-preview-shell">
      <Suspense fallback={<div className="office-preview-state" role="status">{t("fileViewerOfficeLoading")}</div>}>
        <DelimitedTextPreview
          content={content || t("libraryPreviewEmpty")}
          delimiter={delimiter}
          readOnlyPreview={layout === "detail"}
        />
      </Suspense>
    </RendererFrame>
  );
}

function limitCompactText(content: string): string {
  const maxCharacters = 24_000;
  const maxLines = 240;
  const limited = content.slice(0, maxCharacters);
  const lines = limited.split(/\r?\n/, maxLines + 1);
  const truncated = content.length > limited.length || lines.length > maxLines;
  return truncated ? `${lines.slice(0, maxLines).join("\n")}\n\n...` : limited;
}
