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

    await openDocumentTagDialog("合同.md");
    const dialog = screen.getByRole("dialog", { name: "分配标签" });
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

  it("选择单选组中的新子标签时替换当前兄弟标签", async () => {
    const parent = createTagDetail({
      id: "tag-status",
      path: "项目状态",
      childTagSelectionMode: "single",
    });
    const previous = createTagDetail({
      id: "tag-talk",
      path: "项目状态/方案沟通",
      parentId: parent.id,
      parentPath: parent.path,
    });
    const next = createTagDetail({
      id: "tag-bid",
      path: "项目状态/项目投标",
      parentId: parent.id,
      parentPath: parent.path,
    });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-status", path: "docs/project.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([parent, previous, next]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(createDocumentTagDetails({
      documentId: "doc-status",
      manualTagIds: [previous.id],
      resolvedTags: [resolvedTag(previous)],
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);
    await openDocumentTagDialog("project.md");
    const dialog = screen.getByRole("dialog", { name: "分配标签" });
    await userEvent.type(within(dialog).getByLabelText("添加标签"), next.path);
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(libraryApiMock.saveDocumentTags).toHaveBeenCalledWith("doc-status", {
        tagIds: [next.id],
        createTagPaths: [],
      });
    });
  });

  it("点击已分配的单选标签显示兄弟标签浮窗并可一键切换", async () => {
    const parent = createTagDetail({
      id: "tag-status",
      path: "项目状态",
      childTagSelectionMode: "single",
    });
    const current = createTagDetail({
      id: "tag-talk",
      path: "项目状态/方案沟通",
      parentId: parent.id,
      parentPath: parent.path,
    });
    const next = createTagDetail({
      id: "tag-bid",
      path: "项目状态/项目投标",
      parentId: parent.id,
      parentPath: parent.path,
    });
    const other = createTagDetail({
      id: "tag-department",
      path: "部门/工程",
      parentId: "tag-department-root",
      parentPath: "部门",
    });
    const otherExclusiveParent = createTagDetail({
      id: "tag-department-root",
      path: "部门",
      childTagSelectionMode: "single",
    });
    const otherExclusiveSibling = createTagDetail({
      id: "tag-sales",
      path: "部门/销售",
      parentId: otherExclusiveParent.id,
      parentPath: otherExclusiveParent.path,
    });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-switch", path: "docs/switch.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([
      parent,
      current,
      next,
      otherExclusiveParent,
      other,
      otherExclusiveSibling,
    ]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(createDocumentTagDetails({
      documentId: "doc-switch",
      manualTagIds: [current.id, other.id],
      resolvedTags: [resolvedTag(current), resolvedTag(other)],
    }));
    libraryApiMock.saveDocumentTags.mockResolvedValue(createDocumentTagDetails({
      documentId: "doc-switch",
      manualTagIds: [next.id, other.id],
      resolvedTags: [resolvedTag(next), resolvedTag(other)],
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);
    await openDocumentTagDialog("switch.md");

    await userEvent.click(screen.getByRole("button", {
      name: "切换互斥标签“项目状态/方案沟通”",
    }));
    const menu = screen.getByRole("menu", {
      name: "切换“项目状态”下的标签",
    });
    expect(within(menu).getByRole("menuitemradio", { name: "项目状态/项目投标" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitemradio", { name: "部门/销售" })).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", {
      name: "切换互斥标签“项目状态/方案沟通”",
    }));
    const reopenedMenu = screen.getByRole("menu", {
      name: "切换“项目状态”下的标签",
    });

    await userEvent.click(within(reopenedMenu).getByRole("menuitemradio", { name: "项目状态/项目投标" }));
    await waitFor(() => {
      expect(libraryApiMock.saveDocumentTags).toHaveBeenCalledWith("doc-switch", {
        tagIds: [other.id, next.id],
        createTagPaths: [],
      });
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
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

  it("输入框聚焦时显示推荐浮层，输入搜索词后隐藏推荐并显示匹配项", async () => {
    const recommendedTag = createTagDetail({
      id: "tag-recommended-customer",
      path: "客户/山东雄鹰轮胎集团有限公司",
      rootType: "客户",
    });
    const matchingTag = createTagDetail({
      id: "tag-search-match",
      path: "客户/搜索匹配",
      rootType: "客户",
    });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({
        documentId: "doc-recommendation-focus",
        path: "项目文档/GIXM0636-雄鹰轮胎机房建设项目/项目方案.md",
      })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([recommendedTag, matchingTag]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(createDocumentTagDetails({
      documentId: "doc-recommendation-focus",
      path: "项目文档/GIXM0636-雄鹰轮胎机房建设项目/项目方案.md",
      recommendedTags: [{
        tagId: recommendedTag.id,
        path: recommendedTag.path,
        name: recommendedTag.name,
        reason: "name_match",
        score: 92,
        evidence: "雄鹰轮胎",
      }],
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await openDocumentTagDialog("项目方案.md");
    const dialog = screen.getByRole("dialog", { name: "分配标签" });
    const input = within(dialog).getByLabelText("添加标签");
    const recommendations = within(dialog).getByLabelText("推荐标签");

    await userEvent.click(input);
    expect(document.activeElement).toBe(input);
    const inputAnchor = input.closest(".affairs-document-tag-input-anchor");
    expect(inputAnchor).toContainElement(recommendations);
    expect(inputAnchor).toHaveAttribute("data-focused", "true");
    expect(within(recommendations).getByText(recommendedTag.path)).toBeInTheDocument();

    await userEvent.type(input, "搜索");
    expect(within(dialog).queryByLabelText("推荐标签")).not.toBeInTheDocument();
    expect(within(dialog).getByRole("listbox", { name: "可分配标签" })).toBeInTheDocument();
  });

  it("文档标签请求提交后会立刻显示右上角进度入口", async () => {
    const tag = createTagDetail({ id: "tag-task", path: "项目/任务", rootType: "项目" });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-task", path: "docs/标签任务.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([tag]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(createDocumentTagDetails({ documentId: "doc-task", path: "docs/标签任务.md" }));
    libraryApiMock.listLibraryTasks.mockResolvedValue([{
      taskId: "running-doc-tag", taskType: "library.tag_assignment", rootDir: "/Users/test/Documents",
      targetPath: "docs/标签任务.md", source: "test", state: "running", stage: "save_tags",
      totalCount: 1, processedCount: 0, errorSummary: null,
      queuedAt: "2026-10-26T00:00:00Z", startedAt: "2026-10-26T00:00:00Z", completedAt: null,
    }]);
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

    expect(await screen.findByRole("button", { name: /任务中心/ })).toBeInTheDocument();
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
    libraryApiMock.listLibraryTasks.mockResolvedValue([{
      taskId: "running-folder-tag", taskType: "library.tag_assignment", rootDir: "/Users/test/Documents",
      targetPath: "任务目录", source: "test", state: "running", stage: "save_tags",
      totalCount: 1, processedCount: 0, errorSummary: null,
      queuedAt: "2026-10-26T00:00:00Z", startedAt: "2026-10-26T00:00:00Z", completedAt: null,
    }]);
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

    expect(await screen.findByRole("button", { name: /任务中心/ })).toBeInTheDocument();
  });

  it("右上角标签任务入口可以展开最近一次标签任务记录", async () => {
    libraryApiMock.listLibraryTasks.mockResolvedValue([{
      taskId: "completed-tag-task", taskType: "library.tag_assignment", rootDir: "/Users/test/Documents",
      targetPath: "docs/最近任务.md", source: "test", state: "completed", stage: null,
      totalCount: 1, processedCount: 1, errorSummary: null,
      queuedAt: "2026-10-26T00:00:00Z", startedAt: "2026-10-26T00:00:00Z", completedAt: "2026-10-26T00:00:01Z",
    }]);
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

    await userEvent.click(await screen.findByRole("button", { name: /任务中心/ }));
    const taskPanel = await screen.findByRole("dialog", { name: "任务中心" });
    await userEvent.click(within(taskPanel).getByRole("button", { name: "标签分配" }));
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

  it("分配标签弹窗不启用背景模糊", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-blur", path: "docs/无模糊.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(
      createDocumentTagDetails({ documentId: "doc-blur", path: "docs/无模糊.md" }),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await openDocumentTagDialog("无模糊.md");
    const dialog = screen.getByRole("dialog", { name: "分配标签" });
    const layer = dialog.closest(".desktop-modal-layer");
    expect(layer).not.toBeNull();
    expect(layer?.getAttribute("data-backdrop-visible")).toBe("false");
  });

  it("标签分配成功后自动关闭弹窗", async () => {
    const tag = createTagDetail({ id: "tag-auto-close", path: "项目/自动关闭", rootType: "项目" });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-close", path: "docs/自动关闭.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([tag]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(
      createDocumentTagDetails({ documentId: "doc-close", path: "docs/自动关闭.md" }),
    );
    libraryApiMock.saveDocumentTags.mockResolvedValue(createDocumentTagDetails({
      documentId: "doc-close",
      path: "docs/自动关闭.md",
      manualTagIds: [tag.id],
      resolvedTags: [resolvedTag(tag)],
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await openDocumentTagDialog("自动关闭.md");
    await userEvent.type(screen.getByLabelText("添加标签"), "项目/自动关闭");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "分配标签" })).not.toBeInTheDocument();
    });
    expect(libraryApiMock.saveDocumentTags).toHaveBeenCalledWith("doc-close", {
      tagIds: [tag.id],
      createTagPaths: [],
    });
  });

  it("标签分配失败时保留弹窗并展示错误", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-fail", path: "docs/失败.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(
      createDocumentTagDetails({ documentId: "doc-fail", path: "docs/失败.md" }),
    );
    libraryApiMock.saveDocumentTags.mockRejectedValue(new Error("保存失败"));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await openDocumentTagDialog("失败.md");
    await userEvent.type(screen.getByLabelText("添加标签"), "项目/失败");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(libraryApiMock.saveDocumentTags).toHaveBeenCalled();
    });
    expect(screen.getByRole("dialog", { name: "分配标签" })).toBeInTheDocument();
  });

  it("弹窗分配标签后右侧对象详情自动刷新为最新标签", async () => {
    const tag = createTagDetail({ id: "tag-sync", path: "项目/联动刷新", rootType: "项目" });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-sync", path: "docs/联动.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([tag]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(
      createDocumentTagDetails({ documentId: "doc-sync", path: "docs/联动.md" }),
    );
    libraryApiMock.saveDocumentTags.mockResolvedValue(createDocumentTagDetails({
      documentId: "doc-sync",
      path: "docs/联动.md",
      manualTagIds: [tag.id],
      resolvedTags: [resolvedTag(tag)],
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    // 右键选中后右侧对象详情先处于“还没有分配标签”状态
    fireEvent.contextMenu(await screen.findByRole("button", { name: /联动\.md/ }), { clientX: 10, clientY: 10 });
    const detail = document.querySelector(".affairs-detail-panel");
    expect(detail).not.toBeNull();
    await within(detail as HTMLElement).findByText("还没有分配标签。");

    // 弹窗里分配标签，保存接口之后重新拉取详情会返回已分配结果
    await userEvent.click(await screen.findByRole("menuitem", { name: "标签" }));
    const tagDialog = await screen.findByRole("dialog", { name: "分配标签" });
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(createDocumentTagDetails({
      documentId: "doc-sync",
      path: "docs/联动.md",
      manualTagIds: [tag.id],
      resolvedTags: [resolvedTag(tag)],
    }));
    await userEvent.type(within(tagDialog).getByLabelText("添加标签"), "项目/联动刷新");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "分配标签" })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(within(detail as HTMLElement).getByText("项目/联动刷新")).toBeInTheDocument();
    });
  });

  it("创建并分配入口只保留单行标签，不再显示底部备注说明", async () => {
    const matchedTag = createTagDetail({ id: "tag-power", path: "客户/电力咨询", rootType: "客户" });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-create", path: "docs/创建.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([matchedTag]);
    libraryApiMock.getDocumentTagDetails.mockResolvedValue(
      createDocumentTagDetails({ documentId: "doc-create", path: "docs/创建.md" }),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await openDocumentTagDialog("创建.md");
    const dialog = screen.getByRole("dialog", { name: "分配标签" });
    await userEvent.type(within(dialog).getByLabelText("添加标签"), "电力");

    const createButton = within(dialog).getByRole("button", { name: "创建并分配“电力”" });
    // 备注说明不再占用行内空间，只作为悬停提示保留
    expect(createButton).not.toHaveTextContent("如果这个标签还不存在");
    expect(createButton).toHaveAttribute("title", "如果这个标签还不存在，会直接新建后分配。");
    // 与已有标签使用同一胶囊类名，尺寸由同一套全局样式决定
    expect(createButton).toHaveClass("affairs-document-tag-suggestion");
    expect(within(dialog).getByText("客户/电力咨询")).toBeInTheDocument();
  });

});

async function openDocumentTagDialog(fileName: string): Promise<void> {
  const item = await screen.findByRole("button", { name: new RegExp(fileName) });
  fireEvent.contextMenu(item, { clientX: 10, clientY: 10 });
  await userEvent.click(await screen.findByRole("menuitem", { name: "标签" }));
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
