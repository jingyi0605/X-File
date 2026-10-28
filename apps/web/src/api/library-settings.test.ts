import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getHttpServerState, saveHttpServerState } from "./library";
import { initializeRuntimeConfig } from "../runtime/runtime-config-store";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const serverInput = { enabled: true, persistent: false, port: 17321 };
const operations = [
  {
    name: "读取 HTTP 服务设置",
    command: "native_get_http_server_state",
    path: "/api/server/state",
    method: "GET",
    input: undefined,
    nativeArgs: undefined,
    run: () => getHttpServerState(),
  },
  {
    name: "保存 HTTP 服务设置",
    command: "native_save_http_server_state",
    path: "/api/server/state",
    method: "PUT",
    input: serverInput,
    nativeArgs: { request: serverInput },
    run: () => saveHttpServerState(serverInput),
  },
];

describe("设置 API 运行环境路由", () => {
  const fetchMock = vi.fn();
  const result = { enabled: true };

  beforeEach(() => {
    localStorage.clear();
    initializeRuntimeConfig();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    invokeMock.mockReset().mockResolvedValue(result);
    fetchMock.mockReset().mockImplementation(async () => new Response(JSON.stringify(result)));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    vi.unstubAllGlobals();
  });

  it.each(operations)("HTTP 本地模式：$name 使用同源 API", async (operation) => {
    await expect(operation.run()).resolves.toEqual(result);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      operation.path,
      expect.objectContaining(operation.input
        ? { method: operation.method, body: JSON.stringify(operation.input) }
        : { headers: {} }),
    );
  });

  it.each(operations)("桌面本地模式：$name 使用原生命令", async (operation) => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    await expect(operation.run()).resolves.toEqual(result);
    expect(invokeMock).toHaveBeenCalledExactlyOnceWith(operation.command, operation.nativeArgs);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(operations)("桌面镜像模式：$name 使用远端 API", async (operation) => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    localStorage.setItem("x-file.runtime.config", JSON.stringify({
      mode: "mirror",
      remoteApiBaseUrl: "https://primary.example.com",
    }));
    initializeRuntimeConfig();
    await expect(operation.run()).resolves.toEqual(result);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      `https://primary.example.com${operation.path}`,
      expect.any(Object),
    );
  });
});
