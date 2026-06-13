import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createDocumentList,
  createDocumentRecord,
  createFileList,
  createFileNode,
  createLibrarySnapshot,
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

describe("第 7 批：列表/Finder 视图、类型文案、列宽和虚拟滚动", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
  });

  afterEach(() => {
    restoreElementMetrics();
  });

  it("列表模式表头显示文件名、大小、时间、种类，并显示真实文件名", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([
        createDocumentRecord({
          path: "docs/Exchange 分层通讯簿.txt",
          title: "摘要标题不应该出现",
          sizeBytes: 2048,
          createdAt: "2026-06-09T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z",
        }),
      ]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await userEvent.click(await screen.findByRole("button", { name: "列表" }));

    const header = document.querySelector(".affairs-finder-header");
    expect(header).not.toBeNull();
    const headerScope = within(header as HTMLElement);
    expect(headerScope.getByText("名称")).toBeInTheDocument();
    expect(headerScope.getByText("大小")).toBeInTheDocument();
    expect(headerScope.getByText("更新时间")).toBeInTheDocument();
    expect(headerScope.getByText("类型")).toBeInTheDocument();
    expect(headerScope.getByText("创建时间")).toBeInTheDocument();

    const row = await screen.findByRole("button", { name: /Exchange 分层通讯簿\.txt/i });
    expect(within(row).getByText("2.0 KB")).toBeInTheDocument();
    expect(within(row).getByText("文本文档")).toBeInTheDocument();
    const nameCell = row.querySelector(".affairs-finder-name");
    expect(nameCell).toHaveAttribute("title", "Exchange 分层通讯簿.txt");
    expect(nameCell?.textContent?.trim()).toBe("Exchange 分层通讯簿.txt");
    expect(within(row).queryByText("摘要标题不应该出现")).not.toBeInTheDocument();
  });

  it("列表模式文件夹和 html/json/zip/mp4/sql 显示具体类型文案", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        folders: [{ path: "资料夹", name: "资料夹", parentPath: null, directDocumentCount: 0, documentCount: 0 }],
      }),
    );
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "资料夹", name: "资料夹", kind: "directory" })]),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([
        createDocumentRecord({ documentId: "sql", path: "schema.sql" }),
        createDocumentRecord({ documentId: "html", path: "落地页.html" }),
        createDocumentRecord({ documentId: "json", path: "配置.json" }),
        createDocumentRecord({ documentId: "zip", path: "归档资料.zip" }),
        createDocumentRecord({ documentId: "mp4", path: "讲解视频.mp4" }),
      ]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await userEvent.click(await screen.findByRole("button", { name: "列表" }));

    expect(within(await screen.findByRole("button", { name: /资料夹/ })).getByText("文件夹")).toBeInTheDocument();
    expect(within(await screen.findByRole("button", { name: /schema\.sql/ })).getByText("SQL 脚本")).toBeInTheDocument();
    expect(within(await screen.findByRole("button", { name: /落地页\.html/ })).getByText("HTML 文档")).toBeInTheDocument();
    expect(within(await screen.findByRole("button", { name: /配置\.json/ })).getByText("JSON 配置")).toBeInTheDocument();
    expect(within(await screen.findByRole("button", { name: /归档资料\.zip/ })).getByText("压缩归档")).toBeInTheDocument();
    expect(within(await screen.findByRole("button", { name: /讲解视频\.mp4/ })).getByText("视频文件")).toBeInTheDocument();
  });

  it("列表模式列宽支持拖拽调整并同步到行", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ path: "docs/a.md" })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await userEvent.click(await screen.findByRole("button", { name: "列表" }));

    const header = document.querySelector(".affairs-finder-header") as HTMLElement;
    expect(header.style.gridTemplateColumns).toContain("320px");
    const resizer = header.querySelector(".affairs-finder-column-resizer") as HTMLElement;

    fireEvent.pointerDown(resizer, { clientX: 320, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 420 });
    fireEvent.pointerUp(window, { clientX: 420 });

    const row = await screen.findByRole("button", { name: /a\.md/ });
    await waitFor(() => {
      expect(header.style.gridTemplateColumns).toContain("420px");
      expect((row as HTMLButtonElement).style.gridTemplateColumns).toContain("420px");
    });
  });

  it("列表视图滚动后继续显示后面的文件夹记录", async () => {
    mockFinderViewportMetrics();
    const folders = Array.from({ length: 140 }, (_, index) =>
      createFileNode({
        path: `文件夹${String(index + 1).padStart(3, "0")}`,
        name: `文件夹${String(index + 1).padStart(3, "0")}`,
        kind: "directory",
      }),
    );
    libraryApiMock.listLibraryFiles.mockResolvedValue(createFileList(folders));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await userEvent.click(await screen.findByRole("button", { name: "列表" }));

    const viewport = await findFinderViewport();
    act(() => {
      viewport.scrollTop = 4200;
      fireEvent.scroll(viewport);
    });

    expect(await screen.findByRole("button", { name: /文件夹110/ })).toBeInTheDocument();
  });

  it("网格视图虚拟滚动高度按总条数估算", async () => {
    mockGridViewportMetrics();
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList(
        Array.from({ length: 120 }, (_, index) =>
          createDocumentRecord({
            documentId: `doc-${index + 1}`,
            path: `文档${String(index + 1).padStart(3, "0")}.txt`,
          }),
        ),
        { total: 240 },
      ),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await waitFor(() => {
      const spacer = document.querySelector(".affairs-doc-grid-spacer") as HTMLDivElement | null;
      expect(spacer).not.toBeNull();
      expect(Number.parseInt(spacer?.style.height ?? "0", 10)).toBeGreaterThan(120 * 100);
    });
  });

  it("列表视图优先使用后端 visibleEntryTotal 估算高度，并用 top 定位虚拟内容", async () => {
    mockFinderViewportMetrics();
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList(
        [
          createDocumentRecord({ documentId: "doc-1", path: "说明1.md" }),
          createDocumentRecord({ documentId: "doc-2", path: "说明2.md" }),
        ],
        { total: 2, visibleEntryTotal: 4 },
      ),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await userEvent.click(await screen.findByRole("button", { name: "列表" }));

    await waitFor(() => {
      const spacer = document.querySelector(".affairs-finder-spacer") as HTMLDivElement | null;
      expect(spacer).not.toBeNull();
      expect(spacer?.style.height).toBe("160px");
      const virtual = document.querySelector(".affairs-finder-virtual") as HTMLDivElement | null;
      expect(virtual?.style.top).toBe("0px");
      expect(virtual?.style.transform).toBe("");
    });
  });

  it("列表视图接近已加载尾部时按总条数提前继续加载", async () => {
    mockFinderViewportMetrics();
    libraryApiMock.listLibraryDocuments
      .mockResolvedValueOnce(
        createDocumentList(
          Array.from({ length: 60 }, (_, index) =>
            createDocumentRecord({
              documentId: `doc-${index + 1}`,
              path: `文档${String(index + 1).padStart(3, "0")}.txt`,
            }),
          ),
          { total: 120 },
        ),
      )
      .mockResolvedValueOnce(
        createDocumentList(
          Array.from({ length: 60 }, (_, index) =>
            createDocumentRecord({
              documentId: `doc-${index + 61}`,
              path: `文档${String(index + 61).padStart(3, "0")}.txt`,
            }),
          ),
          { total: 120, offset: 60 },
        ),
      );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await userEvent.click(await screen.findByRole("button", { name: "列表" }));

    const viewport = await findFinderViewport();
    act(() => {
      viewport.scrollTop = 1920;
      fireEvent.scroll(viewport);
    });

    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledWith(expect.objectContaining({
        offset: 60,
        limit: 60,
      }));
    });
  });

  it("列表视图点击表头可以切换排序", async () => {
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([
        createFileNode({ path: "B项目", name: "B项目", kind: "directory" }),
        createFileNode({ path: "A项目", name: "A项目", kind: "directory" }),
      ]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await userEvent.click(await screen.findByRole("button", { name: "列表" }));

    await waitFor(() => {
      const rows = document.querySelectorAll(".affairs-finder-row");
      expect(rows[0]).toHaveTextContent("B项目");
    });

    await userEvent.click(screen.getByRole("button", { name: /按名称排序/ }));

    await waitFor(() => {
      const rows = document.querySelectorAll(".affairs-finder-row");
      expect(rows[0]).toHaveTextContent("A项目");
    });
  });

  it("网格模式会给 html/json/zip/mp4 文件显示对应徽标和色调", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([
        createDocumentRecord({ documentId: "html", path: "落地页.html" }),
        createDocumentRecord({ documentId: "json", path: "配置.json" }),
        createDocumentRecord({ documentId: "zip", path: "归档资料.zip" }),
        createDocumentRecord({ documentId: "mp4", path: "讲解视频.mp4" }),
      ]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    const htmlCard = await screen.findByRole("button", { name: /落地页\.html/ });
    expect(within(htmlCard).getByText("HTML")).toBeInTheDocument();
    expect(htmlCard.querySelector(".affairs-document-sheet")).toHaveClass("tone-cyan");

    const jsonCard = await screen.findByRole("button", { name: /配置\.json/ });
    expect(within(jsonCard).getByText("JSON")).toBeInTheDocument();
    expect(jsonCard.querySelector(".affairs-document-sheet")).toHaveClass("tone-cyan");

    const zipCard = await screen.findByRole("button", { name: /归档资料\.zip/ });
    expect(within(zipCard).getByText("ZIP")).toBeInTheDocument();
    expect(zipCard.querySelector(".affairs-document-sheet")).toHaveClass("tone-amber");

    const videoCard = await screen.findByRole("button", { name: /讲解视频\.mp4/ });
    expect(within(videoCard).getByText("VIDEO")).toBeInTheDocument();
    expect(videoCard.querySelector(".affairs-document-sheet")).toHaveClass("tone-teal");
  });
});

const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();

function mockFinderViewportMetrics(): void {
  rememberDescriptor("clientHeight");
  rememberDescriptor("scrollHeight");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if (this.classList?.contains("affairs-finder-list")) return 400;
      return originalDescriptors.get("clientHeight")?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (this.classList?.contains("affairs-finder-list")) return 50000;
      return originalDescriptors.get("scrollHeight")?.get?.call(this) ?? 0;
    },
  });
}

function mockGridViewportMetrics(): void {
  rememberDescriptor("clientWidth");
  rememberDescriptor("clientHeight");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      if (this.classList?.contains("affairs-doc-grid-scroll")) return 300;
      return originalDescriptors.get("clientWidth")?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if (this.classList?.contains("affairs-doc-grid-scroll")) return 400;
      return originalDescriptors.get("clientHeight")?.get?.call(this) ?? 0;
    },
  });
}

function rememberDescriptor(name: string): void {
  if (!originalDescriptors.has(name)) {
    originalDescriptors.set(name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name));
  }
}

function restoreElementMetrics(): void {
  for (const [name, descriptor] of originalDescriptors.entries()) {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, name, descriptor);
    } else {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
    }
  }
  originalDescriptors.clear();
}

async function findFinderViewport(): Promise<HTMLDivElement> {
  return waitFor(() => {
    const viewport = document.querySelector(".affairs-finder-list");
    if (!(viewport instanceof HTMLDivElement)) {
      throw new Error("未找到 Finder 列表视口");
    }
    return viewport;
  });
}
