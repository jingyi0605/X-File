import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentIntegrationSettings, saveAgentIntegrationSettings } from "./agent-integration";
import { initializeRuntimeConfig, updateRuntimeConfig } from "../runtime/runtime-config-store";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("Agent 设置运行环境路由", () => {
  const fetchMock = vi.fn();
  const settings = { enabled: false, apiKeyConfigured: false, accessMode: "read_only" as const };
  const input = { generateApiKey: true };
  const saved = { settings, apiKey: "xf_generated-key" };

  beforeEach(() => {
    localStorage.clear();
    initializeRuntimeConfig();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    invoke.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    vi.unstubAllGlobals();
  });

  it("浏览器本地模式走同源 API，并复用 HTTP auth 会话 Cookie", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(settings)))
      .mockResolvedValueOnce(new Response(JSON.stringify(saved)));
    await expect(getAgentIntegrationSettings()).resolves.toEqual(settings);
    await expect(saveAgentIntegrationSettings(input)).resolves.toEqual(saved);
    expect(invoke).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/integration/agent/settings", {
      credentials: "include", headers: {},
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/integration/agent/settings", {
      method: "PUT", body: JSON.stringify(input),
      credentials: "include", headers: { "content-type": "application/json" },
    });
  });

  it("桌面本地模式继续使用原生命令，不请求 HTTP", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValueOnce(settings).mockResolvedValueOnce(saved);
    await expect(getAgentIntegrationSettings()).resolves.toEqual(settings);
    await expect(saveAgentIntegrationSettings(input)).resolves.toEqual(saved);
    expect(invoke).toHaveBeenNthCalledWith(1, "native_get_agent_integration_settings", undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, "native_save_agent_integration_settings", { input });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("镜像模式始终管理远端，桌面环境=%s", async (desktop) => {
    if (desktop) Object.assign(window, { __TAURI_INTERNALS__: {} });
    await updateRuntimeConfig({ mode: "mirror", remoteApiBaseUrl: "https://primary.example.com" });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(settings)))
      .mockResolvedValueOnce(new Response(JSON.stringify(saved)));
    await getAgentIntegrationSettings();
    await saveAgentIntegrationSettings(input);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://primary.example.com/api/integration/agent/settings",
      "https://primary.example.com/api/integration/agent/settings",
    ]);
    expect(fetchMock.mock.calls.every(([, options]) => options.credentials === "include")).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("桌面命令缺失时不静默转向另一个主机", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    invoke.mockRejectedValue(new Error("Command native_get_agent_integration_settings not found"));
    await expect(getAgentIntegrationSettings()).rejects.toThrow("请更新主机服务");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
