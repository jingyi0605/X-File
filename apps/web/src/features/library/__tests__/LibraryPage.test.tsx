import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import type { ReactElement } from "react";
import type { LibraryState } from "../useLibraryState";

import {
  createDocumentList,
  createDocumentRecord,
  createFileList,
  createFileNode,
  createIndexStatus,
  createLibraryBinding,
  createLibrarySnapshot,
  createTagDetail,
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

describe("LibraryPage 高风险交互", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
  });

  it("初始化页默认使用后端给出的用户主目录 X-File，并提示用户可改成常用文件路径", async () => {
    const defaultRootDir = "/Users/test/X-File";
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        binding: null,
        defaultRootDir,
        requiresInitialization: true,
      }),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    expect(await screen.findByDisplayValue(defaultRootDir)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`默认资料库根目录是 ${defaultRootDir.replaceAll("/", "\\/")}`))).toBeInTheDocument();
  });

  it("文档名称显示真实文件名，而不是摘要标题", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([
        createDocumentRecord({
          path: "reports/2026真实文件名.pdf",
          title: "AI 生成的摘要标题",
        }),
      ]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    expect(await screen.findByText("2026真实文件名.pdf")).toBeInTheDocument();
    expect(screen.queryByText("AI 生成的摘要标题")).not.toBeInTheDocument();
  });

  it("标签筛选后 snapshot.status.lastCompletedAt 变化不触发当前列表重拉", async () => {
    const firstSnapshot = createLibrarySnapshot({
      status: createIndexStatus({ lastCompletedAt: "2026-06-09T00:00:00.000Z" }),
      tags: [
        { path: "类型", name: "类型", rootType: "类型", parentPath: null, depth: 0, documentCount: 1 },
        { path: "类型/报告", name: "报告", rootType: "类型", parentPath: "类型", depth: 1, documentCount: 1 },
      ],
    });
    const secondSnapshot = createLibrarySnapshot({
      status: createIndexStatus({ lastCompletedAt: "2026-06-09T01:00:00.000Z" }),
      tags: firstSnapshot.tags,
    });
    libraryApiMock.getLibrarySnapshot
      .mockResolvedValueOnce(firstSnapshot)
      .mockResolvedValueOnce(secondSnapshot);
    libraryApiMock.listLibraryTags.mockResolvedValue(firstSnapshot.tags);
    libraryApiMock.listLibraryDocuments.mockResolvedValue(createDocumentList([]));

    const { useLibraryState } = await import("../useLibraryState");
    function LibraryStateProbe(): ReactElement {
      const library = useLibraryState();
      useEffect(() => {
        if (library.tags.length > 0 && library.viewState.selectedTagPaths.length === 0) {
          library.selectTag("类型/报告");
        }
      }, [library]);
      return (
        <button type="button" onClick={() => void library.reload()}>
          重载快照
        </button>
      );
    }

    render(<LibraryStateProbe />);
    await waitFor(() => expect(libraryApiMock.listLibraryDocuments.mock.calls.length).toBeGreaterThanOrEqual(2));
    libraryApiMock.listLibraryDocuments.mockClear();

    await act(async () => {
      await screen.getByRole("button", { name: "重载快照" }).click();
    });

    await waitFor(() => expect(libraryApiMock.getLibrarySnapshot).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(libraryApiMock.listLibraryDocuments).not.toHaveBeenCalled();
  });

  it("文件夹默认双击进入；单击只选中；配置 single_click 后单击进入", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        binding: createLibraryBinding({ folderOpenBehavior: "double_click" }),
        folders: [{ path: "客户资料", name: "客户资料", parentPath: null, directDocumentCount: 0, documentCount: 0 }],
      }),
    );
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    const { unmount } = render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    const folder = await screen.findByRole("button", { name: /客户资料/ });
    await userEvent.click(folder);
    await waitFor(() => {
      expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith(null, 200);
    });

    fireEvent.doubleClick(folder);
    await waitFor(() => {
      expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料", 200);
    });
    unmount();

    resetLibraryApiMock();
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        binding: createLibraryBinding({ folderOpenBehavior: "single_click" }),
        folders: [{ path: "客户资料", name: "客户资料", parentPath: null, directDocumentCount: 0, documentCount: 0 }],
      }),
    );
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" })]),
    );

    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);
    await userEvent.click(await screen.findByRole("button", { name: /客户资料/ }));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料", 200);
    });
  });

  it("右键删除先出现确认弹窗，不直接调用删除 API", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ path: "docs/待删除.md" })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    const item = await screen.findByRole("button", { name: /待删除\.md/ });
    fireEvent.contextMenu(item, { clientX: 10, clientY: 10 });
    await userEvent.click(await screen.findByRole("menuitem", { name: "删除" }));

    expect(await screen.findByRole("heading", { name: "删除项目" })).toBeInTheDocument();
    expect(libraryApiMock.operateLibraryFile).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(libraryApiMock.operateLibraryFile).not.toHaveBeenCalled();
  });

  it("推荐标签最多显示 8 个，并排除已分配标签", async () => {
    const assignedTag = createTagDetail({ id: "tag-assigned", path: "项目/已分配", rootType: "项目" });
    const assignableTags = Array.from({ length: 10 }, (_, index) =>
      createTagDetail({ id: `tag-${index + 1}`, path: `项目/推荐${index + 1}`, rootType: "项目" }),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-tag", path: "docs/标签测试.md" })]),
    );
    libraryApiMock.getDocumentTagDetails.mockResolvedValue({
      documentId: "doc-tag",
      path: "docs/标签测试.md",
      title: "标签测试",
      manualTagIds: [assignedTag.id],
      effectiveFolderBindings: [],
      resolvedTags: [{
        path: assignedTag.path,
        sourceType: "manual",
        sourceRef: assignedTag.id,
        evidence: null,
        confidence: 1,
        priority: 0,
      }],
      recommendedTags: [assignedTag, ...assignableTags].map((tag, index) => ({
        tagId: tag.id,
        path: tag.path,
        name: tag.name,
        reason: "name_match",
        score: 100 - index,
        evidence: `证据 ${index + 1}`,
      })),
    });
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([assignedTag, ...assignableTags]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    const item = await screen.findByRole("button", { name: /标签测试\.md/ });
    fireEvent.contextMenu(item, { clientX: 10, clientY: 10 });
    await userEvent.click(await screen.findByRole("menuitem", { name: "标签" }));

    const recommendations = await screen.findByLabelText("推荐标签");
    const buttons = within(recommendations).getAllByRole("button", { name: /分配推荐标签/ });
    expect(buttons).toHaveLength(8);
    expect(within(recommendations).queryByText("项目/已分配")).not.toBeInTheDocument();
  });
});

function createLibraryStateMock(
  folderOpenBehavior: "single_click" | "double_click",
): LibraryState & {
  selectFolder: ReturnType<typeof vi.fn>;
  selectFolderEntry: ReturnType<typeof vi.fn>;
} {
  return {
    viewState: {
      libraryId: "library-test",
      browseMode: "folder",
      viewMode: "grid",
      selectedFolderPath: null,
      selectedFolderEntryPath: null,
      selectedTagPath: null,
      selectedTagPaths: [],
      selectedDocumentId: null,
      selectedFavoriteId: null,
      keyword: "",
      librarySort: { mode: "recent", direction: "desc" },
      finderColumnWidths: {
        name: 320,
        size: 96,
        updatedAt: 176,
        type: 132,
        createdAt: 176,
      },
      tagResultStructureMode: "file",
    },
    snapshot: createLibrarySnapshot({ binding: createLibraryBinding({ folderOpenBehavior }) }),
    requiresInitialization: false,
    initializationRedirectPath: "/init",
    tags: [],
    documentPage: createDocumentList(),
    fileItems: [createFileNode()],
    preview: null,
    loading: false,
    documentsLoading: false,
    previewLoading: false,
    refreshPending: false,
    error: null,
    previewError: null,
    entries: [],
    visibleEntryTotal: 0,
    hasMore: false,
    selectedDocument: null,
    setViewState: vi.fn(),
    bindLibrary: vi.fn(),
    reload: vi.fn(),
    reloadDocuments: vi.fn(),
    loadMore: vi.fn(),
    refresh: vi.fn(),
    selectFolder: vi.fn(),
    selectFolderEntry: vi.fn(),
    selectTag: vi.fn(),
    selectFavorite: vi.fn(),
    selectDocument: vi.fn(),
    openPreview: vi.fn(),
    downloadSelected: vi.fn(),
    toggleFavorite: vi.fn(),
    operateFile: vi.fn(),
  };
}
