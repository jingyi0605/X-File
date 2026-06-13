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

const tauriInvokeMock = vi.fn();
const tauriListenMock = vi.fn();

vi.doMock("@tauri-apps/api/core", () => ({
  invoke: tauriInvokeMock,
}));

vi.doMock("@tauri-apps/api/event", () => ({
  listen: tauriListenMock,
}));

const desktopPlatformData = {
  runtimePlatform: "desktop" as const,
  osFamily: "macos" as const,
  overlayTitlebar: false,
};

const webPlatformData = {
  runtimePlatform: "web" as const,
  osFamily: "web" as const,
  overlayTitlebar: false,
};

describe("第 3 批：macOS 原生右键菜单与桌面本地动作", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
    tauriInvokeMock.mockReset();
    tauriListenMock.mockReset();
    tauriListenMock.mockResolvedValue(vi.fn());
    tauriInvokeMock.mockResolvedValue({ supported: true, selectedActionId: null });
  });

  it("macOS 桌面端会优先使用原生右键菜单", async () => {
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ path: "docs/合同.md" })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={desktopPlatformData} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: /合同\.md/ }), { clientX: 24, clientY: 32 });

    await waitFor(() => {
      expect(tauriInvokeMock).toHaveBeenCalledWith("show_library_context_menu", expect.objectContaining({
        request: expect.objectContaining({ x: 24, y: 32 }),
      }));
    });
    expect(screen.queryByRole("menu", { name: "文档库菜单" })).not.toBeInTheDocument();
  });

  it("macOS 原生右键菜单点击删除后会先打开确认弹窗", async () => {
    tauriInvokeMock.mockResolvedValue({ supported: true, selectedActionId: "delete" });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ path: "docs/待删除.md" })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={desktopPlatformData} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: /待删除\.md/ }), { clientX: 10, clientY: 10 });

    expect(await screen.findByRole("heading", { name: "删除项目" })).toBeInTheDocument();
    expect(libraryApiMock.operateLibraryFile).not.toHaveBeenCalled();
  });

  it("桌面端空白处原生右键菜单会包含新建、刷新、粘贴和属性", async () => {
    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={desktopPlatformData} />);

    fireEvent.contextMenu(await screen.findByLabelText("文档列表"), { clientX: 50, clientY: 60 });

    await waitFor(() => expect(tauriInvokeMock).toHaveBeenCalled());
    const request = tauriInvokeMock.mock.calls.find(([command]) => command === "show_library_context_menu")?.[1]?.request;
    expect(request.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "新建" }),
      expect.objectContaining({ label: "刷新" }),
      expect.objectContaining({ label: "粘贴" }),
      expect.objectContaining({ label: "属性" }),
    ]));
  });

  it("macOS 原生右键菜单点击定位后会切到文件所在目录", async () => {
    tauriInvokeMock.mockResolvedValue({ supported: true, selectedActionId: "locate" });
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ path: "客户资料/合同/报价.md" })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={desktopPlatformData} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: /报价\.md/ }), { clientX: 10, clientY: 10 });

    await waitFor(() => {
      expect(libraryApiMock.listLibraryFiles).toHaveBeenLastCalledWith("客户资料/合同", 200);
    });
  });

  it("macOS 原生右键菜单点击使用本地应用程序打开会走镜像路径", async () => {
    tauriInvokeMock.mockImplementation(async (command) => {
      if (command === "show_library_context_menu") {
        return { supported: true, selectedActionId: "open-local-app" };
      }
      return null;
    });
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        binding: createLibraryBinding({ rootDir: "/remote/library", mirrorRoot: "/Users/test/Mirror" }),
      }),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ path: "客户资料/合同.docx" })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={desktopPlatformData} />);

    fireEvent.contextMenu(await screen.findByRole("button", { name: /合同\.docx/ }), { clientX: 10, clientY: 10 });

    await waitFor(() => {
      expect(tauriInvokeMock).toHaveBeenCalledWith("open_path", { path: "/Users/test/Mirror/客户资料/合同.docx" });
    });
  });

  it("详情区在有镜像路径时会提供本地文件动作，并显示完整元信息", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        binding: createLibraryBinding({ rootDir: "/remote/library", mirrorRoot: "/Users/test/Mirror" }),
      }),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ path: "客户资料/合同.docx", sizeBytes: 2048 })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={desktopPlatformData} />);

    await userEvent.click(await screen.findByRole("button", { name: /合同\.docx/ }));

    const detailPanel = screen.getByRole("complementary", { name: "详情" });
    expect(within(detailPanel).getByRole("button", { name: "使用本地应用打开" })).toBeInTheDocument();
    expect(within(detailPanel).getByText("本地镜像路径")).toBeInTheDocument();
    expect(within(detailPanel).getByText("/Users/test/Mirror/客户资料/合同.docx")).toBeInTheDocument();
    expect(within(detailPanel).getByText("大小")).toBeInTheDocument();
    expect(within(detailPanel).getByText("更新时间")).toBeInTheDocument();
  });

  it("详情区在没有镜像路径时会隐藏本地文件动作", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        binding: createLibraryBinding({ rootDir: "/remote/library", mirrorRoot: null }),
      }),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ path: "客户资料/合同.docx" })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={webPlatformData} />);

    await userEvent.click(await screen.findByRole("button", { name: /合同\.docx/ }));

    expect(screen.queryByRole("button", { name: "使用本地应用打开" })).not.toBeInTheDocument();
    expect(screen.queryByText("本地镜像路径")).not.toBeInTheDocument();
  });
});
