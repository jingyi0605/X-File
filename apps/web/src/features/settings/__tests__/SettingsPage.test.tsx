import { render, screen, waitFor, within } from "@testing-library/react";
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
    enabled: false, apiKeyConfigured: false, accessMode: "read_only", updatedAt: null,
    executablePath: "/host/x-file", dataDir: "/host/.x-file", platform: "linux",
    capabilities: [{ name: "xfile_status", description: "读取应用状态", readOnly: true, destructive: false, requiresBinding: false }],
  }),
}));

const nativeBridgeMock = {
  clearNativeApplicationData: vi.fn(),
  requestNativeAppRestart: vi.fn(),
  saveNativeLibraryBackup: vi.fn(),
};

vi.mock("../../../runtime/native-library-bridge", async () => {
  const actual = await vi.importActual<typeof import("../../../runtime/native-library-bridge")>(
    "../../../runtime/native-library-bridge",
  );
  return {
    ...actual,
    clearNativeApplicationData: nativeBridgeMock.clearNativeApplicationData,
    requestNativeAppRestart: nativeBridgeMock.requestNativeAppRestart,
    saveNativeLibraryBackup: nativeBridgeMock.saveNativeLibraryBackup,
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
    nativeBridgeMock.saveNativeLibraryBackup.mockReset();
    nativeBridgeMock.saveNativeLibraryBackup.mockResolvedValue(true);
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

  it("允许索引的扩展名按类型标签页分组展示，并保留自定义扩展名", async () => {
    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    await userEvent.click(screen.getByRole("tab", { name: "图片" }));
    expect(screen.getByRole("button", { name: ".png" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ".docx" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "文本与代码" }));
    expect(screen.getByRole("button", { name: ".ts" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: ".png" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "其他" }));
    await userEvent.type(screen.getByPlaceholderText(".epub"), ".epub");
    await userEvent.click(screen.getByRole("button", { name: "添加扩展名" }));
    expect(screen.getByRole("button", { name: ".epub 自定义" })).toBeInTheDocument();
  });

  it("扩展名向导按行业和工作性质生成模板，并只回填当前表单", async () => {
    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    await userEvent.click(screen.getByRole("button", { name: "快速选模板" }));

    const dialog = await screen.findByRole("dialog", { name: "快速索引模板" });
    const industryGroup = within(dialog).getByRole("group", { name: "选择行业" });
    const workGroup = within(dialog).getByRole("group", { name: "选择工作性质" });
    expect(within(industryGroup).getAllByRole("checkbox")).toHaveLength(12);
    expect(within(workGroup).getAllByRole("checkbox")).toHaveLength(16);
    await userEvent.click(within(industryGroup).getByRole("checkbox", { name: /互联网/ }));
    await userEvent.click(within(industryGroup).getByRole("checkbox", { name: /政府机关/ }));
    await userEvent.click(within(workGroup).getByRole("checkbox", { name: /程序员/ }));
    await userEvent.click(within(workGroup).getByRole("checkbox", { name: /数据分析师/ }));
    expect(within(industryGroup).getByRole("checkbox", { name: /互联网/ })).toHaveAttribute("aria-checked", "true");
    expect(within(industryGroup).getByRole("checkbox", { name: /政府机关/ })).toHaveAttribute("aria-checked", "true");
    expect(within(workGroup).getByRole("checkbox", { name: /程序员/ })).toHaveAttribute("aria-checked", "true");
    expect(within(workGroup).getByRole("checkbox", { name: /数据分析师/ })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(dialog).getByRole("button", { name: ".ts" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "应用模板" }));

    expect(screen.queryByRole("dialog", { name: "快速索引模板" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: ".json" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: ".ts" })).toHaveAttribute("aria-pressed", "false");
    expect(libraryApiMock.saveLibraryConfig).not.toHaveBeenCalled();
    expect(screen.getByText("索引模板已应用到当前表单，请保存索引设置。")).toBeInTheDocument();
  });

  it("重新打开扩展名向导时恢复上次的行业、工作性质和扩展名调整", async () => {
    const { SettingsPage } = await import("../SettingsPage");
    const firstRender = render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    await userEvent.click(screen.getByRole("button", { name: "快速选模板" }));
    const firstDialog = await screen.findByRole("dialog", { name: "快速索引模板" });
    await userEvent.click(within(firstDialog).getByRole("checkbox", { name: /政府机关/ }));
    await userEvent.click(within(firstDialog).getByRole("checkbox", { name: /设计师/ }));
    await userEvent.click(within(firstDialog).getByRole("button", { name: ".jpg" }));
    await userEvent.click(within(firstDialog).getByRole("button", { name: "关闭" }));
    firstRender.unmount();

    render(<SettingsPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    await userEvent.click(screen.getByRole("button", { name: "快速选模板" }));
    const secondDialog = await screen.findByRole("dialog", { name: "快速索引模板" });

    expect(within(secondDialog).getByRole("checkbox", { name: /政府机关/ })).toHaveAttribute("aria-checked", "true");
    expect(within(secondDialog).getByRole("checkbox", { name: /设计师/ })).toHaveAttribute("aria-checked", "true");
    expect(within(secondDialog).getByRole("button", { name: ".jpg" })).toHaveAttribute("aria-pressed", "false");
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

  it("文档库设置说明父标签展开和数量筛选方式", async () => {
    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    expect(screen.getByText("标签树筛选方式")).toBeInTheDocument();
    expect(screen.getByText("父标签单击展开/收起；点击文件数量筛选标签。")).toBeInTheDocument();
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

  it("标题后会显示当前运行模式标签，镜像模式保留完整分类导航", async () => {
    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage onClose={() => undefined} />);

    expect((await screen.findAllByText("本地模式", { selector: ".settings-runtime-badge" })).length).toBeGreaterThan(0);

    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    await userEvent.click(screen.getByRole("button", { name: "镜像模式" }));

    expect(screen.getAllByText("镜像模式", { selector: ".settings-runtime-badge" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("tab", { name: "外观" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "资料库" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "集成服务" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "网络服务" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "更新" })).toBeInTheDocument();

    expect(screen.queryByText("主服务端设置")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /网络服务/ }));
    expect(screen.queryByText("主服务端设置")).not.toBeInTheDocument();
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

  it("桌面本地资料库支持导出和在确认后导入备份", async () => {
    (window as typeof window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = {};
    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    await userEvent.click(await screen.findByRole("button", { name: "导出备份" }));
    await waitFor(() => expect(libraryApiMock.getLibraryBackup).toHaveBeenCalledTimes(1));
    expect(nativeBridgeMock.saveNativeLibraryBackup).toHaveBeenCalledWith(
      expect.stringContaining('"format": "x-file-library-backup"'),
      "x-file-backup-2026-10-29.json",
    );
    expect(await screen.findByRole("status")).toHaveTextContent("资料库备份已导出。");

    const file = new File([JSON.stringify({ format: "x-file-library-backup" })], "backup.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => JSON.stringify({ format: "x-file-library-backup" }) });
    await userEvent.upload(screen.getByLabelText("选择资料库备份文件"), file);
    expect(await screen.findByRole("dialog", { name: "确认恢复资料库备份" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(libraryApiMock.restoreLibraryBackup).not.toHaveBeenCalled();
    await userEvent.upload(screen.getByLabelText("选择资料库备份文件"), file);
    await userEvent.click(screen.getByRole("button", { name: "确认导入" }));
    await waitFor(() => expect(libraryApiMock.restoreLibraryBackup).toHaveBeenCalledTimes(1));
    expect(libraryApiMock.restoreLibraryBackup).toHaveBeenCalledWith({ format: "x-file-library-backup" });
    expect(await screen.findByText(/已恢复 0 个标签和 0 条索引记录/)).toBeInTheDocument();
  });

  it("镜像模式显示备份入口并调用远端资料库备份 API", async () => {
    localStorage.setItem("x-file.runtime.config", JSON.stringify({ mode: "mirror", remoteApiBaseUrl: "http://localhost" }));
    initializeRuntimeConfig();
    const clickLink = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn().mockReturnValue("blob:mirror-backup") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    await userEvent.click(await screen.findByRole("button", { name: "导出备份" }));
    expect(libraryApiMock.getLibraryBackup).toHaveBeenCalledTimes(1);
    clickLink.mockRestore();
  });

  it("浏览器 Web 环境显示备份入口并使用 HTTP API", async () => {
    expect("__TAURI_INTERNALS__" in window).toBe(false);
    const clickLink = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn().mockReturnValue("blob:web-backup") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);
    await userEvent.click(await screen.findByRole("tab", { name: /资料库/ }));
    await userEvent.click(await screen.findByRole("button", { name: "导出备份" }));
    expect(libraryApiMock.getLibraryBackup).toHaveBeenCalledTimes(1);
    clickLink.mockRestore();
  });
});
