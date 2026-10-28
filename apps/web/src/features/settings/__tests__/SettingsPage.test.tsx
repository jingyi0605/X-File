import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLibraryBinding,
  createLibraryConfig,
  installLibraryApiMock,
  libraryApiMock,
  resetLibraryApiMock,
} from "../../library/__tests__/mockLibraryApi";
import { initializeRuntimeConfig } from "../../../runtime/runtime-config-store";

installLibraryApiMock();

vi.mock("../../../api/agent-integration", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../api/agent-integration")>(),
  getAgentIntegrationSettings: async () => ({
    enabled: false, apiKeyConfigured: false, updatedAt: null,
    executablePath: "/host/x-file", dataDir: "/host/.x-file", platform: "linux",
    capabilities: [{ name: "xfile_status", description: "读取应用状态", readOnly: true, destructive: false, requiresBinding: false }],
  }),
}));

const nativeBridgeMock = {
  clearNativeApplicationData: vi.fn(),
  requestNativeAppRestart: vi.fn(),
};

vi.mock("../../../runtime/native-library-bridge", async () => {
  const actual = await vi.importActual<typeof import("../../../runtime/native-library-bridge")>(
    "../../../runtime/native-library-bridge",
  );
  return {
    ...actual,
    clearNativeApplicationData: nativeBridgeMock.clearNativeApplicationData,
    requestNativeAppRestart: nativeBridgeMock.requestNativeAppRestart,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue("stable"),
}));

describe("SettingsPage 文档库索引配置迁移行为", () => {
  beforeEach(() => {
    localStorage.clear();
    initializeRuntimeConfig();
    resetLibraryApiMock();
    nativeBridgeMock.clearNativeApplicationData.mockReset();
    nativeBridgeMock.requestNativeAppRestart.mockReset();
    delete (window as typeof window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
  });

  it("外观设置只展示一次语言和主题标题，并保留控件的可访问名称", async () => {
    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await waitFor(() => expect(libraryApiMock.getHttpServerState).toHaveBeenCalled());
    expect(screen.getAllByText("语言")).toHaveLength(1);
    expect(screen.getAllByText("主题")).toHaveLength(1);
    expect(screen.getByRole("group", { name: "语言" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "主题" })).toBeInTheDocument();
    expect(screen.queryByText("选择界面显示语言。")).not.toBeInTheDocument();
  });

  it("集成设置只保留外部 Agent，不再请求或展示 OnlyOffice", async () => {
    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: "集成服务" }));
    expect(screen.queryByText(/OnlyOffice|ONLYOFFICE/)).not.toBeInTheDocument();
  });

  it("默认支持后缀保持原样保存时，仍提交空白名单让索引器走默认范围", async () => {
    libraryApiMock.getLibraryConfig.mockResolvedValue(
      createLibraryConfig({
        binding: createLibraryBinding({ allowedExtensions: [] }),
        allowedExtensions: [],
      }),
    );

    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    expect(await screen.findByRole("button", { name: ".docx" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "保存索引设置" }));

    await waitFor(() => {
      expect(libraryApiMock.saveLibraryConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedExtensions: [],
        }),
      );
    });
  });

  it("文档库设置可以切换文件夹单击打开方式并保存到配置", async () => {
    libraryApiMock.getLibraryConfig.mockResolvedValue(
      createLibraryConfig({
        binding: createLibraryBinding({ folderOpenBehavior: "double_click" }),
        folderOpenBehavior: "double_click",
      }),
    );

    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    expect(await screen.findByRole("button", { name: "双击打开" })).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByRole("button", { name: "单击打开" }));
    expect(screen.getByRole("button", { name: "单击打开" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "保存索引设置" }));

    await waitFor(() => {
      expect(libraryApiMock.saveLibraryConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          folderOpenBehavior: "single_click",
        }),
      );
    });
  });

  it("资料库设置默认隐藏点号路径和常见系统文件夹，并可关闭后保存", async () => {
    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    const dotFilesSwitch = await screen.findByRole("switch", { name: "隐藏以 . 开头的文件和文件夹" });
    const systemFoldersSwitch = screen.getByRole("switch", { name: "隐藏常见的系统和构建文件夹" });
    expect(dotFilesSwitch).toHaveAttribute("aria-checked", "true");
    expect(systemFoldersSwitch).toHaveAttribute("aria-checked", "true");

    await userEvent.click(dotFilesSwitch);
    await userEvent.click(systemFoldersSwitch);
    await userEvent.click(screen.getByRole("button", { name: "保存索引设置" }));

    await waitFor(() => {
      expect(libraryApiMock.saveLibraryConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          hideDotFiles: false,
          hideSystemFolders: false,
        }),
      );
    });
  });

  it("资料库页会展示运行模式字段，镜像模式可填写源端地址与本地镜像目录", async () => {
    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    expect(screen.getByRole("button", { name: "镜像模式" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "镜像模式" }));

    const apiInput = screen.getByPlaceholderText("http://127.0.0.1:17321");
    const mirrorInput = screen.getByPlaceholderText("/Users/you/X-File-Mirror");
    await userEvent.clear(apiInput);
    await userEvent.type(apiInput, "http://192.168.1.20:17321");
    await userEvent.type(mirrorInput, "/Users/test/X-File-Mirror");

    expect(screen.getByDisplayValue("http://192.168.1.20:17321")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("/Users/you/X-File-Mirror")).toHaveValue("/Users/test/X-File-Mirror");
  });

  it("标题后会显示当前运行模式标签，镜像模式下仍明确提示主服务端设置", async () => {
    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage onClose={() => undefined} />);

    expect((await screen.findAllByText("本地模式", { selector: ".settings-runtime-badge" })).length).toBeGreaterThan(0);

    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    await userEvent.click(screen.getByRole("button", { name: "镜像模式" }));

    expect(screen.getAllByText("镜像模式", { selector: ".settings-runtime-badge" }).length).toBeGreaterThan(0);

    const configOwnerNotice = screen.getByText("主服务端设置").closest(".settings-remote-owner-note");
    expect(configOwnerNotice).toHaveAttribute("data-tone", "danger");
    expect(
      screen.getByText(
        "你当前在镜像模式下编辑的是主服务端的索引范围配置。保存后会通过镜像连接写入源端本地模式实例，不是写到镜像端本机。",
      ),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /网络服务/ }));
    expect(
      screen.getByText(
        "你当前在镜像模式下编辑的是主服务端的 HTTP 服务配置。保存后会作用到源端本地模式实例，不是镜像端本机。",
      ),
    ).toBeInTheDocument();
  });

  it("HTTP 服务设置不展示内部监听生命周期调试信息", async () => {
    libraryApiMock.getHttpServerState.mockResolvedValue({
      enabled: true,
      host: "127.0.0.1",
      port: 17322,
      running: false,
      persistent: true,
      actualHost: null,
      actualPort: null,
      lifecycleState: "failed",
      startedAt: null,
      lastError: "listen EADDRINUSE: address already in use 127.0.0.1:17321",
      authEnabled: false,
      authConfigured: false,
      authUsername: null,
    });

    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /网络服务/ }));

    expect(screen.getByDisplayValue("17322")).toBeInTheDocument();
    expect(screen.queryByText("已保存监听地址")).not.toBeInTheDocument();
    expect(screen.queryByText("实际监听地址")).not.toBeInTheDocument();
    expect(screen.queryByText("生命周期")).not.toBeInTheDocument();
    expect(screen.queryByText("listen EADDRINUSE: address already in use 127.0.0.1:17321")).not.toBeInTheDocument();
  });

  it("未保存局域网认证凭据前不允许选择局域网监听地址", async () => {
    const configuredState = {
      enabled: true,
      host: "127.0.0.1",
      port: 17321,
      running: false,
      persistent: false,
      actualHost: null,
      actualPort: null,
      lifecycleState: "disabled" as const,
      startedAt: null,
      lastError: null,
      authEnabled: false,
      authConfigured: true,
      authUsername: "lan-user",
    };
    libraryApiMock.getHttpServerState.mockResolvedValue({
      ...configuredState,
      authConfigured: false,
      authUsername: null,
    });
    libraryApiMock.saveHttpServerState.mockResolvedValue(configuredState);

    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /网络服务/ }));

    const hostSelect = screen.getByLabelText("监听地址");
    const allInterfaces = screen.getByRole("option", { name: "所有网卡（0.0.0.0） (0.0.0.0)" });
    expect(allInterfaces).toBeDisabled();
    await userEvent.selectOptions(hostSelect, "0.0.0.0");
    expect(hostSelect).toHaveValue("127.0.0.1");

    await userEvent.type(screen.getByLabelText("用户名"), "lan-user");
    await userEvent.type(screen.getByLabelText("密码"), "long-enough-password");
    await userEvent.click(screen.getByRole("button", { name: "保存服务设置" }));

    await waitFor(() => expect(libraryApiMock.saveHttpServerState).toHaveBeenCalledWith({
      enabled: true,
      persistent: false,
      host: "127.0.0.1",
      port: 17321,
      authEnabled: false,
      authUsername: "lan-user",
      authPassword: "long-enough-password",
    }));

    expect(screen.getByRole("option", { name: "所有网卡（0.0.0.0） (0.0.0.0)" })).toBeEnabled();
    await userEvent.selectOptions(hostSelect, "0.0.0.0");
    expect(hostSelect).toHaveValue("0.0.0.0");
    expect(screen.queryByText("启用局域网访问认证")).not.toBeInTheDocument();
    expect(screen.getByText("选择非 127.0.0.1 监听地址后，局域网认证会强制启用，不能手动关闭。")).toBeInTheDocument();
  });

  it("HTTP 服务可以选择网卡，并展示可复制的局域网访问地址", async () => {
    const runningState = {
      enabled: true,
      host: "0.0.0.0",
      port: 3010,
      running: true,
      persistent: true,
      actualHost: "0.0.0.0",
      actualPort: 3010,
      lifecycleState: "running" as const,
      startedAt: "2026-10-27T00:00:00.000Z",
      lastError: null,
      authEnabled: true,
      authConfigured: true,
      authUsername: "lan-user",
      hostOptions: [
        { value: "0.0.0.0", interfaceName: null },
        { value: "127.0.0.1", interfaceName: null },
        { value: "192.168.1.20", interfaceName: "Wi-Fi" },
      ],
      accessUrls: ["http://192.168.1.20:3010/"],
    };
    libraryApiMock.getHttpServerState.mockResolvedValue(runningState);
    libraryApiMock.saveHttpServerState.mockResolvedValue(runningState);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /网络服务/ }));

    const hostSelect = screen.getByLabelText("监听地址");
    expect(screen.getByRole("option", { name: "Wi-Fi (192.168.1.20)" })).toBeInTheDocument();
    await userEvent.selectOptions(hostSelect, "192.168.1.20");
    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("http://192.168.1.20:3010/"));

    await userEvent.click(screen.getByRole("button", { name: "保存服务设置" }));
    await waitFor(() => expect(libraryApiMock.saveHttpServerState).toHaveBeenCalledWith({
      enabled: true,
      persistent: true,
      host: "192.168.1.20",
      port: 3010,
      authEnabled: true,
    }));
  });

  it("已有认证时修改密码会同时提交当前用户名", async () => {
    const configuredState = {
      enabled: true,
      host: "127.0.0.1",
      port: 17321,
      running: false,
      persistent: false,
      actualHost: null,
      actualPort: null,
      lifecycleState: "disabled" as const,
      startedAt: null,
      lastError: null,
      authEnabled: false,
      authConfigured: true,
      authUsername: "lan-user",
    };
    libraryApiMock.getHttpServerState.mockResolvedValue(configuredState);
    libraryApiMock.saveHttpServerState.mockResolvedValue(configuredState);

    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /网络服务/ }));
    await userEvent.type(screen.getByLabelText("密码"), "replacement-password");
    await userEvent.click(screen.getByRole("button", { name: "保存服务设置" }));

    await waitFor(() => expect(libraryApiMock.saveHttpServerState).toHaveBeenCalledWith({
      enabled: true,
      persistent: false,
      host: "127.0.0.1",
      port: 17321,
      authEnabled: false,
      authUsername: "lan-user",
      authPassword: "replacement-password",
    }));
  });

  it("集成页不再提供 OnlyOffice 或内置助手插件管理", async () => {
    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /集成服务/ }));
    expect(screen.queryByRole("heading", { name: "OnlyOffice" })).not.toBeInTheDocument();
    expect(screen.queryByText("内置插件数量")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Codex|Claude/ })).not.toBeInTheDocument();
  });

  it("更新页必须经过三次确认后才会触发彻底重置", async () => {
    (window as typeof window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    nativeBridgeMock.clearNativeApplicationData.mockResolvedValue({
      dataDir: "/Users/test/.x-file",
      appDataDir: "/Users/test/Library/Application Support/X-File",
      clearedLibraryIndexDir: "/Users/test/Documents/.ai-index",
    });
    nativeBridgeMock.requestNativeAppRestart.mockResolvedValue(true);
    localStorage.setItem("x-file.runtime.config", JSON.stringify({ mode: "mirror" }));

    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /更新/ }));
    await userEvent.click(screen.getByRole("button", { name: "彻底重置应用" }));

    expect(screen.getByText("确认步骤 1/3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "我知道这会清空应用数据" }));
    expect(screen.getByText("确认步骤 2/3")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "继续，准备最终确认" }));
    expect(screen.getByText("确认步骤 3/3")).toBeInTheDocument();

    const submitButton = screen.getByRole("button", { name: "立即彻底重置" });
    expect(submitButton).toBeDisabled();

    await userEvent.type(screen.getByLabelText("确认短语"), "重置 X-File");
    await userEvent.click(submitButton);

    await waitFor(() => {
      expect(nativeBridgeMock.clearNativeApplicationData).toHaveBeenCalledTimes(1);
    });
    expect(nativeBridgeMock.requestNativeAppRestart).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("x-file.runtime.config")).toBeNull();
  });
});
