import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createOnlyOfficeSettings,
  createOnlyOfficeStatus,
  installLibraryApiMock,
  libraryApiMock,
  resetLibraryApiMock,
} from "../../library/__tests__/mockLibraryApi";
import { initializeRuntimeConfig } from "../../../runtime/runtime-config-store";

installLibraryApiMock();

describe("SettingsPage OnlyOffice 设置区", () => {
  beforeEach(() => {
    localStorage.clear();
    initializeRuntimeConfig();
    resetLibraryApiMock();
  });

  it("会把 OnlyOffice 作为集成卡片展示，并通过模态框承载配置", async () => {
    libraryApiMock.getOnlyOfficeSettings.mockResolvedValue(
      createOnlyOfficeSettings({
        enabled: true,
        serverUrl: "https://office.example.com",
        publicBaseUrl: "https://xapp.example.com",
        jwtSecretConfigured: true,
      }),
    );
    libraryApiMock.getOnlyOfficeStatus.mockResolvedValue(
      createOnlyOfficeStatus({
        state: "ready",
        summary: "ONLYOFFICE 服务和回调地址都已通过基础检查，可以启用 Office 预览。",
        checks: [
          {
            key: "server",
            label: "ONLYOFFICE 服务地址",
            status: "pass",
            detail: "服务地址可访问。",
          },
          {
            key: "callback",
            label: "回调地址可达性",
            status: "pass",
            detail: "回调地址可访问。",
          },
        ],
      }),
    );

    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage />);

    await userEvent.click(await screen.findByRole("tab", { name: /集成服务/ }));

    expect(await screen.findByText("Office 集成")).toBeInTheDocument();
    expect(screen.getAllByText("可用").length).toBeGreaterThan(0);
    expect(screen.getByText("ONLYOFFICE 服务地址")).toBeInTheDocument();
    expect(screen.getByText("回调地址可达性")).toBeInTheDocument();

    const statusList = screen.getByRole("list", { name: "OnlyOffice 状态指标" });
    expect(within(statusList).getAllByRole("listitem")).toHaveLength(3);

    await userEvent.click(screen.getByRole("button", { name: "配置集成" }));
    expect(await screen.findByText("OnlyOffice 作为单独集成项管理。这里只做启用、连通和安全配置，不把它继续摊在集成首页里。")).toBeInTheDocument();
    expect(screen.getByText("如果主服务端的 ONLYOFFICE 开启了 JWT 校验，这里必须填写同一份密钥；未开启则保持留空。")).toBeInTheDocument();
  });

  it("镜像模式下会把 OnlyOffice 标注为主服务端配置", async () => {
    localStorage.setItem(
      "x-file.runtime.config",
      JSON.stringify({
        mode: "mirror",
        remoteApiBaseUrl: "http://127.0.0.1:17321",
        localRootDir: "/Users/test/X-File-Mirror",
        updatedAt: "2026-06-16T00:00:00.000Z",
      }),
    );
    initializeRuntimeConfig();

    const { SettingsPage } = await import("../SettingsPage");
    render(<SettingsPage onClose={() => undefined} />);

    expect((await screen.findAllByText("镜像模式", { selector: ".settings-runtime-badge" })).length).toBeGreaterThan(0);

    await userEvent.click(await screen.findByRole("tab", { name: /集成服务/ }));
    expect(screen.getByText("主服务端设置")).toBeInTheDocument();
    expect(
      screen.getByText(
        "你当前在镜像模式下编辑的是主服务端的 OnlyOffice 配置。保存后会通过镜像连接写入源端本地模式实例，不是镜像端本机。",
      ),
    ).toBeInTheDocument();
  });
});
