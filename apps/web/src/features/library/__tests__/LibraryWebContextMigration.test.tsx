import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryDocumentTagDetails, LibraryTagDetailWithRules } from "@x-file/shared";

import {
  createDocumentList,
  createDocumentRecord,
  createFileList,
  createFileNode,
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

describe("第 4 批：H5/Web 右键菜单、文件操作与剪贴板", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
    libraryApiMock.downloadLibraryFile.mockResolvedValue({
      fileName: "合同.md",
      contentBase64: "5ZCI5ZCM",
      mimeType: "text/markdown",
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("文档库文件右键菜单点击删除后会先确认再删除", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ path: "docs/待删除.md" })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: /待删除\.md/ }), { clientX: 10, clientY: 10 });
    await userEvent.click(await screen.findByRole("menuitem", { name: "删除" }));

    const deleteDialog = await screen.findByRole("dialog", { name: "删除项目" });
    expect(libraryApiMock.operateLibraryFile).not.toHaveBeenCalled();

    await userEvent.click(within(deleteDialog).getByRole("button", { name: "删除" }));
    await waitFor(() => {
      expect(libraryApiMock.operateLibraryFile).toHaveBeenCalledWith({ opType: "delete", srcPath: "docs/待删除.md" });
    });
  });

  it("H5 右键菜单点击分配标签后会打开快捷分配面板", async () => {
    const tag = createTagDetail({ id: "tag-contract", path: "项目/合同", rootType: "项目" });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-tag", path: "docs/合同.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([tag]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(createDocumentTagDetails({ documentId: "doc-tag", path: "docs/合同.md" }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: /合同\.md/ }), { clientX: 10, clientY: 10 });
    await userEvent.click(await screen.findByRole("menuitem", { name: "标签" }));

    const dialog = await screen.findByRole("dialog", { name: "分配标签" });
    expect(within(dialog).getByLabelText("添加标签")).toBeInTheDocument();
  });

  it("右键分配标签面板会显示最多 8 个推荐标签，并可一键分配", async () => {
    const tags = Array.from({ length: 10 }, (_, index) =>
      createTagDetail({ id: `tag-${index + 1}`, path: `项目/推荐${index + 1}`, rootType: "项目" }),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-rec", path: "docs/推荐.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue(tags);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(createDocumentTagDetails({
      documentId: "doc-rec",
      path: "docs/推荐.md",
      recommendedTags: tags.map((tag, index) => ({
        tagId: tag.id,
        path: tag.path,
        name: tag.name,
        reason: "name_match" as const,
        score: 100 - index,
        evidence: `证据 ${index + 1}`,
      })),
    }));
    libraryApiMock.saveDocumentTags.mockResolvedValue(createDocumentTagDetails({
      documentId: "doc-rec",
      path: "docs/推荐.md",
      manualTagIds: [tags[0].id],
      resolvedTags: [resolvedTag(tags[0])],
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: /推荐\.md/ }), { clientX: 10, clientY: 10 });
    await userEvent.click(await screen.findByRole("menuitem", { name: "标签" }));

    const recommendations = await screen.findByLabelText("推荐标签");
    const buttons = within(recommendations).getAllByRole("button", { name: /分配推荐标签/ });
    expect(buttons).toHaveLength(8);

    await userEvent.click(buttons[0]);
    await waitFor(() => {
      expect(libraryApiMock.saveDocumentTags).toHaveBeenCalledWith("doc-rec", {
        tagIds: [tags[0].id],
        createTagPaths: [],
      });
    });
  });

  it("H5 环境下右键下载仍然可用", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ path: "docs/合同.md" })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: /合同\.md/ }), { clientX: 10, clientY: 10 });
    await userEvent.click(await screen.findByRole("menuitem", { name: "下载" }));

    await waitFor(() => {
      expect(libraryApiMock.downloadLibraryFile).toHaveBeenCalledWith("docs/合同.md");
    });
  });

  it("文档库空白处右键菜单只保留可粘贴操作和空白区动作", async () => {
    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    fireEvent.contextMenu(await screen.findByLabelText("文档列表"), { clientX: 50, clientY: 60 });
    const menu = await screen.findByRole("menu", { name: "文档库操作菜单" });

    expect(within(menu).getByRole("menuitem", { name: "新建" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "粘贴" })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "刷新" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "属性" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "删除" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "标签" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "下载" })).not.toBeInTheDocument();
  });

  it("H5 空白处右键可以新建目录并刷新列表", async () => {
    libraryApiMock.operateLibraryFile.mockResolvedValue({ ok: true });
    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    fireEvent.contextMenu(await screen.findByLabelText("文档列表"), { clientX: 50, clientY: 60 });
    const menu = await screen.findByRole("menu", { name: "文档库操作菜单" });
    await userEvent.click(within(menu).getByRole("menuitem", { name: "新建目录" }));

    const dialog = await screen.findByRole("dialog", { name: "新建项目" });
    await userEvent.clear(within(dialog).getByLabelText("名称"));
    await userEvent.type(within(dialog).getByLabelText("名称"), "新客户");
    await userEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(libraryApiMock.operateLibraryFile).toHaveBeenCalledWith({
        opType: "create_directory",
        dstPath: "新客户",
        content: null,
      });
    });
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
    });
  });
});

function createDocumentTagDetails(
  overrides: Partial<LibraryDocumentTagDetails> = {},
): LibraryDocumentTagDetails {
  return {
    documentId: "doc-1",
    path: "docs/文档.md",
    title: "文档",
    manualTagIds: [],
    effectiveFolderBindings: [],
    resolvedTags: [],
    recommendedTags: [],
    ...overrides,
  };
}

function resolvedTag(tag: LibraryTagDetailWithRules): LibraryDocumentTagDetails["resolvedTags"][number] {
  return {
    path: tag.path,
    sourceType: "manual_document",
    sourceRef: tag.id,
    evidence: null,
    confidence: 1,
    priority: 0,
  };
}
