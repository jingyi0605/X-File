import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LIBRARY_PREVIEW_FORMATS, type LibraryPreview } from "@x-file/shared";

import {
  LibraryPreviewRenderer,
  resolvePreviewRendererFamily,
} from "../LibraryPreviewRenderer";
import { resolveDocumentVisual } from "../document-visual";

const { readResourceMock } = vi.hoisted(() => ({ readResourceMock: vi.fn() }));

vi.mock("../preview-resource-controller", () => ({
  readPreviewResource: readResourceMock,
}));

function createPreview(overrides: Partial<LibraryPreview> = {}): LibraryPreview {
  return {
    libraryId: "default",
    path: "notes.md",
    supported: true,
    kind: "markdown",
    reason: null,
    content: "# Preview",
    version: null,
    size: 10,
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
    ...overrides,
  };
}

describe("LibraryPreviewRenderer", () => {
  it("routes registered formats through family adapters", () => {
    expect(resolvePreviewRendererFamily("notes.md")).toBe("markdown");
    expect(resolvePreviewRendererFamily("records.csv")).toBe("delimited-text");
    expect(resolvePreviewRendererFamily("records.xlsx")).toBe("spreadsheet");
    expect(resolvePreviewRendererFamily("legacy.doc")).toBeNull();
  });

  it("routes every manifest format consistently and keeps icon support separate", () => {
    for (const format of LIBRARY_PREVIEW_FORMATS) {
      for (const extension of format.extensions) {
        expect(resolvePreviewRendererFamily(`sample${extension}`)).toBe(
          format.previewable ? format.adapterFamily : null,
        );
      }
    }
    expect(resolveDocumentVisual("photo.heic").badge).toBe("IMG");
    expect(resolvePreviewRendererFamily("photo.heic")).toBeNull();
    expect(resolveDocumentVisual("notes.mdx").badge).toBe("MD");
    expect(resolvePreviewRendererFamily("notes.mdx")).toBe("text-code");
  });

  it("renders HTML in a sandbox without same-origin or script privileges", async () => {
    const preview = createPreview({
      path: "page.html",
      kind: "html",
      previewUrl: null,
      content: "<script>document.body.dataset.executed='yes'</script><p>safe</p>",
    });
    render(<LibraryPreviewRenderer preview={preview} content={preview.content ?? ""} layout="viewer" />);
    const frame = await screen.findByTitle("page.html");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("srcdoc", preview.content);
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("reads images through the bounded resource controller and revokes blob URLs on unmount", async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    readResourceMock.mockResolvedValueOnce(bytes);
    const createObjectURL = vi.fn(() => "blob:preview-image");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const preview = createPreview({ path: "photo.png", kind: "image", previewUrl: "/preview/photo.png" });
    const { unmount } = render(<LibraryPreviewRenderer preview={preview} content="" layout="viewer" />);

    expect(await screen.findByRole("img", { name: "photo.png" })).toHaveAttribute("src", "blob:preview-image");
    expect(readResourceMock).toHaveBeenCalledWith(expect.objectContaining({
      path: "photo.png",
      previewUrl: "/preview/photo.png",
      signal: expect.any(AbortSignal),
    }));
    unmount();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview-image"));
    expect(bytes).toEqual(Uint8Array.from([0, 0, 0]));
    delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  });

  it("does not send known unsupported formats to the text renderer", () => {
    const preview = createPreview({ path: "old.doc", kind: "unsupported", supported: false, content: null });
    render(<LibraryPreviewRenderer preview={preview} content="" layout="detail" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(document.querySelector(".file-viewer-code-block")).toBeNull();
  });

  it("exposes the same search controls for code and Markdown previews", async () => {
    const codePreview = createPreview({ path: "notes.ts", kind: "text" });
    const { unmount } = render(
      <LibraryPreviewRenderer preview={codePreview} content="const needle = 1;" layout="viewer" />,
    );
    fireEvent.change(await screen.findByRole("searchbox", { name: "搜索" }), { target: { value: "needle" } });
    expect(screen.getByText("1 处")).toBeInTheDocument();
    unmount();

    const markdownPreview = createPreview({ path: "notes.md", kind: "markdown" });
    render(
      <LibraryPreviewRenderer preview={markdownPreview} content="# needle" layout="viewer" />,
    );
    fireEvent.change(await screen.findByRole("searchbox", { name: "搜索" }), { target: { value: "needle" } });
    expect(screen.getByText("1 处")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一处" })).toBeEnabled();
  });
});
