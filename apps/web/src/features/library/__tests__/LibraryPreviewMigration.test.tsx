import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryPreview } from "@x-file/shared";

import {
  createDocumentList,
  createDocumentRecord,
  createFileList,
  createFileNode,
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

describe("第 1 批：文档预览、编辑写回、Office 阅读视图与目录详情", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
  });

  it("双击文档会复用文件预览工具，并走文档库默认预览接口", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-preview", path: "docs/预览.md" })]),
    );
    libraryApiMock.getLibraryPreview.mockResolvedValue(createPreview({
      path: "docs/预览.md",
      kind: "markdown",
      content: "# 预览",
      version: "v1",
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    fireEvent.doubleClick(await screen.findByRole("button", { name: /预览\.md/ }));

    expect(await screen.findByRole("dialog", { name: "预览.md" })).toBeInTheDocument();
    await waitFor(() => {
      expect(libraryApiMock.getLibraryPreview).toHaveBeenCalledWith("docs/预览.md");
    });
  });

  it("文档预览编辑后会走文档库写回接口保存", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-edit", path: "docs/编辑.md" })]),
    );
    libraryApiMock.getLibraryPreview
      .mockResolvedValueOnce(createPreview({
        path: "docs/编辑.md",
        kind: "markdown",
        content: "旧内容",
        version: "v1",
      }))
      .mockResolvedValue(createPreview({
        path: "docs/编辑.md",
        kind: "markdown",
        content: "新内容",
        version: "v2",
      }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    fireEvent.doubleClick(await screen.findByRole("button", { name: /编辑\.md/ }));
    await userEvent.click(await screen.findByRole("button", { name: "编辑" }));
    await userEvent.clear(await screen.findByTestId("file-viewer-editor"));
    await userEvent.type(screen.getByTestId("file-viewer-editor"), "新内容");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => {
      expect(libraryApiMock.operateLibraryFile).toHaveBeenCalledWith({
        opType: "write",
        srcPath: "docs/编辑.md",
        content: "新内容",
        expectedVersion: "v1",
      });
    });
  });

  it("目录详情标题居中显示，并复用和文档详情一致的摘要折叠逻辑", async () => {
    const longDirectorySummary =
      "目录摘要来自导出快照，可展开查看完整路径、索引状态、文件数量、最近更新时间和后续同步状态。" +
      "这里故意写成长摘要，用来确认目录详情复用文档详情的折叠和展开逻辑。" +
      "当摘要超过折叠阈值时，详情区应该先显示精简内容，用户点击展开全文后才能看到完整目录说明。" +
      "这段补充内容用于避免测试误把短摘要场景当成长摘要场景。";

    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" })]),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([], {
        directoryStatus: {
          path: "客户资料",
          state: "fresh",
          source: "snapshot",
          lastRequestedAt: null,
          lastCompletedAt: "2026-06-10T00:00:00.000Z",
          lastFailedAt: null,
          runningTaskId: null,
          errorSummary: null,
          generatedAt: "2026-06-10T00:00:00.000Z",
          filesystemObservedAt: "2026-06-10T00:00:00.000Z",
          staleReason: longDirectorySummary,
        },
      }),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await userEvent.click(await screen.findByRole("button", { name: /客户资料/ }));

    expect(await screen.findByRole("heading", { name: "客户资料" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开全文" }));
    expect(screen.getByRole("button", { name: "收起全文" })).toBeInTheDocument();
  });

  it("右侧对象详情栏底部的 Office 预览走阅读视图，不影响双击正式预览", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-office", path: "docs/合同.docx" })]),
    );
    libraryApiMock.getLibraryPreview.mockResolvedValue(createPreview({
      path: "docs/合同.docx",
      kind: "office",
      content: null,
      version: "office-v1",
      onlyOffice: {
        apiScriptUrl: "https://office.example/api.js",
        editorMode: "view",
        documentUrl: "https://office.example/reading",
        callbackUrl: "https://office.example/callback",
        editorConfig: {},
      },
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await userEvent.click(await screen.findByRole("button", { name: /合同\.docx/ }));
    await waitFor(() => {
      expect(libraryApiMock.getLibraryPreview).toHaveBeenCalledWith("docs/合同.docx", "reading");
    });

    libraryApiMock.getLibraryPreview.mockClear();
    fireEvent.doubleClick(screen.getByRole("button", { name: /合同\.docx/ }));
    await screen.findByRole("dialog", { name: "合同.docx" });
    await waitFor(() => {
      expect(libraryApiMock.getLibraryPreview).toHaveBeenCalledWith("docs/合同.docx");
    });
  });

  it("右侧对象详情栏会把 Markdown 按富文本渲染，而不是退回纯文本 pre", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-markdown", path: "docs/说明.md" })]),
    );
    libraryApiMock.getLibraryPreview.mockResolvedValue(createPreview({
      path: "docs/说明.md",
      kind: "markdown",
      content: "# 一级标题\n\n```ts\nconst value = 1;\n```",
      version: "md-v1",
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await userEvent.click(await screen.findByRole("button", { name: /说明\.md/ }));

    expect(await screen.findByRole("heading", { name: "一级标题" })).toBeInTheDocument();
    expect(screen.getByText("TypeScript")).toBeInTheDocument();
    expect(document.querySelector(".affairs-preview-block pre.preview-box.text.compact")).toBeNull();
  });
});

function createPreview(overrides: Partial<LibraryPreview> = {}): LibraryPreview {
  return {
    libraryId: "library-test",
    path: "docs/预览.md",
    supported: true,
    kind: "markdown",
    reason: null,
    content: "内容",
    version: "v1",
    size: 12,
    updatedAt: "2026-06-10T00:00:00.000Z",
    previewPath: null,
    previewUrl: null,
    onlyOffice: null,
    capabilities: {
      canEdit: true,
      canRefresh: true,
      canResize: true,
      canZoom: false,
      canPaginate: false,
    },
    ...overrides,
  };
}
