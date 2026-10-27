import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDefaultLibraryViewState, writeLibraryViewState } from "../library-view-state";
import {
  createDocumentList,
  createDocumentRecord,
  createFileList,
  installLibraryApiMock,
  libraryApiMock,
  resetLibraryApiMock,
} from "./mockLibraryApi";

installLibraryApiMock();

const platformData = {
  runtimePlatform: "web" as const,
  osFamily: "web" as const,
  overlayTitlebar: false,
};

describe.each(["grid", "list"] as const)("%s 视口自动预加载", (viewMode) => {
  const viewportSelector = viewMode === "grid"
    ? ".affairs-doc-grid-scroll"
    : ".affairs-finder-list";
  const spacerSelector = viewMode === "grid"
    ? ".affairs-doc-grid-spacer"
    : ".affairs-finder-spacer";
  const descriptors = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
    libraryApiMock.listLibraryFiles.mockResolvedValue(createFileList());
    for (const libraryId of ["default", "library-test"]) {
      writeLibraryViewState({ ...createDefaultLibraryViewState(libraryId), viewMode });
    }
    for (const [property, value] of [["clientWidth", 300], ["clientHeight", 400]] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, property);
      descriptors.set(property, descriptor);
      Object.defineProperty(HTMLElement.prototype, property, {
        configurable: true,
        get() {
          return this.matches(viewportSelector) ? value : descriptor?.get?.call(this) ?? 0;
        },
      });
    }
  });

  afterEach(() => {
    for (const [property, descriptor] of descriptors) {
      if (descriptor) {
        Object.defineProperty(HTMLElement.prototype, property, descriptor);
      } else {
        delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
      }
    }
    descriptors.clear();
  });

  it("首屏不足时自动补齐预加载区，不渲染加载更多按钮", async () => {
    const documents = buildDocuments(150);
    libraryApiMock.listLibraryDocuments.mockImplementation(async (query) =>
      createDocumentList(
        documents.slice(query.offset, query.offset === 0 ? 5 : query.offset + query.limit),
        { total: documents.length, offset: query.offset },
      ),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 5, limit: 60 }),
      );
      expect(screen.getByText("文档001.md")).toBeInTheDocument();
    });
    await act(async () => {});
    expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledTimes(2);
    expect(document.querySelector(".affairs-doc-grid-loading-overlay")).toBeNull();
    expect(screen.queryByRole("button", { name: "加载更多", hidden: true })).toBeNull();
  });

  it("快速跳滚后串行补齐多页，刷新仍保持滚动位置和总高度", async () => {
    const documents = buildDocuments(300);
    let finishPage!: (page: ReturnType<typeof createDocumentList>) => void;
    libraryApiMock.listLibraryDocuments.mockImplementation((query) => {
      if (query.offset === 60) {
        return new Promise((resolve) => { finishPage = resolve; });
      }
      return Promise.resolve(createDocumentList(
        documents.slice(query.offset, query.offset + query.limit),
        { total: documents.length, offset: query.offset },
      ));
    });

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);
    await screen.findByText("文档001.md");
    const viewport = document.querySelector(viewportSelector) as HTMLDivElement;
    const spacer = document.querySelector(spacerSelector) as HTMLDivElement;
    const initialHeight = spacer.style.height;
    expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledTimes(1);

    act(() => {
      viewport.scrollTop = 6000;
      fireEvent.scroll(viewport);
    });
    await waitFor(() => expect(finishPage).toBeTypeOf("function"));
    act(() => {
      fireEvent.scroll(viewport);
      fireEvent.scroll(viewport);
    });
    await act(async () => {});
    expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledTimes(2);
    expect(viewport.querySelector(".is-placeholder")).not.toBeNull();

    await act(async () => {
      finishPage(createDocumentList(documents.slice(60, 120), {
        total: documents.length,
        offset: 60,
      }));
    });

    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledWith(
        expect.objectContaining({ offset: 120, limit: 60 }),
      );
      expect(viewport.querySelector(".is-placeholder")).toBeNull();
    });
    const offsets = libraryApiMock.listLibraryDocuments.mock.calls.map(([query]) => query.offset);
    expect(new Set(offsets).size).toBe(offsets.length);
    expect(viewport.scrollTop).toBe(6000);
    expect(spacer.style.height).toBe(initialHeight);
    expect(viewport.querySelectorAll(viewMode === "grid" ? ".affairs-doc-item" : ".affairs-finder-row").length)
      .toBeGreaterThan(0);

    const loadedCount = libraryApiMock.listLibraryDocuments.mock.lastCall?.[0].offset + 60;
    fireEvent.click(screen.getByRole("button", { name: "刷新文档库" }));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(
        expect.objectContaining({ offset: 0, limit: loadedCount }),
      );
      expect(document.querySelector(viewportSelector)).toBe(viewport);
      expect(viewport.querySelector(".is-placeholder")).toBeNull();
    });
    expect(viewport.scrollTop).toBe(6000);
    expect(spacer.style.height).toBe(initialHeight);
  });

  it("预加载失败后保留已有内容并停止自动重试", async () => {
    libraryApiMock.listLibraryDocuments
      .mockResolvedValueOnce(createDocumentList(buildDocuments(5), { total: 150 }))
      .mockRejectedValue(new Error("分页请求失败"));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    expect(await screen.findByText("分页请求失败")).toBeInTheDocument();
    expect(screen.getByText("文档001.md")).toBeInTheDocument();
    await act(async () => {
      fireEvent.scroll(document.querySelector(viewportSelector) as HTMLDivElement);
    });
    expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledTimes(2);
  });
});

function buildDocuments(count: number) {
  return Array.from({ length: count }, (_, index) => createDocumentRecord({
    documentId: `doc-${index + 1}`,
    path: `文档${String(index + 1).padStart(3, "0")}.md`,
  }));
}
