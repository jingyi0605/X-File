import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { updateMirrorSyncProgress } from "../../runtime/mirror-sync-progress";
import { MirrorSyncProgressPanel } from "./MirrorSyncProgressPanel";

describe("MirrorSyncProgressPanel", () => {
  afterEach(() => {
    act(() => {
      updateMirrorSyncProgress({
        phase: "idle",
        transport: null,
        receivedDocuments: 0,
        totalDocuments: null,
        receivedBytes: 0,
        totalBytes: null,
      });
    });
  });

  it("shows a byte-based percentage while receiving the primary snapshot", () => {
    updateMirrorSyncProgress({
      phase: "receiving",
      transport: "snapshot",
      receivedDocuments: 0,
      totalDocuments: null,
      receivedBytes: 1024 * 1024,
      totalBytes: 4 * 1024 * 1024,
    });

    render(<MirrorSyncProgressPanel active />);

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.getByText("已接收 1.0 / 4.0 MB")).toBeInTheDocument();
  });

  it("keeps an animated indeterminate bar when the primary omits content length", () => {
    updateMirrorSyncProgress({
      phase: "receiving",
      transport: "snapshot",
      receivedDocuments: 0,
      totalDocuments: null,
      receivedBytes: 1024,
      totalBytes: null,
    });

    render(<MirrorSyncProgressPanel active />);

    expect(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByText("已接收 0.0 MB")).toBeInTheDocument();
  });
});
