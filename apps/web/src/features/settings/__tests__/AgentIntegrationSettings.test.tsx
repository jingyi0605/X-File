import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentIntegrationSettings as Settings } from "@x-file/shared";

import { AgentIntegrationSettings, buildAgentExamples } from "../AgentIntegrationSettings";
import { getNativeAgentIntegrationSettings, saveNativeAgentIntegrationSettings } from "../../../runtime/native-library-bridge";

vi.mock("../../../runtime/native-library-bridge", () => ({
  getNativeAgentIntegrationSettings: vi.fn(),
  saveNativeAgentIntegrationSettings: vi.fn(),
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
    vi.resetAllMocks();
    vi.mocked(getNativeAgentIntegrationSettings).mockResolvedValue(initial);
  });

  it("先生成密钥再启用，配置示例不包含明文，撤销会关闭接入", async () => {
    const user = userEvent.setup();
    const key = "xf_generated-key-with-at-least-thirty-two-characters";
    const keyed = { ...initial, apiKeyConfigured: true };
    vi.mocked(saveNativeAgentIntegrationSettings)
      .mockResolvedValueOnce({ settings: keyed, apiKey: key })
      .mockResolvedValueOnce({ settings: { ...keyed, enabled: true } })
      .mockResolvedValueOnce({ settings: initial });
    render(<AgentIntegrationSettings mirrorMode={false} />);

    const toggle = await screen.findByRole("switch", { name: "启用外部 Agent 接入" });
    expect(toggle).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "生成 API Key" }));
    expect(saveNativeAgentIntegrationSettings).toHaveBeenLastCalledWith({ generateApiKey: true });
    const keyInput = await screen.findByLabelText("新密钥仅本次显示，请复制保存");
    expect(keyInput).toHaveValue(key);
    const mcp = screen.getByLabelText("MCP 客户端配置（JSON）");
    const config = JSON.parse(mcp.textContent!);
    expect(config.mcpServers["x-file"].command).toBe(initial.executablePath);
    expect(config.mcpServers["x-file"].args).toEqual(["mcp", "--data-dir", initial.dataDir, "--read-only"]);
    expect(mcp.textContent).not.toContain(key);

    const disclosure = screen.getByRole("button", { name: "外部 Agent 接入" });
    await user.click(disclosure);
    expect(keyInput).not.toBeVisible();
    expect(toggle).toBeVisible();
    await user.click(toggle);
    expect(saveNativeAgentIntegrationSettings).toHaveBeenLastCalledWith({ enabled: true });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByDisplayValue(key)).not.toBeInTheDocument();
    await user.click(disclosure);
    await user.click(screen.getByRole("button", { name: "撤销密钥并关闭接入" }));
    expect(saveNativeAgentIntegrationSettings).toHaveBeenLastCalledWith({ clearApiKey: true });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(toggle).toBeDisabled();
  });

  it("自定义密钥保存失败会保留当前开关状态并展示错误", async () => {
    const user = userEvent.setup();
    vi.mocked(saveNativeAgentIntegrationSettings).mockRejectedValue(new Error("写入失败"));
    render(<AgentIntegrationSettings mirrorMode={false} />);
    const input = await screen.findByLabelText(/设置新的 API Key/);
    await user.type(input, "custom-key-with-at-least-thirty-two-characters");
    const disclosure = screen.getByRole("button", { name: "外部 Agent 接入" });
    await user.click(disclosure);
    expect(input).not.toBeVisible();
    expect(saveNativeAgentIntegrationSettings).not.toHaveBeenCalled();
    await user.click(disclosure);
    expect(input).toHaveValue("custom-key-with-at-least-thirty-two-characters");
    await user.click(screen.getByRole("button", { name: "保存 API Key" }));
    expect(saveNativeAgentIntegrationSettings).toHaveBeenCalledWith({
      apiKey: "custom-key-with-at-least-thirty-two-characters",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("写入失败");
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("只读和读写模板切换，复制安装命令并报告剪贴板错误", async () => {
    const user = userEvent.setup();
    render(<AgentIntegrationSettings mirrorMode={false} />);
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

  it("镜像模式不读写本机配置，浏览器说明桌面端要求", async () => {
    const { rerender } = render(<AgentIntegrationSettings mirrorMode />);
    expect(screen.getByText(/请在资料库主机/)).toBeInTheDocument();
    expect(getNativeAgentIntegrationSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    vi.mocked(getNativeAgentIntegrationSettings).mockResolvedValue(null);
    rerender(<AgentIntegrationSettings mirrorMode={false} />);
    expect(await screen.findByText(/请使用支持此功能的 X-File 桌面端/)).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
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
