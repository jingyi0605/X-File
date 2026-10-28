import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";

import {
  createDocumentList,
  createDocumentRecord,
  createLibrarySnapshot,
  installLibraryApiMock,
  libraryApiMock,
  resetLibraryApiMock,
} from "./mockLibraryApi";

installLibraryApiMock();
const platformData = { runtimePlatform: "web", osFamily: "web", overlayTitlebar: false } as const;

beforeEach(() => {
  localStorage.clear();
  resetLibraryApiMock();
});

it("常驻快速查找按 Enter 后在文件列表上方显示搜索结果", async () => {
  const { LibraryPage } = await import("../LibraryPage");
  render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
  const input = await screen.findByRole("searchbox", { name: "快速查找文件" });
  await userEvent.type(input, "  项目方案  {Enter}");
  const search = await screen.findByRole("region", { name: "搜索文档库" });
  expect(within(search).getByRole("tab", { name: "当前结果" })).toHaveAttribute("aria-selected", "true");
  await waitFor(() => expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledWith(
    expect.objectContaining({ keyword: "项目方案", offset: 0 }),
  ));
  expect(await screen.findByText("没有匹配文档")).toBeInTheDocument();
  expect(screen.queryByRole("dialog", { name: "搜索文档库" })).not.toBeInTheDocument();
});

it("搜索条使用单选分段控件切换范围和匹配方式", async () => {
  const { LibraryPage } = await import("../LibraryPage");
  render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
  const input = await screen.findByRole("searchbox", { name: "快速查找文件" });
  await userEvent.type(input, "方案{Enter}");
  const search = await screen.findByRole("region", { name: "搜索文档库" });

  await userEvent.click(within(search).getByRole("tab", { name: "所有文件" }));
  await userEvent.click(within(search).getByRole("tab", { name: "索引内容" }));

  await waitFor(() => expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(
    expect.objectContaining({
      searchScope: "all",
      searchMode: "content",
      offset: 0,
    }),
  ));
});

it("搜索命中文档沿用原生网格文件卡片，不渲染独立搜索结果卡片", async () => {
  libraryApiMock.listLibraryDocuments.mockResolvedValue(createDocumentList([
    createDocumentRecord({
      documentId: "doc-found",
      path: "docs/地毯技术标.docx",
      title: "地毯技术标.docx",
    }),
  ]));
  const { LibraryPage } = await import("../LibraryPage");
  render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
  const input = await screen.findByRole("searchbox", { name: "快速查找文件" });
  await userEvent.type(input, "地毯{Enter}");

  expect(await screen.findByText("地毯技术标.docx")).toBeInTheDocument();
  expect(document.querySelector(".affairs-doc-item.grid")).not.toBeNull();
  expect(document.querySelector(".library-search-result-item")).toBeNull();
});

it("主区域清除搜索会同步清空左侧快速搜索并隐藏筛选栏", async () => {
  const { LibraryPage } = await import("../LibraryPage");
  render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
  const quickSearch = await screen.findByRole("searchbox", { name: "快速查找文件" });
  await userEvent.type(quickSearch, "方案{Enter}");
  const search = await screen.findByRole("region", { name: "搜索文档库" });

  await userEvent.click(within(search).getByRole("button", { name: "清除搜索" }));

  await waitFor(() => {
    expect(quickSearch).toHaveValue("");
    expect(screen.queryByRole("region", { name: "搜索文档库" })).not.toBeInTheDocument();
  });
});

it("快速查找的 Escape 只清空输入，工具栏搜索直接打开列表内搜索栏", async () => {
  const { LibraryPage } = await import("../LibraryPage");
  render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
  const input = await screen.findByRole("searchbox", { name: "快速查找文件" });
  await userEvent.type(input, "方案{Escape}");
  expect(input).toHaveValue("");
  expect(screen.queryByRole("region", { name: "搜索文档库" })).not.toBeInTheDocument();
  expect(document.querySelector(".affairs-stage-toolbar-right button[aria-label='搜索文档库']")).toBeNull();
});

it("原生 details 支持十层标签嵌套，并保留顶部清除筛选操作", async () => {
  const names = Array.from({ length: 10 }, (_, index) => `层${index + 1}`);
  const tags = names.map((name, index) => ({
    name,
    path: names.slice(0, index + 1).join("/"),
    parentPath: index ? names.slice(0, index).join("/") : null,
    rootType: names[0],
    depth: index,
    documentCount: 1,
  }));
  libraryApiMock.getLibrarySnapshot.mockResolvedValue(createLibrarySnapshot({ tags }));
  libraryApiMock.listLibraryTags.mockResolvedValue(tags);
  const { LibraryPage } = await import("../LibraryPage");
  render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
  const tree = await screen.findByRole("tree", { name: "标签树" });
  for (const name of names.slice(0, -1)) {
    const item = within(tree).getByRole("treeitem", { name });
    expect(item.tagName).toBe("DETAILS");
    fireEvent.click(item.querySelector("summary")!);
    expect(item).toHaveAttribute("open");
  }
  const leaf = within(tree).getByRole("treeitem", { name: names.at(-1) });
  await userEvent.click(within(leaf).getByRole("button", { name: "层10 1" }));
  await waitFor(() => expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(
    expect.objectContaining({ selectedTagPaths: [names.join("/")] }),
  ));
  expect(screen.queryByRole("button", { name: "所有标签" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "清除标签筛选" }));
  await waitFor(() => expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(
    expect.objectContaining({ selectedTagPaths: [] }),
  ));
  expect(screen.queryByRole("button", { name: "清除标签筛选" })).not.toBeInTheDocument();
});
