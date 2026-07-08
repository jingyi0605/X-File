import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLibraryBinding,
  createLibraryConfig,
  createPluginListItem,
  createPluginListResult,
  installLibraryApiMock,
  libraryApiMock,
  resetLibraryApiMock,
} from "../../library/__tests__/mockLibraryApi";
import { initializeRuntimeConfig } from "../../../runtime/runtime-config-store";

installLibraryApiMock();

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

  it("HTTP 服务状态会区分已保存配置和实际运行态", async () => {
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
    });

    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /网络服务/ }));

    expect(screen.getByText("已保存监听地址")).toBeInTheDocument();
    expect(screen.getByText("已保存端口")).toBeInTheDocument();
    expect(screen.getByText("实际监听地址")).toBeInTheDocument();
    expect(screen.getByText("实际监听端口")).toBeInTheDocument();
    expect(screen.getByDisplayValue("17322")).toBeInTheDocument();
    expect(screen.getByText("17322")).toBeInTheDocument();
    expect(screen.getAllByText("未知").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("listen EADDRINUSE: address already in use 127.0.0.1:17321")).toBeInTheDocument();
  });

  it("集成页会展示插件注册表信息", async () => {
    libraryApiMock.listPlugins.mockResolvedValue(
      createPluginListResult({
        plugins: [createPluginListItem({
          manifest: {
            capabilities: ["provider.detect", "assistant.entry"],
            pluginType: "integration" as const,
            provider: {
              providerId: "codex",
              displayName: "Codex",
              command: "codex",
              auth: {
                strategy: "file_exists",
                path: "~/.codex/auth.json",
              },
            },
          },
        })],
      }),
    );

    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /集成服务/ }));
    expect(await screen.findByText("Codex Integration")).toBeInTheDocument();
    expect(screen.getByText("集成清单")).toBeInTheDocument();
    expect(screen.getByText("降级")).toBeInTheDocument();
    expect(screen.getByText("0.1.0")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Codex Integration" })).toHaveAttribute("aria-checked", "true");
  });

  it("集成页直接显示内置插件列表，并移除手工安装表单", async () => {
    libraryApiMock.listPlugins.mockResolvedValue(
      createPluginListResult({
        plugins: [createPluginListItem({
          manifest: {
            id: "codex",
            name: "Codex Integration",
            capabilities: ["provider.detect", "assistant.entry"],
            runtime: {
              install: {
                strategy: "system-cli" as const,
              },
            },
            provider: {
              providerId: "codex",
              displayName: "Codex",
              command: "codex",
              auth: {
                strategy: "file_exists",
                path: "~/.codex/auth.json",
              },
            },
          },
          registry: {
            pluginId: "codex",
            installDir: "/Applications/X-File.app/Contents/Resources/x-file-plugins/codex",
          },
          health: {
            status: "healthy",
          },
        })],
      }),
    );

    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /集成服务/ }));
    expect(screen.queryByPlaceholderText("/Users/you/Downloads/codex-plugin")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "安装插件" })).not.toBeInTheDocument();
    expect(await screen.findByText("内置插件数量")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(await screen.findByText("Codex Integration")).toBeInTheDocument();
    expect(screen.getByText("健康")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Codex Integration" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("switch", { name: "Codex Integration" }));

    await waitFor(() => {
      expect(libraryApiMock.disablePlugin).toHaveBeenCalledWith("codex");
    });
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
