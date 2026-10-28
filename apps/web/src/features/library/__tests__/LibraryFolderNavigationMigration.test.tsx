import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createDocumentList,
  createDocumentRecord,
  createFileList,
  createFileNode,
  createLibraryBinding,
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

describe("第 2 批：文件夹打开行为、目录选中与目录导航", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
  });

  it("文档库文件夹默认双击进入，单击只选中并显示目录详情", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        binding: createLibraryBinding({ folderOpenBehavior: "double_click" }),
        folders: [{ path: "客户资料", name: "客户资料", parentPath: null, directDocumentCount: 0, documentCount: 2 }],
      }),
    );
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" })]),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(createDocumentList([]));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    const folder = await screen.findByRole("button", { name: /客户资料/ });
    await userEvent.click(folder);

    expect(await screen.findByRole("heading", { name: "客户资料" })).toBeInTheDocument();
    const selectedFolderDetails = screen.getByRole("complementary", { name: "详情" });
    expect(within(selectedFolderDetails).getByRole("heading", { name: "客户资料" })).toBeInTheDocument();
    expect(within(selectedFolderDetails).getByText("文件夹")).toBeInTheDocument();
    expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith(null, 200);

    fireEvent.doubleClick(folder);
    await waitFor(() => {
      expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料", 200);
    });
  });

  it("目录右键菜单使用简短的收藏文案", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        folders: [{ path: "客户资料", name: "客户资料", parentPath: null, directDocumentCount: 0, documentCount: 0 }],
      }),
    );
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" })]),
    );
    libraryApiMock.updateLibraryFavorites.mockImplementation(async ({ favorites }) => ({ items: favorites }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    const folderName = await screen.findByText("客户资料");
    fireEvent.contextMenu(folderName, { clientX: 10, clientY: 10 });
    const menu = await screen.findByRole("menu", { name: "文档库操作菜单" });
    expect(within(menu).getByRole("menuitem", { name: "收藏" })).toBeInTheDocument();
    await userEvent.click(within(menu).getByRole("menuitem", { name: "收藏" }));

    await waitFor(() => {
      expect(libraryApiMock.updateLibraryFavorites).toHaveBeenLastCalledWith({
        favorites: [{ kind: "folder", path: "客户资料", label: "客户资料" }],
      });
    });
  });

  it("收藏列表悬停时显示目录完整路径和标签组合", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        favorites: [
          { kind: "folder", path: "项目资料/合同签订", label: "合同签订" },
          {
            kind: "tag_filter",
            path: "项目/实施|状态/进行中",
            label: "实施中项目",
            tagPaths: ["项目/实施", "状态/进行中"],
          },
        ],
      }),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    expect(await screen.findByRole("button", { name: "合同签订" })).toHaveAttribute(
      "title",
      "项目资料/合同签订",
    );
    const tagFavorite = await screen.findByRole("button", { name: "实施中项目" });
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(tagFavorite, { clientX: 320, clientY: 140 });
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

      act(() => vi.advanceTimersByTime(1999));
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();

      act(() => vi.advanceTimersByTime(1));
      const tagPreview = screen.getByRole("tooltip");
      expect(within(tagPreview).getAllByText(/项目\/实施|状态\/进行中/)).toHaveLength(2);
      expect(tagFavorite).not.toHaveAttribute("title");
      expect(tagPreview).toHaveStyle({ left: "334px", top: "154px" });

      fireEvent.mouseLeave(tagFavorite);
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("网格目录星标可以收藏和取消收藏，且不会触发行选择", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(createLibrarySnapshot());
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" })]),
    );
    libraryApiMock.updateLibraryFavorites.mockImplementation(async ({ favorites }) => ({ items: favorites }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    const favoriteButton = await screen.findByRole("button", { name: "收藏当前目录" });
    await userEvent.click(favoriteButton);

    await waitFor(() => {
      expect(libraryApiMock.updateLibraryFavorites).toHaveBeenLastCalledWith({
        favorites: [{ kind: "folder", path: "客户资料", label: "客户资料" }],
      });
    });
    expect(screen.queryByRole("heading", { name: "客户资料" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "取消收藏" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "取消收藏" }));
    await waitFor(() => {
      expect(libraryApiMock.updateLibraryFavorites).toHaveBeenLastCalledWith({ favorites: [] });
    });
  });

  it("目录详情星标与列表行星标共用收藏状态", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(createLibrarySnapshot());
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" })]),
    );
    libraryApiMock.updateLibraryFavorites.mockImplementation(async ({ favorites }) => ({ items: favorites }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);
    await userEvent.click(await screen.findByRole("button", { name: "列表" }));

    const folderRow = await waitFor(() => {
      const row = document.querySelector<HTMLButtonElement>(".affairs-finder-directory-row");
      expect(row).not.toBeNull();
      return row as HTMLButtonElement;
    });
    const rowFavorite = await screen.findByRole("button", { name: "收藏当前目录" });
    await userEvent.click(folderRow);

    await screen.findByRole("heading", { name: "客户资料" });
    const detailPanel = screen.getByRole("complementary", { name: "详情" });
    const detailFavorite = within(detailPanel).getByRole("button", { name: "收藏当前目录" });
    expect(detailFavorite).toHaveClass("affairs-detail-action-button");
    expect(detailFavorite).toHaveTextContent("收藏");
    expect(detailPanel.querySelector(".affairs-folder-detail-favorite")).toBeNull();
    await userEvent.click(detailFavorite);
    await waitFor(() => {
      expect(libraryApiMock.updateLibraryFavorites).toHaveBeenLastCalledWith({
        favorites: [{ kind: "folder", path: "客户资料", label: "客户资料" }],
      });
    });
    expect(within(detailPanel).getByRole("button", { name: "取消收藏" })).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findAllByRole("button", { name: "取消收藏" })).toHaveLength(2);
    expect(folderRow).toBeInTheDocument();
    expect(rowFavorite).toBeInTheDocument();
  });

  it("单击选中文件夹时，当前目录下的文件不会消失", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        binding: createLibraryBinding({ folderOpenBehavior: "double_click" }),
        folders: [{ path: "客户资料", name: "客户资料", parentPath: null, directDocumentCount: 0, documentCount: 1 }],
      }),
    );
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" })]),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "doc-keep", path: "根目录文件.md" })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    expect(await screen.findByRole("button", { name: /根目录文件\.md/ })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /客户资料/ }));

    expect(screen.getByRole("button", { name: /根目录文件\.md/ })).toBeInTheDocument();
    expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({ selectedFolderPath: null }));
  });

  it("点击根路径按钮时会切回文件夹根目录", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(createLibrarySnapshot());
    libraryApiMock.listLibraryFiles.mockImplementation(async (path: string | null) =>
      createFileList(
        path === "客户资料"
          ? [createFileNode({ path: "客户资料/合同", name: "合同", kind: "directory" })]
          : [createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" })],
      ),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(createDocumentList([]));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    fireEvent.doubleClick(await screen.findByRole("button", { name: /客户资料/ }));
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料", 200));

    await userEvent.click(screen.getByRole("button", { name: "根目录" }));
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith(null, 200));
    expect(document.querySelector(".affairs-doc-item.grid")).toBeInTheDocument();
  });

  it("侧栏前进和后退按钮按浏览顺序恢复文件视图", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(createLibrarySnapshot());
    libraryApiMock.listLibraryFiles.mockImplementation(async (path: string | null) =>
      createFileList(
        path === "客户资料"
          ? [createFileNode({ path: "客户资料/合同", name: "合同", kind: "directory" })]
          : [createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" })],
      ),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(createDocumentList([]));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    const backButton = await screen.findByRole("button", { name: "后退" });
    const forwardButton = screen.getByRole("button", { name: "前进" });
    expect(backButton).toBeDisabled();
    expect(forwardButton).toBeDisabled();

    fireEvent.doubleClick(await screen.findByRole("button", { name: /客户资料/ }));
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料", 200));
    await userEvent.click(screen.getByRole("button", { name: "根目录" }));
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith(null, 200));

    await userEvent.click(backButton);
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料", 200));
    await userEvent.click(forwardButton);
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith(null, 200));
  });

  it("最多保留十条后退记录", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(createLibrarySnapshot());
    libraryApiMock.listLibraryFiles.mockImplementation(async (path: string | null) => {
      const depth = path ? path.split("/").length : 0;
      const nextPath = [...(path?.split("/") ?? []), `目录${depth + 1}`].join("/");
      return createFileList(
        depth < 12
          ? [createFileNode({ path: nextPath, name: `目录${depth + 1}`, kind: "directory" })]
          : [],
      );
    });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(createDocumentList([]));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    for (let depth = 0; depth < 12; depth += 1) {
      fireEvent.doubleClick(await screen.findByRole("button", { name: new RegExp(`目录${depth + 1}`) }));
      const expectedPath = Array.from({ length: depth + 1 }, (_, index) => `目录${index + 1}`).join("/");
      await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith(expectedPath, 200));
    }

    const backButton = screen.getByRole("button", { name: "后退" });
    for (let step = 0; step < 10; step += 1) {
      await userEvent.click(backButton);
      const expectedDepth = 11 - step;
      const expectedPath = Array.from({ length: expectedDepth }, (_, index) => `目录${index + 1}`).join("/");
      await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith(expectedPath, 200));
    }

    expect(backButton).toBeDisabled();
    expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("目录1/目录2", 200);
  });

  it("后退后进入新视图会清空旧的前进记录", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(createLibrarySnapshot());
    libraryApiMock.listLibraryFiles.mockImplementation(async (path: string | null) =>
      createFileList(
        path === "客户资料" || path === "项目资料"
          ? [createFileNode({ path: `${path}/子目录`, name: "子目录", kind: "directory" })]
          : [
              createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" }),
              createFileNode({ path: "项目资料", name: "项目资料", kind: "directory" }),
            ],
      ),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(createDocumentList([]));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    fireEvent.doubleClick(await screen.findByRole("button", { name: /客户资料/ }));
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料", 200));
    await userEvent.click(screen.getByRole("button", { name: "根目录" }));
    await userEvent.click(screen.getByRole("button", { name: "后退" }));
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料", 200));

    await userEvent.click(screen.getByRole("button", { name: "根目录" }));
    fireEvent.doubleClick(await screen.findByRole("button", { name: /项目资料/ }));
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("项目资料", 200));
    expect(screen.getByRole("button", { name: "前进" })).toBeDisabled();
  });

  it("返回上级后会保留来源文件夹高亮", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(createLibrarySnapshot());
    libraryApiMock.listLibraryFiles.mockImplementation(async (path: string | null) =>
      createFileList(
        path === "客户资料/合同"
          ? [createFileNode({ path: "客户资料/合同/归档", name: "归档", kind: "directory" })]
          : path === "客户资料"
            ? [createFileNode({ path: "客户资料/合同", name: "合同", kind: "directory" })]
            : [createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" })],
      ),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(createDocumentList([]));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    fireEvent.doubleClick(await screen.findByRole("button", { name: /客户资料/ }));
    fireEvent.doubleClick(await screen.findByRole("button", { name: /合同/ }));
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料/合同", 200));

    await userEvent.click(screen.getByRole("button", { name: "客户资料" }));
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料", 200));

    const sourceFolder = (await waitFor(() => {
      const row = document.querySelector<HTMLButtonElement>(".affairs-doc-item.grid.active");
      expect(row).not.toBeNull();
      return row as HTMLButtonElement;
    }));
    expect(sourceFolder).toHaveClass("active");
  });

  it("文档库设置可以切换文件夹单击/双击打开方式，并且单击打开会直接进入目录", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({ binding: createLibraryBinding({ folderOpenBehavior: "single_click" }) }),
    );
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "客户资料", name: "客户资料", kind: "directory" })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await userEvent.click(await screen.findByRole("button", { name: /客户资料/ }));
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料", 200));
  });

  it("详情区文档路径支持逐级点击跳转", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([
        createDocumentRecord({
          documentId: "doc-path",
          path: "客户资料/合同/报价.md",
          title: "摘要标题",
        }),
      ]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await userEvent.click(await screen.findByRole("button", { name: /报价\.md/ }));
    const detailPanel = screen.getByRole("complementary", { name: "详情" });
    await userEvent.click(await within(detailPanel).findByRole("button", { name: "合同" }));
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料/合同", 200));
  });
});
