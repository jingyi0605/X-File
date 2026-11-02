import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpdatePanel } from "./UpdatePanel";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

const updateState = {
  checkedAt: "2026-11-02T02:08:21Z",
  currentVersion: "0.1.0-beta.12",
  hasUpdate: true,
  manifest: {
    channel: "beta",
    platform: "macos-universal",
    version: "0.1.0-beta.13",
    tagName: "v0.1.0-beta.13",
    title: "v0.1.0-beta.13",
    notes: "X-File v0.1.0-beta.13",
    htmlUrl: "",
    publishedAt: "2026-11-02T02:08:21Z",
  },
  runtimeInfo: {
    version: "0.1.0-beta.12",
    appDataDir: null,
  },
};

describe("UpdatePanel", () => {
  beforeEach(() => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_release_channel") return "beta";
      if (command === "check_for_update") return updateState;
      if (command === "download_update") {
        return {
          ok: true,
          errorCode: null,
          detail: null,
          version: "0.1.0-beta.13",
          progress: { downloaded: 1, contentLength: 1, percent: 100 },
        };
      }
      if (command === "install_update") {
        return { ok: true, detail: null };
      }
      throw new Error(`Unexpected command: ${command}`);
    });
  });

  it("checks the installation result before showing the restart message", async () => {
    const user = userEvent.setup();
    render(<UpdatePanel />);

    await screen.findByText("发现新版本 0.1.0-beta.13，可以下载安装。");
    await user.click(screen.getByRole("button", { name: "下载并安装" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("install_update", { channel: "beta" });
    });
    expect(await screen.findByText("安装完成后应用将自动重启。")).toBeInTheDocument();
  });

  it("安装失败时显示错误，不显示重启成功提示", async () => {
    const user = userEvent.setup();
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_release_channel") return "beta";
      if (command === "check_for_update") return updateState;
      if (command === "download_update") {
        return {
          ok: true,
          errorCode: null,
          detail: null,
          version: "0.1.0-beta.13",
          progress: { downloaded: 1, contentLength: 1, percent: 100 },
        };
      }
      if (command === "install_update") {
        return { ok: false, detail: "安装程序未能启动" };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<UpdatePanel />);
    await screen.findByText("发现新版本 0.1.0-beta.13，可以下载安装。");
    await user.click(screen.getByRole("button", { name: "下载并安装" }));

    expect(await screen.findByText("安装程序未能启动")).toBeInTheDocument();
    expect(screen.queryByText("安装完成后应用将自动重启。")).not.toBeInTheDocument();
  });

  it("没有更新时在最新版本列显示最新状态并使用成功色", async () => {
    const noUpdateState = {
      ...updateState,
      hasUpdate: false,
      manifest: null,
    };
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "get_release_channel") return "beta";
      if (command === "check_for_update") return noUpdateState;
      throw new Error(`Unexpected command: ${command}`);
    });

    render(<UpdatePanel />);

    await screen.findByText("版本状态");
    const latestVersion = screen.getByText("当前已是最新版本。");
    expect(latestVersion).toHaveClass("settings-current-latest");
    expect(screen.getAllByText("当前已是最新版本。")).toHaveLength(1);
  });
});
