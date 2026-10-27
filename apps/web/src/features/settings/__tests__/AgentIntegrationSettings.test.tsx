import { act, render, screen, waitFor } from "@testing-library/react";
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
    const keyInput = screen.getByLabelText(/设置新的 API Key/);
    expect(toggle).toBeDisabled();
    expect(screen.queryByRole("button", { name: "复制新密钥" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "生成 API Key" }));
    expect(saveAgentIntegrationSettings).toHaveBeenLastCalledWith({ generateApiKey: true }, "");
    expect(screen.getByLabelText(/设置新的 API Key/)).toBe(keyInput);
    expect(keyInput).toHaveValue(key);
    expect(keyInput).toHaveAttribute("type", "text");
    expect(keyInput).toHaveFocus();
    expect((keyInput as HTMLInputElement).selectionStart).toBe(0);
    expect((keyInput as HTMLInputElement).selectionEnd).toBe(key.length);
    expect(screen.getAllByLabelText(/设置新的 API Key/)).toHaveLength(1);
    const copyButton = screen.getByRole("button", { name: "复制新密钥" });
    expect(keyInput.parentElement).toContainElement(copyButton);
    expect(copyButton.querySelector("svg")).toBeInTheDocument();
    expect(copyButton.textContent).toBe("");
    expect(screen.queryByRole("button", { name: "关闭密钥显示" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存 API Key" })).toBeDisabled();
    const mcp = screen.getByLabelText("MCP 客户端配置（JSON）");
    const config = JSON.parse(mcp.textContent!);
    expect(config.mcpServers["x-file"].command).toBe(initial.executablePath);
    expect(config.mcpServers["x-file"].args).toEqual(["mcp", "--data-dir", initial.dataDir, "--read-only"]);
    expect(mcp.textContent).not.toContain(key);

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
    expect(saveAgentIntegrationSettings).toHaveBeenLastCalledWith({ enabled: true }, "");
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByDisplayValue(key)).not.toBeInTheDocument();
    await user.click(disclosure);
    await user.click(screen.getByRole("button", { name: "撤销密钥并关闭接入" }));
    expect(saveAgentIntegrationSettings).toHaveBeenLastCalledWith({ clearApiKey: true }, "");
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
    const input = screen.getByLabelText(/设置新的 API Key/);
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
    expect(screen.getByLabelText(/设置新的 API Key/)).toHaveAttribute("type", "text");
    view.unmount();

    vi.mocked(getAgentIntegrationSettings).mockResolvedValue(keyed);
    render(<AgentIntegrationSettings />);
    const input = await screen.findByLabelText(/设置新的 API Key/);
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
    const input = screen.getByLabelText(/设置新的 API Key/);
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
    expect(saveAgentIntegrationSettings).toHaveBeenLastCalledWith({ apiKey: customKey }, "");
    await waitFor(() => expect(input).toHaveValue(""));
    expect(input).toHaveAttribute("placeholder", "\u2022".repeat(12));
  });

  it("自定义密钥保存失败会保留当前开关状态并展示错误", async () => {
    const user = userEvent.setup();
    vi.mocked(saveAgentIntegrationSettings).mockRejectedValue(new Error("写入失败"));
    render(<AgentIntegrationSettings />);
    const input = await screen.findByLabelText(/设置新的 API Key/);
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
    }, "");
    expect(await screen.findByRole("alert")).toHaveTextContent("写入失败");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("只读和读写模板切换，复制安装命令并报告剪贴板错误", async () => {
    const user = userEvent.setup();
    render(<AgentIntegrationSettings />);
    await screen.findByRole("switch");
    for (const title of ["API Key", "推荐配置方式", "SKILL 安装说明"]) {
      expect(screen.getByRole("heading", { name: title })).toBeVisible();
      expect(screen.queryByRole("button", { name: title })).not.toBeInTheDocument();
    }
    expect(screen.getByLabelText("MCP 客户端配置（JSON）")).toBeVisible();
    expect(screen.getByLabelText("安装命令")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("配置示例的访问权限"), "write");
    expect(screen.getByLabelText("MCP 客户端配置（JSON）")).not.toHaveTextContent("--read-only");
    const clipboard = vi.spyOn(navigator.clipboard, "writeText");
    await user.click(screen.getByRole("button", { name: "复制 安装命令" }));
    expect(clipboard).toHaveBeenCalledWith(expect.stringContaining('.agents/skills/x-file/SKILL.md'));
    expect(clipboard).toHaveBeenCalledWith(expect.stringContaining("cli skill"));
    expect(await screen.findByRole("status")).toHaveTextContent("已复制");
    clipboard.mockRejectedValueOnce(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "复制 CLI 调用示例" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("无法访问剪贴板");
  });

  it("镜像管理显示目标主机，令牌只用于当前页面，并在换主机时清除密钥与旧响应", async () => {
    const user = userEvent.setup();
    const token = "management-token-at-least-thirty-two-characters";
    await updateRuntimeConfig({ mode: "mirror", remoteApiBaseUrl: "https://primary.example.com" });
    vi.mocked(getAgentIntegrationSettings).mockRejectedValueOnce(new ApiClientError("", 401, "请输入有效的主机管理令牌。"));
    render(<AgentIntegrationSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("管理令牌");
    expect(screen.getByText(/配置目标：https:\/\/primary.example.com/)).toBeVisible();
    expect(screen.getByText(/当前管理的是远端资料库主机/)).toBeVisible();
    await user.type(screen.getByLabelText("主机管理令牌"), token);
    await user.click(screen.getByRole("button", { name: "连接 / 刷新配置" }));
    await screen.findByRole("switch");
    expect(getAgentIntegrationSettings).toHaveBeenLastCalledWith(token);
    let completeSave!: (value: { settings: Settings; apiKey: string }) => void;
    vi.mocked(saveAgentIntegrationSettings).mockImplementationOnce(() => new Promise((resolve) => { completeSave = resolve; }));
    await user.click(screen.getByRole("button", { name: "生成 API Key" }));
    expect(saveAgentIntegrationSettings).toHaveBeenLastCalledWith({ generateApiKey: true }, token);
    await act(() => updateRuntimeConfig({ remoteApiBaseUrl: "https://other.example.com" }));
    await screen.findByRole("switch");
    expect(screen.getByLabelText("主机管理令牌")).toHaveValue("");
    expect(getAgentIntegrationSettings).toHaveBeenLastCalledWith("");
    await act(async () => completeSave({ settings: initial, apiKey: "old-host-generated-key" }));
    expect(screen.getByLabelText(/设置新的 API Key/)).toHaveValue("");
    expect(JSON.stringify(Object.keys(localStorage).map((key) => localStorage.getItem(key)))).not.toContain(token);
    expect(localStorage.getItem("x-file.runtime.config")).not.toContain(token);
  });

  it("旧主机接口缺失时显示升级提示并可重试", async () => {
    const user = userEvent.setup();
    vi.mocked(getAgentIntegrationSettings).mockRejectedValueOnce(new ApiClientError("", 404, "not found"));
    render(<AgentIntegrationSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent("请更新主机服务");
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "连接 / 刷新配置" }));
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
