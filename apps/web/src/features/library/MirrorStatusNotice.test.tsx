import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchHealthMock, getMirrorSnapshotMock, loadMirrorCacheMock } = vi.hoisted(() => ({
  fetchHealthMock: vi.fn(),
  getMirrorSnapshotMock: vi.fn(),
  loadMirrorCacheMock: vi.fn(),
}));

vi.mock("../../api/health", () => ({
  fetchHealth: fetchHealthMock,
}));

vi.mock("../../runtime/mirror-api", () => ({
  getMirrorSnapshot: getMirrorSnapshotMock,
}));

vi.mock("../../runtime/mirror-cache", () => ({
  loadMirrorCache: loadMirrorCacheMock,
}));

import { MirrorStatusNotice } from "./MirrorStatusNotice";

describe("MirrorStatusNotice", () => {
  beforeEach(() => {
    localStorage.clear();
    fetchHealthMock.mockReset().mockRejectedValue(new Error("offline"));
    getMirrorSnapshotMock.mockReset().mockRejectedValue(new Error("offline"));
    loadMirrorCacheMock.mockReset().mockResolvedValue({
      snapshot: {},
      pendingMutations: [],
      syncResults: [],
      source: "cache",
      lastSyncedAt: "2026-10-31T00:00:00.000Z",
      lastError: "offline",
    });
  });

  it("renders a closable offline warning toast", async () => {
    render(<MirrorStatusNotice remoteApiBaseUrl="http://primary.test" />);

    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("当前正在使用本地镜像快照浏览");

    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("keeps the dismissal after remount while the same primary remains offline", async () => {
    const first = render(<MirrorStatusNotice remoteApiBaseUrl="http://primary.test" />);
    await screen.findByRole("status");
    await userEvent.click(screen.getByRole("button", { name: "关闭" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    first.unmount();

    render(<MirrorStatusNotice remoteApiBaseUrl="http://primary.test" />);
    await waitFor(() => expect(loadMirrorCacheMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("refreshes once when the primary is back after a cached sync error", async () => {
    fetchHealthMock.mockResolvedValue({ ok: true });
    getMirrorSnapshotMock.mockResolvedValue({ revision: "reconnected" });
    const onAvailable = vi.fn();
    render(<MirrorStatusNotice remoteApiBaseUrl="http://primary.test" onAvailable={onAvailable} />);

    await waitFor(() => expect(getMirrorSnapshotMock).toHaveBeenCalledTimes(1));
    expect(getMirrorSnapshotMock).toHaveBeenCalledTimes(1);
    expect(onAvailable).toHaveBeenCalledTimes(1);
  });
});
