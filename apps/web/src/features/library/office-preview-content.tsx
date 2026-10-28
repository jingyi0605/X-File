import { useEffect, useRef, useState } from "react";
import { unzipSync } from "fflate";
import { t } from "../../i18n";
import { readNativePreviewResource } from "../../runtime/native-library-bridge";
import { getRuntimeConfigSnapshot } from "../../runtime/runtime-config-store";

const MAX_COMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_UNCOMPRESSED_BYTES = 48 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4000;
const MAX_SLIDES = 500;
const MAX_SHEETS = 32;
const MAX_ROWS = 200;
const MAX_COLUMNS = 40;

type OfficeContent =
  | { kind: "docx"; bytes: Uint8Array }
  | { kind: "xlsx"; sheets: XlsxSheet[] }
  | { kind: "pptx"; bytes: Uint8Array };

interface XlsxSheet {
  name: string;
  rows: string[][];
  firstRow: number;
  firstColumn: number;
}

interface PptxPresentationViewProps {
  bytes: Uint8Array;
  onError: (message: string) => void;
}

export default function OfficePreviewContent({
  fileName,
  previewUrl,
  relativePath,
  onError,
}: {
  fileName: string;
  previewUrl: string;
  relativePath: string;
  onError: (message: string) => void;
}) {
  const [content, setContent] = useState<OfficeContent | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setContent(null);
    setActiveSheet(0);
    void fetchOfficeContent(fileName, previewUrl, relativePath)
      .then((nextContent) => {
        if (!cancelled) {
          setContent(nextContent);
          setLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoading(false);
          onError(toOfficeError(error));
        }
      });
    return () => { cancelled = true; };
  }, [fileName, previewUrl, relativePath]);

  if (loading) return <div className="office-preview-state" role="status">{t("fileViewerOfficeLoading")}</div>;
  if (!content) return null;
  if (content.kind === "docx") return <DocxDocument bytes={content.bytes} onError={onError} />;
  if (content.kind === "xlsx") {
    const sheet = content.sheets[activeSheet];
    return (
      <div className="office-preview-workbook">
        <div className="office-preview-sheet-tabs" role="tablist" aria-label={t("fileViewerOfficeSheetLabel")}>
          {content.sheets.map((item, index) => (
            <button
              key={`${item.name}-${index}`}
              type="button"
              role="tab"
              aria-selected={index === activeSheet}
              className="office-preview-sheet-tab"
              onClick={() => setActiveSheet(index)}
            >
              {item.name}
            </button>
          ))}
        </div>
        {sheet ? <SpreadsheetGrid sheet={sheet} /> : null}
      </div>
    );
  }
  return <PptxPresentationView bytes={content.bytes} onError={onError} />;
}

async function fetchOfficeContent(fileName: string, previewUrl: string, relativePath: string): Promise<OfficeContent> {
  let bytes: Uint8Array;
  if (previewUrl) {
    const response = await fetch(previewUrl);
    if (!response.ok) throw new Error("resource");
    const declaredSize = Number(response.headers.get("content-length"));
    if (declaredSize > MAX_COMPRESSED_BYTES) throw new Error("size");
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    if (getRuntimeConfigSnapshot().config.mode !== "local") throw new Error("resource");
    const nativeBytes = await readNativePreviewResource(relativePath);
    if (!nativeBytes) throw new Error("resource");
    bytes = nativeBytes;
  }
  if (bytes.byteLength > MAX_COMPRESSED_BYTES) throw new Error("size");
  const extension = fileName.split(".").pop()?.toLowerCase();
  if (extension === "pptx") return { kind: "pptx", bytes };

  let entryCount = 0;
  let uncompressedBytes = 0;
  const archive = unzipSync(bytes, {
    filter: (entry) => {
      entryCount += 1;
      uncompressedBytes += entry.originalSize;
      return entryCount <= MAX_ARCHIVE_ENTRIES
        && entry.originalSize <= MAX_UNCOMPRESSED_BYTES
        && uncompressedBytes <= MAX_UNCOMPRESSED_BYTES;
    },
  });
  const entries = Object.entries(archive);
  if (entryCount > MAX_ARCHIVE_ENTRIES
    || uncompressedBytes > MAX_UNCOMPRESSED_BYTES
    || entries.some(([, value]) => value.byteLength > MAX_UNCOMPRESSED_BYTES)) {
    throw new Error("size");
  }

  if (extension === "docx") {
    if (!archive["word/document.xml"]) throw new Error("format");
    return { kind: "docx", bytes };
  }
  if (extension === "xlsx") return parseXlsx(bytes);
  throw new Error("format");
}

async function parseXlsx(bytes: Uint8Array): Promise<OfficeContent> {
  const { read, utils } = await import("@e965/xlsx");
  const workbook = read(bytes, { type: "array", cellDates: true, cellFormula: false });
  const sheets = workbook.SheetNames.slice(0, MAX_SHEETS).map((name) => {
    const worksheet = workbook.Sheets[name];
    const reference = worksheet?.["!ref"];
    if (!worksheet || !reference) return { name, rows: [], firstRow: 0, firstColumn: 0 };

    const range = utils.decode_range(reference);
    const firstRow = range.s.r;
    const firstColumn = range.s.c;
    if (firstColumn >= MAX_COLUMNS) return { name, rows: [], firstRow, firstColumn };
    const boundedRange = {
      s: { r: firstRow, c: firstColumn },
      e: {
        r: Math.min(range.e.r, firstRow + MAX_ROWS - 1),
        c: Math.min(range.e.c, MAX_COLUMNS - 1),
      },
    };
    const values = utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      range: boundedRange,
      raw: false,
      defval: "",
      blankrows: true,
    });
    const rows = values.map((row) => row.slice(0, MAX_COLUMNS).map((value) => value == null ? "" : String(value)));
    return { name, rows, firstRow, firstColumn };
  });
  if (!sheets.length) throw new Error("format");
  return { kind: "xlsx", sheets };
}

function PptxPresentationView({ bytes, onError }: PptxPresentationViewProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const host = document.createElement("div");
    host.className = "office-preview-pptx-engine";
    mount.appendChild(host);

    let viewer: { destroy: () => void } | null = null;
    let cancelled = false;
    setLoading(true);
    setError(false);

    void import("@aiden0z/pptx-renderer").then(async ({
      buildPresentation,
      parseZipLazyMedia,
      PptxViewer,
      RECOMMENDED_ZIP_LIMITS,
    }) => {
      const zipLimits = {
        maxEntries: MAX_ARCHIVE_ENTRIES,
        maxEntryUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
        maxTotalUncompressedBytes: MAX_UNCOMPRESSED_BYTES,
        maxMediaBytes: MAX_UNCOMPRESSED_BYTES,
        maxConcurrency: RECOMMENDED_ZIP_LIMITS.maxConcurrency,
      };
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const files = await parseZipLazyMedia(buffer, zipLimits);
      if (files.slides.size > MAX_SLIDES) throw new Error("slide-limit");
      const presentation = buildPresentation(files, { lazySlides: true });
      const instance = new PptxViewer(host, {
        fitMode: "contain",
        externalMedia: "block",
        zipLimits,
        lazySlides: true,
        lazyMedia: true,
        scrollContainer: mount,
      });
      instance.load(presentation);
      await instance.renderList({
        windowed: true,
        initialSlides: 3,
        batchSize: 4,
        showSlideLabels: false,
      });
      if (cancelled) instance.destroy();
      else {
        viewer = instance;
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setLoading(false);
        setError(true);
        onError(t("fileViewerOfficeUnavailable"));
      }
    });

    return () => {
      cancelled = true;
      viewer?.destroy();
      host.remove();
    };
  }, [bytes, onError]);

  if (error) {
    return (
      <div className="office-preview-state office-preview-error" role="status">
        <p>{t("fileViewerOfficeUnavailable")}</p>
      </div>
    );
  }
  return (
    <div ref={mountRef} className="office-preview-pptx-mount">
      {loading ? <div className="office-preview-pptx-loading" role="status">{t("fileViewerOfficeLoading")}</div> : null}
    </div>
  );
}

function SpreadsheetGrid({ sheet }: { sheet: XlsxSheet }) {
  return (
    <div className="office-preview-grid-scroll">
      <table className="office-preview-grid">
        <thead>
          <tr>
            <th scope="col" />
            {sheet.rows[0]?.map((_, columnIndex) => (
              <th scope="col" key={columnIndex}>{columnName(sheet.firstColumn + columnIndex)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <th scope="row">{sheet.firstRow + rowIndex + 1}</th>
              {row.map((cell, cellIndex) => cell || row.some((item) => Boolean(item)) ? (
                <td key={cellIndex}>{cell}</td>
              ) : null)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function columnName(index: number): string {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function DocxDocument({ bytes, onError }: { bytes: Uint8Array; onError: (message: string) => void }) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const body = bodyRef.current;
    const styles = styleRef.current;
    if (!body || !styles) return;
    let cancelled = false;
    setLoading(true);
    void import("docx-preview").then(({ renderAsync }) => renderAsync(bytes, body, styles, {
      className: "xfile-docx",
      inWrapper: true,
      breakPages: true,
      renderAltChunks: false,
      renderComments: false,
    })).then(() => {
      if (!cancelled) setLoading(false);
    }).catch(() => {
      if (!cancelled) onError(t("fileViewerOfficeUnavailable"));
    });
    return () => {
      cancelled = true;
      body.replaceChildren();
      styles.replaceChildren();
    };
  }, [bytes, onError]);

  return (
    <div className="office-preview-document">
      {loading ? <div className="office-preview-pptx-loading" role="status">{t("fileViewerOfficeLoading")}</div> : null}
      <div ref={styleRef} className="office-preview-docx-styles" />
      <div ref={bodyRef} className="office-preview-docx-body" />
    </div>
  );
}

function toOfficeError(error: unknown): string {
  if (error instanceof Error && error.message === "size") return "This file is too large to preview safely.";
  if (error instanceof Error && error.message === "resource") return t("fileViewerOfficeResourceUnavailable");
  return t("fileViewerOfficeUnavailable");
}
