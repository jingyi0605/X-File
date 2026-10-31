import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiClientError } from "./api/http";
import { App } from "./App";
import { initializeRuntimeConfig } from "./runtime/runtime-config-store";

const { getHttpAuthStatusMock, fetchHealthWithTransportMock } = vi.hoisted(() => ({
  getHttpAuthStatusMock: vi.fn(),
  fetchHealthWithTransportMock: vi.fn(),
}));

vi.mock("./api/auth", () => ({
  getHttpAuthStatus: getHttpAuthStatusMock,
  loginHttpAuth: vi.fn(),
}));

vi.mock("./api/health", () => ({
  fetchHealthWithTransport: fetchHealthWithTransportMock,
}));

vi.mock("./features/library/LibraryPage", () => ({
  LibraryPage: () => <div data-testid="library-page" />,
}));

vi.mock("./features/library/DetachedPreviewPage", () => ({
  DetachedPreviewPage: () => <div data-testid="detached-preview-page" />,
}));

vi.mock("./features/settings/SettingsPage", () => ({
  SettingsPage: () => <div data-testid="settings-page" />,
}));

vi.mock("./runtime/native-library-bridge", () => ({
  getNativeDesktopRuntimeInfo: vi.fn(),
}));

describe("App 镜像模式启动", () => {
  beforeEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    getHttpAuthStatusMock.mockReset();
    fetchHealthWithTransportMock.mockReset().mockResolvedValue({
      data: { ok: true, app: "X-File", version: "test" },
      transport: "http",
      detail: "test",
    });
  });

  it("旧镜像配置在远端网络失败时仍进入资料库页面", async () => {
    localStorage.setItem("x-file.runtime.config", JSON.stringify({
      mode: "mirror",
      remoteApiBaseUrl: "http://127.0.0.1:17321",
    }));
    initializeRuntimeConfig();
    getHttpAuthStatusMock.mockRejectedValue(new ApiClientError("/api/auth/status", 0, "Load failed"));

    render(<App />);

    expect(await screen.findByTestId("library-page")).toBeInTheDocument();
    expect(screen.queryByText("无法检查访问权限")).not.toBeInTheDocument();
  });

  it("远端明确返回认证失败时仍显示访问权限错误", async () => {
    localStorage.setItem("x-file.runtime.config", JSON.stringify({
      mode: "mirror",
      remoteApiBaseUrl: "http://127.0.0.1:17321",
    }));
    initializeRuntimeConfig();
    getHttpAuthStatusMock.mockRejectedValue(new ApiClientError("/api/auth/status", 401, "Unauthorized"));

    render(<App />);

    expect(await screen.findByText("无法检查访问权限")).toBeInTheDocument();
    expect(screen.queryByTestId("library-page")).not.toBeInTheDocument();
  });
});
