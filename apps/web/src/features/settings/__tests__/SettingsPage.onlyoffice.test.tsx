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

installLibraryApiMock();

describe("SettingsPage OnlyOffice 设置区", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
  });

  it("会展示状态卡和字段说明", async () => {
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
    expect(screen.getByText("可用")).toBeInTheDocument();
    expect(screen.getByText("ONLYOFFICE 服务地址")).toBeInTheDocument();
    expect(screen.getByText("回调地址可达性")).toBeInTheDocument();
    expect(screen.getByText("如果 ONLYOFFICE 开启了 JWT 校验，这里必须填写同一份密钥；未开启则保持留空。")).toBeInTheDocument();

    const statusList = screen.getByRole("list", { name: "OnlyOffice 状态指标" });
    expect(within(statusList).getAllByRole("listitem")).toHaveLength(3);
  });
});
