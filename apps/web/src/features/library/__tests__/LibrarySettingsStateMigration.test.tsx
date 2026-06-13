import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDocumentList,
  createDocumentRecord,
  createLibraryBinding,
  createLibraryConfig,
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

describe("第 5 批：文档库设置、启用状态与侧栏状态", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
  });

  it("点击设置按钮后会在独立模态框里显示文档库设置", async () => {
    const onOpenSettings = vi.fn();
    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={onOpenSettings} platformData={platformData} />);

    await userEvent.click(await screen.findByRole("button", { name: "设置" }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("文档库左侧栏不再显示旧说明头和浏览模式切换", async () => {
    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    expect(await screen.findByRole("button", { name: "设置" })).toBeInTheDocument();
    expect(screen.queryByText("浏览本地资料、收藏常用入口，并查看标签和文件详情。")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "文件夹" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "标签" })).not.toBeInTheDocument();
  });

  it("没有收藏内容时会自动隐藏收藏夹分组", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({ favorites: [] }),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await screen.findByRole("button", { name: "设置" });
    expect(screen.queryByText("收藏")).not.toBeInTheDocument();
    expect(screen.queryByText("还没有收藏的目录或标签。")).not.toBeInTheDocument();
  });

  it("可以切换文档库启用状态", async () => {
    libraryApiMock.getLibraryConfig.mockResolvedValue(
      createLibraryConfig({
        enabled: true,
        binding: createLibraryBinding({ enabled: true }),
      }),
    );

    const { SettingsPage } = await import("../../settings/SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    await userEvent.click(screen.getByRole("switch", { name: "启用资料库" }));
    await userEvent.click(screen.getByRole("button", { name: "保存索引设置" }));

    await waitFor(() => {
      expect(libraryApiMock.saveLibraryConfig).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );
    });
  });

  it("文档库未启用时不会请求文档和文件夹标签详情", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        binding: createLibraryBinding({ enabled: false }),
        tags: [
          { path: "项目", name: "项目", rootType: "项目", parentPath: null, depth: 0, documentCount: 1 },
        ],
      }),
    );
    libraryApiMock.listLibraryTags.mockResolvedValue([
      { path: "项目", name: "项目", rootType: "项目", parentPath: null, depth: 0, documentCount: 1 },
    ]);
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-disabled", path: "docs/禁用.md" })]),
    );
    libraryApiMock.listLibraryTagDetails.mockResolvedValue([
      createTagDetail({ id: "tag-disabled", path: "项目/禁用", rootType: "项目" }),
    ]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await screen.findByText("资料库已保存，但当前未启用。");
    expect(libraryApiMock.listLibraryDocuments).not.toHaveBeenCalled();
    expect(libraryApiMock.listLibraryFiles).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByLabelText("文档列表"), { clientX: 10, clientY: 10 });
    expect(screen.queryByRole("menu", { name: "文档库操作菜单" })).not.toBeInTheDocument();
    expect(libraryApiMock.getDocumentTagDetails).not.toHaveBeenCalled();
    expect(libraryApiMock.getFolderTagDetails).not.toHaveBeenCalled();
    expect(libraryApiMock.listLibraryTagDetails).not.toHaveBeenCalled();
  });
});
