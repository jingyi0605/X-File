import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LibraryDocumentTagDetails,
  LibraryFolderTagDetails,
  LibraryTagDetailWithRules,
} from "@x-file/shared";

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

describe("第 10 批：文档与文件夹标签分配、推荐标签和任务进度入口", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
  });

  it("文档详情通过输入匹配添加标签，并且不把时间和类型标签当普通标签", async () => {
    const businessTag = createTagDetail({ id: "tag-contract", path: "业务/合同", rootType: "业务" });
    const timeTag = createTagDetail({ id: "tag-time", path: "时间/最近7天", rootType: "时间" });
    const typeTag = createTagDetail({ id: "tag-type", path: "类型/PDF", rootType: "类型" });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-1", path: "docs/合同.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([businessTag, timeTag, typeTag]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(createDocumentTagDetails({ documentId: "doc-1", path: "docs/合同.md" }));
    libraryApiMock.saveDocumentTags.mockResolvedValue(createDocumentTagDetails({
      documentId: "doc-1",
      path: "docs/合同.md",
      manualTagIds: [businessTag.id],
      resolvedTags: [resolvedTag(businessTag)],
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await userEvent.click(await screen.findByRole("button", { name: /合同\.md/ }));
    await userEvent.click(await screen.findByRole("button", { name: "编辑文档标签" }));

    const dialog = await screen.findByRole("dialog", { name: "分配标签" });
    const input = within(dialog).getByLabelText("添加标签");
    await userEvent.type(input, "业务/合同");

    const suggestions = within(dialog).getByRole("listbox", { name: "可分配标签" });
    expect(within(suggestions).getByText("业务/合同")).toBeInTheDocument();
    expect(within(suggestions).queryByText("时间/最近7天")).not.toBeInTheDocument();
    expect(within(suggestions).queryByText("类型/PDF")).not.toBeInTheDocument();

    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(libraryApiMock.saveDocumentTags).toHaveBeenCalledWith("doc-1", {
        tagIds: [businessTag.id],
        createTagPaths: [],
      });
    });
  });

  it("文档详情推荐标签收进推荐区域，最多显示 8 个并排除已分配标签", async () => {
    const assignedTag = createTagDetail({ id: "tag-assigned", path: "项目/已分配", rootType: "项目" });
    const assignableTags = Array.from({ length: 10 }, (_, index) =>
      createTagDetail({ id: `tag-${index + 1}`, path: `项目/推荐${index + 1}`, rootType: "项目" }),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-rec", path: "docs/推荐.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([assignedTag, ...assignableTags]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(createDocumentTagDetails({
      documentId: "doc-rec",
      path: "docs/推荐.md",
      manualTagIds: [assignedTag.id],
      resolvedTags: [resolvedTag(assignedTag)],
      recommendedTags: [assignedTag, ...assignableTags].map((tag, index) => ({
        tagId: tag.id,
        path: tag.path,
        name: tag.name,
        reason: "name_match" as const,
        score: 100 - index,
        evidence: `证据 ${index + 1}`,
      })),
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await openDocumentTagDialog("推荐.md");
    const recommendations = await screen.findByLabelText("推荐标签");
    const buttons = within(recommendations).getAllByRole("button", { name: /分配推荐标签/ });
    expect(buttons).toHaveLength(8);
    expect(within(recommendations).queryByText("项目/已分配")).not.toBeInTheDocument();
  });

  it("文档标签请求提交后会立刻显示右上角进度入口", async () => {
    const tag = createTagDetail({ id: "tag-task", path: "项目/任务", rootType: "项目" });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-task", path: "docs/标签任务.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([tag]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(createDocumentTagDetails({ documentId: "doc-task", path: "docs/标签任务.md" }));
    libraryApiMock.saveDocumentTags.mockImplementation(
      () => new Promise((resolve) => window.setTimeout(() => resolve(createDocumentTagDetails({
        documentId: "doc-task",
        path: "docs/标签任务.md",
        manualTagIds: [tag.id],
        resolvedTags: [resolvedTag(tag)],
      })), 80)),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await openDocumentTagDialog("标签任务.md");
    await userEvent.type(screen.getByLabelText("添加标签"), "项目/任务");
    await userEvent.keyboard("{Enter}");

    expect(await screen.findByRole("button", { name: /标签任务入口/ })).toBeInTheDocument();
  });

  it("文档详情输入不存在的标签时会直接创建并分配", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-new", path: "docs/新标签.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(createDocumentTagDetails({ documentId: "doc-new", path: "docs/新标签.md" }));
    libraryApiMock.saveDocumentTags.mockResolvedValue(createDocumentTagDetails({ documentId: "doc-new", path: "docs/新标签.md" }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await openDocumentTagDialog("新标签.md");
    await userEvent.type(screen.getByLabelText("添加标签"), "项目/新客户");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(libraryApiMock.saveDocumentTags).toHaveBeenCalledWith("doc-new", {
        tagIds: [],
        createTagPaths: ["项目/新客户"],
      });
    });
  });

  it("文件夹详情可以通过输入分配已有标签", async () => {
    const tag = createTagDetail({ id: "tag-folder", path: "项目/文件夹", rootType: "项目" });
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([tag]);
    libraryApiMock.getFolderTagDetails.mockResolvedValue(createFolderTagDetails({ folderPath: "客户资料" }));
    libraryApiMock.saveFolderTags.mockResolvedValue(createFolderTagDetails({
      folderPath: "客户资料",
      bindingTagIds: [tag.id],
      bindings: [folderBinding(tag)],
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await openFolderTagDialog("客户资料");
    await userEvent.type(screen.getByLabelText("添加标签"), "项目/文件夹");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(libraryApiMock.saveFolderTags).toHaveBeenCalledWith({
        folderPath: "客户资料",
        tagIds: [tag.id],
        createTagPaths: [],
      });
    });
  });

  it("文件夹标签请求提交后会立刻显示右上角进度入口", async () => {
    const tag = createTagDetail({ id: "tag-folder-task", path: "项目/目录任务", rootType: "项目" });
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "任务目录", name: "任务目录", kind: "directory" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([tag]);
    libraryApiMock.getFolderTagDetails.mockResolvedValue(createFolderTagDetails({ folderPath: "任务目录" }));
    libraryApiMock.saveFolderTags.mockImplementation(
      () => new Promise((resolve) => window.setTimeout(() => resolve(createFolderTagDetails({
        folderPath: "任务目录",
        bindingTagIds: [tag.id],
        bindings: [folderBinding(tag)],
      })), 80)),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await openFolderTagDialog("任务目录");
    await userEvent.type(screen.getByLabelText("添加标签"), "项目/目录任务");
    await userEvent.keyboard("{Enter}");

    expect(await screen.findByRole("button", { name: /标签任务入口/ })).toBeInTheDocument();
  });

  it("右上角标签任务入口可以展开最近一次标签任务记录", async () => {
    const tag = createTagDetail({ id: "tag-last", path: "项目/最近任务", rootType: "项目" });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-last", path: "docs/最近任务.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([tag]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(createDocumentTagDetails({ documentId: "doc-last", path: "docs/最近任务.md" }));
    libraryApiMock.saveDocumentTags.mockResolvedValue(createDocumentTagDetails({
      documentId: "doc-last",
      path: "docs/最近任务.md",
      manualTagIds: [tag.id],
      resolvedTags: [resolvedTag(tag)],
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await openDocumentTagDialog("最近任务.md");
    await userEvent.type(screen.getByLabelText("添加标签"), "项目/最近任务");
    await userEvent.keyboard("{Enter}");

    await userEvent.click(await screen.findByRole("button", { name: /标签任务入口/ }));
    const taskPanel = await screen.findByRole("status", { name: "最近标签任务" });
    expect(within(taskPanel).getByText("docs/最近任务.md")).toBeInTheDocument();
    expect(within(taskPanel).getByText("已完成")).toBeInTheDocument();
  });

  it("文件夹详情输入不存在的标签时会直接创建并绑定", async () => {
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "新客户", name: "新客户", kind: "directory" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([]);
    libraryApiMock.getFolderTagDetails.mockResolvedValue(createFolderTagDetails({ folderPath: "新客户" }));
    libraryApiMock.saveFolderTags.mockResolvedValue(createFolderTagDetails({ folderPath: "新客户" }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await openFolderTagDialog("新客户");
    await userEvent.type(screen.getByLabelText("添加标签"), "项目/新目录");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(libraryApiMock.saveFolderTags).toHaveBeenCalledWith({
        folderPath: "新客户",
        tagIds: [],
        createTagPaths: ["项目/新目录"],
      });
    });
  });
});

async function openDocumentTagDialog(fileName: string): Promise<void> {
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(fileName) }));
  await userEvent.click(await screen.findByRole("button", { name: "编辑文档标签" }));
  await screen.findByRole("dialog", { name: "分配标签" });
}

async function openFolderTagDialog(folderName: string): Promise<void> {
  const item = await screen.findByRole("button", { name: new RegExp(folderName) });
  fireEvent.contextMenu(item, { clientX: 10, clientY: 10 });
  await userEvent.click(await screen.findByRole("menuitem", { name: "标签" }));
  await screen.findByRole("dialog", { name: "分配标签" });
}

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

function createFolderTagDetails(
  overrides: Partial<LibraryFolderTagDetails> = {},
): LibraryFolderTagDetails {
  return {
    folderPath: "客户资料",
    exists: true,
    bindingTagIds: [],
    bindings: [],
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

function folderBinding(tag: LibraryTagDetailWithRules): LibraryFolderTagDetails["bindings"][number] {
  return {
    id: `binding-${tag.id}`,
    tagId: tag.id,
    tagPath: tag.path,
    applyMode: "subtree",
  };
}
