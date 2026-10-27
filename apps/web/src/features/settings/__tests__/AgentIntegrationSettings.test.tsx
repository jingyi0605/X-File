import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentIntegrationSettings as Settings } from "@x-file/shared";

import { AgentIntegrationSettings, buildAgentExamples } from "../AgentIntegrationSettings";
import { getAgentIntegrationSettings, saveAgentIntegrationSettings } from "../../../api/agent-integration";
import { ApiClientError } from "../../../api/http";
import { initializeRuntimeConfig, updateRuntimeConfig } from "../../../runtime/runtime-config-store";

vi.mock("../../../api/agent-integration", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../api/agent-integration")>(),
  getAgentIntegrationSettings: vi.fn(),
  saveAgentIntegrationSettings: vi.fn(),
}));

const initial: Settings = {
  enabled: false,
  apiKeyConfigured: false,
  updatedAt: null,
  executablePath: "/Applications/X-File.app/Contents/MacOS/x-file-desktop",
  dataDir: "/Users/example/.x-file",
  platform: "macos",
  capabilities: [
    {
      name: "xfile_status", description: "读取应用状态。", readOnly: true,
      destructive: false, requiresBinding: false, parameters: [],
    },
    {
      name: "xfile_file_operation", description: "创建、移动或删除文件。", readOnly: false,
      destructive: true, requiresBinding: true,
      parameters: [{
        name: "opType", valueType: "string", required: true,
        description: "需要执行的文件操作。", allowedValues: ["create_file", "delete"],
      }],
    },
  ],
};

describe("外部 Agent 接入设置", () => {
  beforeEach(() => {
    localStorage.clear();
    initializeRuntimeConfig();
    vi.resetAllMocks();
    vi.mocked(getAgentIntegrationSettings).mockResolvedValue(initial);
  });

  it("先生成密钥再启用，配置示例不包含明文，撤销会关闭接入", async () => {
    const user = userEvent.setup();
    const key = "xf_generated-key-with-at-least-thirty-two-characters";
    const keyed = { ...initial, apiKeyConfigured: true };
    vi.mocked(saveAgentIntegrationSettings)
      .mockResolvedValueOnce({ settings: keyed, apiKey: key })
      .mockResolvedValueOnce({ settings: { ...keyed, enabled: true } })
      .mockResolvedValueOnce({ settings: initial });
    render(<AgentIntegrationSettings />);

    const toggle = await screen.findByRole("switch", { name: "启用外部 Agent 接入" });
    const keyInput = screen.getByLabelText("API Key 输入");
    expect(toggle).toBeDisabled();
    expect(screen.queryByRole("button", { name: "复制新密钥" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "生成 API Key" }));
    expect(saveAgentIntegrationSettings).toHaveBeenLastCalledWith({ generateApiKey: true });
    expect(screen.getByLabelText("API Key 输入")).toBe(keyInput);
    expect(keyInput).toHaveValue(key);
    expect(keyInput).toHaveAttribute("type", "text");
    expect(keyInput).toHaveFocus();
    expect((keyInput as HTMLInputElement).selectionStart).toBe(0);
    expect((keyInput as HTMLInputElement).selectionEnd).toBe(key.length);
    expect(screen.getAllByLabelText("API Key 输入")).toHaveLength(1);
    const copyButton = screen.getByRole("button", { name: "复制新密钥" });
    expect(keyInput.parentElement).toContainElement(copyButton);
    expect(copyButton.querySelector("svg")).toBeInTheDocument();
    expect(copyButton.textContent).toBe("");
    expect(screen.queryByRole("button", { name: "关闭密钥显示" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存 API Key" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "查看配置方式" }));
    const configModal = screen.getByRole("dialog", { name: "推荐配置方式" });
    const mcp = within(configModal).getByLabelText("MCP 客户端配置（JSON）");
    const config = JSON.parse(mcp.textContent!);
    expect(config.mcpServers["x-file"].command).toBe(initial.executablePath);
    expect(config.mcpServers["x-file"].args).toEqual(["mcp", "--data-dir", initial.dataDir, "--read-only"]);
    expect(mcp.textContent).not.toContain(key);
    await user.click(configModal.querySelector(".desktop-modal-footer button")!);

    await user.tab();
    expect(keyInput).toHaveAttribute("type", "password");
    expect(keyInput).toHaveValue(key);
    await user.click(keyInput);
    expect(keyInput).toHaveAttribute("type", "password");
    expect(screen.getByRole("button", { name: "保存 API Key" })).toBeDisabled();

    const disclosure = screen.getByRole("button", { name: "外部 Agent 接入" });
    await user.click(disclosure);
    expect(keyInput).not.toBeVisible();
    expect(toggle).toBeVisible();
    await user.click(toggle);
    expect(saveAgentIntegrationSettings).toHaveBeenLastCalledWith({ enabled: true });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByDisplayValue(key)).not.toBeInTheDocument();
    await user.click(disclosure);
    await user.click(screen.getByRole("button", { name: "撤销密钥并关闭接入" }));
    expect(saveAgentIntegrationSettings).toHaveBeenLastCalledWith({ clearApiKey: true });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(toggle).toBeDisabled();
    expect(keyInput).toHaveValue("");
    expect(keyInput).not.toHaveAttribute("placeholder");
    expect(screen.queryByRole("button", { name: "复制新密钥" })).not.toBeInTheDocument();
  });

  it("输入框右侧图标可复制实际密钥，遮罩后仍可复制并支持失败重试", async () => {
    const user = userEvent.setup();
    const key = "xf_generated-key-with-at-least-thirty-two-characters";
    vi.mocked(saveAgentIntegrationSettings).mockResolvedValue({
      settings: { ...initial, apiKeyConfigured: true },
      apiKey: key,
    });
    const clipboard = vi.spyOn(navigator.clipboard, "writeText");
    render(<AgentIntegrationSettings />);
    await user.click(await screen.findByRole("button", { name: "生成 API Key" }));
    const input = screen.getByLabelText("API Key 输入");
    const copyButton = screen.getByRole("button", { name: "复制新密钥" });
    const copyIconPath = copyButton.querySelector("path")!.getAttribute("d")!;

    await user.click(copyButton);
    expect(clipboard).toHaveBeenLastCalledWith(key);
    expect(await screen.findByRole("status")).toHaveTextContent("已复制");
    expect(copyButton).toHaveAttribute("data-copied", "true");
    expect(copyButton).toHaveAccessibleName("已复制。");
    expect(copyButton).toHaveAttribute("title", "已复制。");
    expect(copyButton.querySelector("path")).not.toHaveAttribute("d", copyIconPath);
    expect(input).toHaveAttribute("type", "password");
    expect(saveAgentIntegrationSettings).toHaveBeenCalledTimes(1);

    clipboard.mockRejectedValueOnce(new Error("denied"));
    await user.click(copyButton);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法访问剪贴板");
    expect(copyButton).not.toHaveAttribute("data-copied", "true");
    expect(copyButton).toHaveAccessibleName("复制新密钥");
    expect(copyButton.querySelector("path")).toHaveAttribute("d", copyIconPath);
    expect(input).toHaveValue(key);
    await user.click(copyButton);
    expect(clipboard).toHaveBeenLastCalledWith(key);
    expect(await screen.findByRole("status")).toHaveTextContent("已复制");
    expect(copyButton).toHaveAttribute("data-copied", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("重新打开设置仅显示已配置遮罩，不读取或恢复旧密钥", async () => {
    const user = userEvent.setup();
    const key = "xf_generated-key-with-at-least-thirty-two-characters";
    const keyed = { ...initial, apiKeyConfigured: true };
    vi.mocked(saveAgentIntegrationSettings).mockResolvedValue({ settings: keyed, apiKey: key });
    const view = render(<AgentIntegrationSettings />);
    await user.click(await screen.findByRole("button", { name: "生成 API Key" }));
    expect(screen.getByLabelText("API Key 输入")).toHaveAttribute("type", "text");
    view.unmount();

    vi.mocked(getAgentIntegrationSettings).mockResolvedValue(keyed);
    render(<AgentIntegrationSettings />);
    const input = await screen.findByLabelText("API Key 输入");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "\u2022".repeat(12));
    expect(screen.queryByDisplayValue(key)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存 API Key" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "复制新密钥" })).not.toBeInTheDocument();
  });

  it("重新生成复用原输入框，自定义替换后恢复密码输入和保存", async () => {
    const user = userEvent.setup();
    const firstKey = "xf_first-generated-key-with-at-least-thirty-two-characters";
    const nextKey = "xf_next-generated-key-with-at-least-thirty-two-characters";
    const customKey = "custom-key-with-at-least-thirty-two-characters";
    const keyed = { ...initial, apiKeyConfigured: true };
    const clipboard = vi.spyOn(navigator.clipboard, "writeText");
    vi.mocked(saveAgentIntegrationSettings)
      .mockResolvedValueOnce({ settings: keyed, apiKey: firstKey })
      .mockResolvedValueOnce({ settings: keyed, apiKey: nextKey })
      .mockResolvedValueOnce({ settings: keyed });
    render(<AgentIntegrationSettings />);
    await user.click(await screen.findByRole("button", { name: "生成 API Key" }));
    const input = screen.getByLabelText("API Key 输入");
    await user.click(screen.getByRole("button", { name: "复制新密钥" }));
    expect(screen.getByRole("button", { name: "已复制。" })).toHaveAttribute("data-copied", "true");
    await user.click(screen.getByRole("button", { name: "重新生成 API Key" }));
    expect(input).toHaveValue(nextKey);
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveFocus();
    expect(screen.queryByDisplayValue(firstKey)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制新密钥" })).not.toHaveAttribute("data-copied", "true");
    await user.click(screen.getByRole("button", { name: "复制新密钥" }));
    expect(clipboard).toHaveBeenLastCalledWith(nextKey);

    await user.clear(input);
    await user.type(input, customKey);
    expect(input).toHaveAttribute("type", "password");
    expect(screen.queryByRole("button", { name: "复制新密钥" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "保存 API Key" }));
    expect(saveAgentIntegrationSettings).toHaveBeenLastCalledWith({ apiKey: customKey });
    await waitFor(() => expect(input).toHaveValue(""));
    expect(input).toHaveAttribute("placeholder", "\u2022".repeat(12));
  });

  it("自定义密钥保存失败会保留当前开关状态并展示错误", async () => {
    const user = userEvent.setup();
    vi.mocked(saveAgentIntegrationSettings).mockRejectedValue(new Error("写入失败"));
    render(<AgentIntegrationSettings />);
    const input = await screen.findByLabelText("API Key 输入");
    await user.type(input, "custom-key-with-at-least-thirty-two-characters");
    const disclosure = screen.getByRole("button", { name: "外部 Agent 接入" });
    await user.click(disclosure);
    expect(input).not.toBeVisible();
    expect(saveAgentIntegrationSettings).not.toHaveBeenCalled();
    await user.click(disclosure);
    expect(input).toHaveValue("custom-key-with-at-least-thirty-two-characters");
    await user.click(screen.getByRole("button", { name: "保存 API Key" }));
    expect(saveAgentIntegrationSettings).toHaveBeenCalledWith({
      apiKey: "custom-key-with-at-least-thirty-two-characters",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("写入失败");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("能力页以表格列出工具权限、说明和调用参数", async () => {
    const user = userEvent.setup();
    render(<AgentIntegrationSettings />);
    await screen.findByRole("switch");
    for (const title of ["API Key", "推荐配置方式"]) {
      expect(screen.getByRole("heading", { name: title })).toBeVisible();
      expect(screen.queryByRole("button", { name: title })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("heading", { name: "SKILL 安装说明" })).not.toBeInTheDocument();
    expect(screen.queryByText("默认关闭。请先配置 API Key；关闭后，已有连接的后续工具调用也会被拒绝。")).not.toBeInTheDocument();
    expect(screen.queryByText("推荐使用本机 MCP stdio，将下方对象合并到 Agent 客户端配置。把占位符替换为密钥，优先使用客户端的密钥或环境变量管理。CLI 适用于脚本调用；未提供远程 HTTP MCP 服务。")).not.toBeInTheDocument();
    expect(screen.queryByText("设置新的 API Key（32 至 512 位，无空白 ASCII 字符）")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看配置方式" }));
    const modal = screen.getByRole("dialog", { name: "推荐配置方式" });
    const configurationTab = within(modal).getByRole("tab", { name: "配置方式" });
    const capabilitiesTab = within(modal).getByRole("tab", { name: "MCP 能力" });
    expect(configurationTab).toHaveAttribute("aria-selected", "true");
    expect(capabilitiesTab).toHaveAttribute("aria-selected", "false");
    expect(modal).toBeInTheDocument();
    expect(screen.getByLabelText("MCP 客户端配置（JSON）")).toBeVisible();
    expect(screen.getByLabelText("安装命令")).toBeVisible();
    expect(screen.getByRole("heading", { name: "SKILL 安装说明" })).toBeVisible();
    expect(screen.getByText(/下方命令将内嵌 SKILL 导出到/)).toBeVisible();
    expect(screen.queryByRole("list", { name: "MCP 能力" })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("配置示例的访问权限"), "write");
    expect(screen.getByLabelText("MCP 客户端配置（JSON）")).not.toHaveTextContent("--read-only");
    const clipboard = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(within(modal).getAllByRole("button", { name: "复制" })[0]!);
    expect(clipboard).toHaveBeenCalledWith(expect.stringContaining('"mcpServers"'));
    clipboard.mockRejectedValueOnce(new Error("denied"));
    await user.click(within(modal).getAllByRole("button", { name: "复制" })[1]!);
    expect(await screen.findByRole("alert")).toHaveTextContent("无法访问剪贴板");
    await user.click(capabilitiesTab);
    expect(capabilitiesTab).toHaveAttribute("aria-selected", "true");
    expect(configurationTab).toHaveAttribute("aria-selected", "false");
    const table = screen.getByRole("table", { name: "MCP 能力" });
    expect(within(table).getByRole("columnheader", { name: "工具名称" })).toBeVisible();
    expect(within(table).getByRole("columnheader", { name: "权限" })).toBeVisible();
    expect(within(table).getByRole("columnheader", { name: "能力说明" })).toBeVisible();
    expect(within(table).getByRole("columnheader", { name: "调用参数" })).toBeVisible();
    const statusRow = within(table).getByRole("row", { name: /xfile_status/ });
    expect(within(statusRow).getByText("只读")).toBeVisible();
    expect(within(statusRow).getByText("读取应用状态。")).toBeVisible();
    expect(within(statusRow).getByText("无需参数")).toBeVisible();
    const fileRow = within(table).getByRole("row", { name: /xfile_file_operation/ });
    expect(within(fileRow).getByText("可写")).toBeVisible();
    expect(within(fileRow).getByText("需要资料库")).toBeVisible();
    expect(within(fileRow).getByText("opType")).toBeVisible();
    expect(within(fileRow).getByText("string")).toBeVisible();
    expect(within(fileRow).getByText("必填")).toBeVisible();
    expect(within(fileRow).getByText("可选值：create_file, delete")).toBeVisible();
    expect(screen.getByText("可能有破坏性")).toBeVisible();
    expect(screen.queryByLabelText("MCP 客户端配置（JSON）")).not.toBeInTheDocument();
    await user.click(configurationTab);
    await user.click(within(modal).getAllByRole("button", { name: "复制" })[2]!);
    expect(clipboard).toHaveBeenCalledWith(expect.stringContaining("cli skill"));
    await user.click(modal.querySelector(".desktop-modal-footer button")!);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "查看配置方式" }));
    expect(await screen.findByRole("status")).toHaveTextContent("已复制");
  });

  it("镜像管理显示目标主机；切换主机清除一次性密钥并丢弃旧响应", async () => {
    await updateRuntimeConfig({ mode: "mirror", remoteApiBaseUrl: "https://primary.example.com" });
    vi.mocked(getAgentIntegrationSettings).mockRejectedValueOnce(new ApiClientError("", 401, "请先登录后访问 X-File"));
    const view = render(<AgentIntegrationSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("请先登录");
    expect(screen.getByText(/当前管理的是远端资料库主机/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "重试读取" }));
    await screen.findByRole("switch");
    expect(getAgentIntegrationSettings).toHaveBeenLastCalledWith();
    let completeSave!: (value: { settings: Settings; apiKey: string }) => void;
    vi.mocked(saveAgentIntegrationSettings).mockImplementationOnce(() => new Promise((resolve) => { completeSave = resolve; }));
    await userEvent.click(screen.getByRole("button", { name: "生成 API Key" }));
    expect(saveAgentIntegrationSettings).toHaveBeenLastCalledWith({ generateApiKey: true });
    await act(() => updateRuntimeConfig({ remoteApiBaseUrl: "https://other.example.com" }));
    await screen.findByRole("switch");
    await act(async () => completeSave({ settings: initial, apiKey: "old-host-generated-key" }));
    expect(screen.getByLabelText("API Key 输入")).toHaveValue("");
    expect(localStorage.getItem("x-file.runtime.config")).not.toContain("management-token");
  });

  it("旧主机接口缺失时显示升级提示并可重试", async () => {
    const user = userEvent.setup();
    vi.mocked(getAgentIntegrationSettings).mockRejectedValueOnce(new ApiClientError("", 404, "not found"));
    render(<AgentIntegrationSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("请更新主机服务");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "重试读取" }));
    expect(await screen.findByRole("switch")).toBeInTheDocument();
  });

  it("Windows 使用 PowerShell 转义且路径作为独立 MCP 参数", () => {
    const settings = { ...initial, platform: "windows", executablePath: "C:\\User's Files\\x-file-desktop.exe" };
    const examples = buildAgentExamples(settings, true);
    expect(examples.cli).toContain("& 'C:\\User''s Files\\x-file-desktop.exe'");
    expect(examples.skill).toContain("[Console]::OutputEncoding");
    expect(examples.skill).toContain("[System.IO.File]::WriteAllText");
    expect(examples.skill).toContain("[System.Text.UTF8Encoding]::new($false)");
    expect(JSON.parse(examples.mcp).mcpServers["x-file"].command).toBe(settings.executablePath);
    expect(examples.cli).toContain("$env:X_FILE_AGENT_API_KEY");
  });
});
