import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createLibraryBinding,
  createLibraryConfig,
  installLibraryApiMock,
  libraryApiMock,
  resetLibraryApiMock,
} from "../../library/__tests__/mockLibraryApi";

installLibraryApiMock();

describe("SettingsPage 文档库索引配置迁移行为", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
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
    expect(await screen.findByText("双击打开")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("switch", { name: "文件夹打开方式" }));
    expect(screen.getByText("单击打开")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "保存索引设置" }));

    await waitFor(() => {
      expect(libraryApiMock.saveLibraryConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          folderOpenBehavior: "single_click",
        }),
      );
    });
  });
});
