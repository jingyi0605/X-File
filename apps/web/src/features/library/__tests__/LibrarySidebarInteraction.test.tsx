import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";

import {
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

it("常驻快速查找按 Enter 后以输入的关键词执行真实文档搜索", async () => {
  const { LibraryPage } = await import("../LibraryPage");
  render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
  const input = await screen.findByRole("searchbox", { name: "快速查找文件" });
  await userEvent.type(input, "  项目方案  {Enter}");
  const dialog = await screen.findByRole("dialog", { name: "搜索文档库" });
  expect(within(dialog).getByRole("searchbox", { name: "关键词" })).toHaveValue("项目方案");
  await waitFor(() => expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledWith(
    expect.objectContaining({ keyword: "项目方案", offset: 0 }),
  ));
  expect(await within(dialog).findByText("没有匹配文档")).toBeInTheDocument();
});

it("快速查找的 Escape 只清空输入，顶部搜索仍可单独打开", async () => {
  const { LibraryPage } = await import("../LibraryPage");
  render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
  const input = await screen.findByRole("searchbox", { name: "快速查找文件" });
  await userEvent.type(input, "方案{Escape}");
  expect(input).toHaveValue("");
  expect(screen.queryByRole("dialog", { name: "搜索文档库" })).not.toBeInTheDocument();
  const toolbar = document.querySelector(".affairs-stage-toolbar-right")!;
  await userEvent.click(within(toolbar as HTMLElement).getByRole("button", { name: "搜索文档库" }));
  expect(await screen.findByRole("dialog", { name: "搜索文档库" })).toBeInTheDocument();
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
