import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DesktopUpdateNotice, type DesktopUpdateNoticeState } from "./DesktopUpdateNotice";

const notice: DesktopUpdateNoticeState = {
  channel: "beta",
  currentVersion: "0.1.0-beta.1",
  manifest: {
    channel: "beta",
    platform: "macos-universal",
    version: "0.1.0-beta.2",
    tagName: "v0.1.0-beta.2",
    title: "v0.1.0-beta.2",
    notes: "",
    htmlUrl: "",
    publishedAt: "",
  },
};

describe("DesktopUpdateNotice", () => {
  it("opens the update panel and dismisses the notice", () => {
    const onOpenSettings = vi.fn();
    const onDismiss = vi.fn();
    render(
      <DesktopUpdateNotice
        notice={notice}
        onOpenSettings={onOpenSettings}
        onDismiss={onDismiss}
      />,
    );

    expect(screen.getByText("发现新版本 0.1.0-beta.2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "查看更新" }));
    fireEvent.click(screen.getByRole("button", { name: "稍后提醒" }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
