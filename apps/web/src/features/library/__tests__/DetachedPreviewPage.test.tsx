import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DetachedPreviewPage } from "../DetachedPreviewPage";

const { getLibraryPreviewMock, getLibrarySnapshotMock } = vi.hoisted(() => ({
  getLibraryPreviewMock: vi.fn(),
  getLibrarySnapshotMock: vi.fn(),
}));

vi.mock("../../../api/library", () => ({
  getLibraryPreview: getLibraryPreviewMock,
  getLibrarySnapshot: getLibrarySnapshotMock,
}));

describe("DetachedPreviewPage", () => {
  it("uses the shared text renderer registry for detached previews", async () => {
    getLibraryPreviewMock.mockResolvedValue({
      libraryId: "default",
      path: "notes.md",
      supported: true,
      kind: "markdown",
      reason: null,
      content: "# Detached content",
      version: null,
      size: 20,
      updatedAt: null,
      previewPath: null,
      previewUrl: null,
      capabilities: {
        canEdit: false,
        canRefresh: true,
        canResize: true,
        canZoom: false,
        canPaginate: false,
      },
    });
    getLibrarySnapshotMock.mockResolvedValue({ binding: null });

    render(<DetachedPreviewPage path="notes.md" title="notes.md" />);

    expect(await screen.findByRole("heading", { name: "Detached content" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索" })).toBeInTheDocument();
    expect(getLibraryPreviewMock).toHaveBeenCalledWith("notes.md", "reading");
  });
});
