import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    expect(screen.getByText("目录详情")).toBeInTheDocument();
    expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith(null, 200);

    fireEvent.doubleClick(folder);
    await waitFor(() => {
      expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料", 200);
    });
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
    expect(await screen.findByRole("button", { name: /客户资料/ })).toBeInTheDocument();
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

    const sourceFolder = await screen.findByRole("button", { name: /合同/ });
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
    const pathRow = screen.getByTestId("library-detail-path-row");
    expect(within(pathRow).getByRole("button", { name: "客户资料" })).toBeInTheDocument();
    expect(within(pathRow).getByRole("button", { name: "合同" })).toBeInTheDocument();
    expect(within(pathRow).getByText("报价.md")).toBeInTheDocument();

    await userEvent.click(within(pathRow).getByRole("button", { name: "合同" }));
    await waitFor(() => expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料/合同", 200));
  });
});
