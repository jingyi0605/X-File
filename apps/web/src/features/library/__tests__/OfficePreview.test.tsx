import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as XLSX from "@e965/xlsx";
import { zipSync, strToU8 } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OfficePreview } from "../OfficePreview";
import { LibraryPdfPreview } from "../LibraryPdfPreview";
import { initializeRuntimeConfig } from "../../../runtime/runtime-config-store";

const { invokeMock, pptxRenderMock, docxRenderMock, pdfRenderMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  pptxRenderMock: { renderList: vi.fn(), destroy: vi.fn() },
  docxRenderMock: vi.fn(),
  pdfRenderMock: { render: vi.fn(), getPage: vi.fn(), destroy: vi.fn() },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("docx-preview", () => ({
  renderAsync: (...args: unknown[]) => {
    docxRenderMock(...args);
    const body = args[1] as HTMLElement;
    const heading = document.createElement("h1");
    heading.textContent = "Quarterly report";
    body.appendChild(heading);
    const paragraph = document.createElement("p");
    paragraph.textContent = "Readable paragraph";
    body.appendChild(paragraph);
    const table = document.createElement("table");
    const cell = document.createElement("td");
    cell.textContent = "North";
    table.appendChild(cell);
    body.appendChild(table);
    return Promise.resolve();
  },
}));
vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: vi.fn(() => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: (pageNumber: number) => {
        pdfRenderMock.getPage(pageNumber);
        return Promise.resolve({
          getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
          render: (...args: unknown[]) => {
            pdfRenderMock.render(...args);
            return { promise: Promise.resolve(), cancel: vi.fn() };
          },
        });
      },
    }),
    destroy: pdfRenderMock.destroy,
  })),
}));
vi.mock("@aiden0z/pptx-renderer", () => ({
  PptxViewer: class {
    constructor(container: HTMLElement) {
      const slide = document.createElement("div");
      slide.dataset.slideIndex = "0";
      slide.textContent = "Rendered slide canvas";
      container.appendChild(slide);
    }
    load() {}
    renderList(options: unknown) {
      pptxRenderMock.renderList(options);
      return Promise.resolve();
    }
    destroy() {
      pptxRenderMock.destroy();
    }
  },
  buildPresentation: vi.fn(() => ({ slides: [{}] })),
  parseZipLazyMedia: vi.fn(async () => ({ slides: new Map([["slide1.xml", ""]]) })),
  RECOMMENDED_ZIP_LIMITS: { maxConcurrency: 8 },
}));

function createXlsxFixture(): Uint8Array {
  const summary = XLSX.utils.aoa_to_sheet([["Title", "Total"], ["FY 2026", 420]]);
  summary.B2.z = "$#,##0.00";
  summary.B3 = { t: "n", f: "SUM(B2:B2)", v: 420 };
  summary["!ref"] = "A1:B3";
  const details = XLSX.utils.aoa_to_sheet([["Revenue"]]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, summary, "Summary");
  XLSX.utils.book_append_sheet(workbook, details, "Details");
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
}

function createDocxFixture(): Uint8Array {
  return zipSync({
    "word/document.xml": strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p><w:p><w:r><w:t>Readable paragraph</w:t></w:r></w:p><w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>List entry</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>',
    ),
  });
}

function createPptxFixture(): Uint8Array {
  return zipSync({
    "ppt/presentation.xml": strToU8(
      '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="1" r:id="rId1"/><p:sldId id="2" r:id="rId2"/></p:sldIdLst></p:presentation>',
    ),
    "ppt/_rels/presentation.xml.rels": strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
    ),
    "ppt/slides/slide1.xml": strToU8(
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Launch plan</a:t></a:r></a:p><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Milestone one</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    ),
    "ppt/slides/slide2.xml": strToU8(
      '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Next steps</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    ),
  });
}

describe("OfficePreview", () => {
  beforeEach(() => {
    localStorage.removeItem("x-file.runtime.config");
    initializeRuntimeConfig();
    invokeMock.mockReset().mockResolvedValue(undefined);
    pptxRenderMock.renderList.mockReset();
    pptxRenderMock.destroy.mockReset();
    docxRenderMock.mockReset();
    pdfRenderMock.render.mockReset();
    pdfRenderMock.getPage.mockReset();
    pdfRenderMock.destroy.mockReset();
    vi.stubGlobal("fetch", vi.fn());
    delete (window as typeof window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows bounded XLSX sheets and their values", async () => {
    const response = new Response(Uint8Array.from(createXlsxFixture()).buffer as ArrayBuffer, { status: 200 });
    vi.mocked(fetch).mockResolvedValue(response);

    render(<OfficePreview fileName="forecast.xlsx" relativePath="forecast.xlsx" previewUrl="/forecast.xlsx" localFilePath={null} size={1024} />);

    expect(await screen.findByRole("cell", { name: "FY 2026" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "$420.00" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /3/ }).querySelector("th[scope='row']")).toHaveTextContent("3");
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(await screen.findByRole("cell", { name: "Revenue" })).toBeInTheDocument();
  });

  it("uses the page-layout DOCX renderer for headings, paragraphs, and tables", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(Uint8Array.from(createDocxFixture()).buffer as ArrayBuffer));
    render(<OfficePreview fileName="report.docx" relativePath="report.docx" previewUrl="/report.docx" localFilePath={null} size={1024} />);

    expect(await screen.findByRole("heading", { name: "Quarterly report" })).toBeInTheDocument();
    expect(screen.getByText("Readable paragraph")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "North" })).toBeInTheDocument();
    expect(docxRenderMock).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      expect.any(HTMLElement),
      expect.any(HTMLElement),
      expect.objectContaining({ breakPages: true, renderAltChunks: false }),
    );
  });

  it("renders PDF pages locally with PDF.js and supports page navigation", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(Uint8Array.from([37, 80, 68, 70]).buffer as ArrayBuffer));
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const { unmount } = render(<LibraryPdfPreview path="manual.pdf" previewUrl="/manual.pdf" />);

    expect(await screen.findByLabelText("manual.pdf, 1")).toBeInTheDocument();
    await waitFor(() => expect(pdfRenderMock.render).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(pdfRenderMock.render).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText("manual.pdf, 2")).toBeInTheDocument();
    unmount();
    getContext.mockRestore();
  });

  it("reads native PDF bytes through the restricted preview-resource command", async () => {
    (window as typeof window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    invokeMock.mockResolvedValue("JVBERi0x");
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      setTransform: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    const { unmount } = render(<LibraryPdfPreview path="manual.pdf" previewUrl={null} />);

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("native_read_preview_resource", { path: "manual.pdf" }));
    await waitFor(() => expect(pdfRenderMock.render).toHaveBeenCalled());
    unmount();
    getContext.mockRestore();
  });

  it("uses the full-slide PPTX renderer instead of flattening slides into text", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(Uint8Array.from(createPptxFixture()).buffer as ArrayBuffer));
    render(<OfficePreview fileName="plan.pptx" relativePath="plan.pptx" previewUrl="/plan.pptx" localFilePath={null} size={1024} />);

    expect(await screen.findByText("Rendered slide canvas")).toBeInTheDocument();
    expect(document.querySelector(".office-preview-pptx-engine [data-slide-index]")).toBeInTheDocument();
    expect(pptxRenderMock.renderList).toHaveBeenCalledWith(
      expect.objectContaining({ windowed: true, initialSlides: 3 }),
    );
  });

  it("opens the original file through the desktop command", async () => {
    (window as typeof window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    vi.mocked(fetch).mockResolvedValue(new Response(Uint8Array.from(createXlsxFixture()).buffer as ArrayBuffer, { status: 200 }));
    const { container } = render(
      <OfficePreview fileName="forecast.xlsx" relativePath="forecast.xlsx" previewUrl="/forecast.xlsx" localFilePath="/Library/forecast.xlsx" size={12} />,
    );

    await screen.findByRole("cell", { name: "FY 2026" });
    fireEvent.click(screen.getByRole("button", { name: "本地打开" }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("open_path", { path: "/Library/forecast.xlsx" }));
    expect(container.querySelector(".office-preview-shell")).toBeInTheDocument();
  });

  it("does not offer local-app opening without a local file path", async () => {
    (window as typeof window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    vi.mocked(fetch).mockResolvedValue(new Response(Uint8Array.from(createXlsxFixture()).buffer as ArrayBuffer, { status: 200 }));
    render(<OfficePreview fileName="remote.xlsx" relativePath="remote.xlsx" previewUrl="/remote.xlsx" localFilePath={null} size={12} />);

    await screen.findByRole("cell", { name: "FY 2026" });
    expect(screen.queryByRole("button", { name: "本地打开" })).not.toBeInTheDocument();
  });

  it("shows a local-open fallback when the preview resource fails", async () => {
    (window as typeof window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    vi.mocked(fetch).mockResolvedValue(new Response("", { status: 404 }));
    render(<OfficePreview fileName="broken.docx" relativePath="broken.docx" previewUrl="/broken.docx" localFilePath="/Library/broken.docx" size={12} />);

    expect(await screen.findByText("无法读取 Office 文件资源。")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "本地打开" }).length).toBeGreaterThan(0);
  });
});
