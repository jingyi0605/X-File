import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createDocumentList,
  createTagDetail,
  createTagNode,
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

describe("第 9 批：标签管理、智能规则与全量重算任务", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
    libraryApiMock.listLibraryDocuments.mockResolvedValue(createDocumentList());
    libraryApiMock.getLibraryTagRecomputeTask.mockResolvedValue(null);
  });

  it("标签管理模态框可以按树状结构管理标签并创建根标签和子标签", async () => {
    const root = createTagDetail({ id: "tag-root", path: "项目", name: "项目", documentCount: 8 });
    const child = createTagDetail({
      id: "tag-child",
      path: "项目/售前",
      name: "售前",
      parentId: "tag-root",
      parentPath: "项目",
      documentCount: 3,
    });
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([root, child]);
    libraryApiMock.createLibraryTag.mockImplementation(async (input) =>
      createTagDetail({
        id: input.parentId ? "tag-new-child" : "tag-new-root",
        path: input.parentId ? "项目/子标签" : "新标签",
        name: input.name,
        parentId: input.parentId,
        parentPath: input.parentId ? "项目" : null,
      }),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await openTagManager();

    const dialog = await screen.findByRole("dialog", { name: "标签管理" });
    expect(within(dialog).getByRole("button", { name: /项目/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: /售前/ })).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole("button", { name: "新建根标签" }));
    expect(libraryApiMock.createLibraryTag).toHaveBeenCalledWith(expect.objectContaining({
      parentId: null,
      name: expect.stringContaining("新标签"),
    }));

    await userEvent.click(within(dialog).getByRole("button", { name: /项目/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "新建子标签" }));
    expect(libraryApiMock.createLibraryTag).toHaveBeenCalledWith(expect.objectContaining({
      parentId: "tag-root",
      name: expect.stringContaining("子标签"),
    }));
  });

  it("标签改名后会主动刷新左侧标签树名称", async () => {
    const before = createTagDetail({ id: "tag-project", path: "项目", name: "项目", documentCount: 6 });
    const after = createTagDetail({ id: "tag-project", path: "项目新名", name: "项目新名", documentCount: 6 });
    libraryApiMock.listLibraryTagDetails
      .mockResolvedValueOnce([before])
      .mockResolvedValue([after]);
    libraryApiMock.listLibraryTags
      .mockResolvedValueOnce([createTagNode({ path: "项目", name: "项目", rootType: "manual", documentCount: 6 })])
      .mockResolvedValue([createTagNode({ path: "项目新名", name: "项目新名", rootType: "manual", documentCount: 6 })]);
    libraryApiMock.updateLibraryTag.mockResolvedValue(after);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    expect(await screen.findByRole("button", { name: /项目/ })).toBeInTheDocument();

    await openTagManager();
    const dialog = await screen.findByRole("dialog", { name: "标签管理" });
    await userEvent.clear(within(dialog).getByLabelText("名称"));
    await userEvent.type(within(dialog).getByLabelText("名称"), "项目新名");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存标签" }));

    await waitFor(() => {
      expect(libraryApiMock.updateLibraryTag).toHaveBeenCalledWith("tag-project", expect.objectContaining({
        name: "项目新名",
      }));
    });
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /项目新名/ }).length).toBeGreaterThanOrEqual(1);
    });
  });

  it("标签管理模态框支持添加智能规则并保存", async () => {
    const tag = createTagDetail({ id: "tag-contract", path: "业务/合同", name: "合同" });
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([tag]);
    libraryApiMock.updateLibraryTag.mockResolvedValue(tag);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await openTagManager();
    const dialog = await screen.findByRole("dialog", { name: "标签管理" });

    await userEvent.click(within(dialog).getByRole("button", { name: "添加规则" }));
    await userEvent.type(within(dialog).getByLabelText("关键词"), "合同");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存标签" }));

    await waitFor(() => {
      expect(libraryApiMock.updateLibraryTag).toHaveBeenCalledWith("tag-contract", expect.objectContaining({
        smartRules: [expect.objectContaining({
          relation: "and",
          ruleType: "file_name_contains",
          matcher: { keyword: "合同" },
          enabled: true,
          priority: 0,
        })],
      }));
    });
  });

  it("标签管理模态框支持配置按文件夹子树命中的智能规则", async () => {
    const tag = createTagDetail({ id: "tag-folder", path: "客户/合同", name: "合同" });
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([tag]);
    libraryApiMock.updateLibraryTag.mockResolvedValue(tag);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await openTagManager();
    const dialog = await screen.findByRole("dialog", { name: "标签管理" });

    await userEvent.click(within(dialog).getByRole("button", { name: "添加规则" }));
    await userEvent.selectOptions(within(dialog).getByLabelText("规则类型"), "document_path_in_folder");
    await userEvent.clear(within(dialog).getByLabelText("文件夹路径"));
    await userEvent.type(within(dialog).getByLabelText("文件夹路径"), "客户/合同");
    await userEvent.click(within(dialog).getByRole("button", { name: "保存标签" }));

    await waitFor(() => {
      expect(libraryApiMock.updateLibraryTag).toHaveBeenCalledWith("tag-folder", expect.objectContaining({
        smartRules: [expect.objectContaining({
          ruleType: "document_path_in_folder",
          matcher: { folderPath: "客户/合同" },
        })],
      }));
    });
  });

  it("标签管理模态框点击标签后直接进入编辑，并在详情区显示文档数量", async () => {
    const root = createTagDetail({ id: "tag-root", path: "项目", name: "项目", documentCount: 8 });
    const child = createTagDetail({
      id: "tag-child",
      path: "项目/售前",
      name: "售前",
      parentId: "tag-root",
      parentPath: "项目",
      documentCount: 3,
    });
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([root, child]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await openTagManager();
    const dialog = await screen.findByRole("dialog", { name: "标签管理" });

    await userEvent.click(within(dialog).getByRole("button", { name: /售前/ }));

    expect(within(dialog).getByRole("heading", { name: "编辑标签" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("名称")).toHaveValue("售前");
    const documentCountLabel = within(dialog).getByText("文档数量");
    expect(documentCountLabel).toBeInTheDocument();
    expect(documentCountLabel.parentElement).toHaveTextContent("3");
  });

  it("标签管理模态框可以发起全量标签重算恢复任务", async () => {
    const tag = createTagDetail({ id: "tag-root", path: "项目", name: "项目" });
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([tag]);
    libraryApiMock.requestLibraryTagRecompute.mockResolvedValue({ taskId: "task-1", deduped: false });
    libraryApiMock.getLibraryTagRecomputeTask.mockResolvedValue(null);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await openTagManager();
    const dialog = await screen.findByRole("dialog", { name: "标签管理" });

    await userEvent.click(within(dialog).getByRole("button", { name: "恢复文件标签结果" }));

    await waitFor(() => {
      expect(libraryApiMock.requestLibraryTagRecompute).toHaveBeenCalledTimes(1);
    });
  });

  it("标签管理模态框会显示全量标签重算的当前进度", async () => {
    const tag = createTagDetail({ id: "tag-root", path: "项目", name: "项目" });
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([tag]);
    libraryApiMock.getLibraryTagRecomputeTask.mockResolvedValue({
      state: "running",
      runningStage: "正在合并智能规则",
      errorSummary: null,
      completedAt: null,
    });

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await openTagManager();
    const dialog = await screen.findByRole("dialog", { name: "标签管理" });

    expect(await within(dialog).findByText("正在合并智能规则")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "正在恢复文件标签结果…" })).toBeDisabled();
  });
});

async function openTagManager(): Promise<void> {
  await userEvent.click(await screen.findByLabelText("管理标签"));
}
