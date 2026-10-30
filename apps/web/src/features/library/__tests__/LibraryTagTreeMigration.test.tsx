import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryTagNode } from "@x-file/shared";

import {
  createDocumentList,
  createDocumentRecord,
  createLibrarySnapshot,
  installLibraryApiMock,
  libraryApiMock,
  resetLibraryApiMock,
} from "./mockLibraryApi";

installLibraryApiMock();

const platformData = {
  runtimePlatform: "web" as const,
  osFamily: "web" as const,
  overlayTitlebar: false,
};

describe("第 8 批：标签筛选树、多选过滤、徽标计数、排序、展开记忆与拼音搜索", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("标签树显示业务标签并隐藏来源、主题、状态噪音根标签", async () => {
    mockTags([
      tag("项目", 20),
      tag("项目/Alpha", 12, { parentPath: "项目", depth: 1 }),
      tag("来源", 99),
      tag("来源/邮件", 99, { rootType: "source", parentPath: "来源", depth: 1 }),
      tag("主题", 99),
      tag("状态", 99),
    ]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    expect(await screen.findByRole("button", { name: /项目/ })).toBeInTheDocument();
    const tree = await screen.findByRole("tree", { name: "标签树" });
    expect(within(tree).queryByRole("button", { name: /来源/ })).not.toBeInTheDocument();
    expect(within(tree).queryByRole("button", { name: /主题/ })).not.toBeInTheDocument();
    expect(within(tree).queryByRole("button", { name: /状态/ })).not.toBeInTheDocument();
  });

  it.each([
    ["时间", "time"],
    ["类型", "type"],
    ["time", "time"],
    ["type", "type"],
  ] as const)("%s 根标签点击仅切换展开状态，并保留子标签筛选", async (root, rootType) => {
    const childPath = `${root}/分组`;
    mockTags([
      tag(root, 2, { rootType }),
      tag(childPath, 2, { rootType, parentPath: root, depth: 1 }),
      tag(`${childPath}/文档`, 1, { rootType, parentPath: childPath, depth: 2 }),
    ]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    const tree = await screen.findByRole("tree", { name: "标签树" });
    const rootLabel = systemRootLabel(root);
    const rootItem = within(tree).getByRole("treeitem", { name: rootLabel });
    const rootButton = within(rootItem).getByRole("button", { name: rootLabel });
    expect(rootButton.closest(".affairs-sidebar-item")).toHaveAttribute("data-system-tag", "true");
    expect(within(rootButton).getByTitle(`${rootLabel} · 系统内置标签`)).toBeInTheDocument();
    const initialRequestCount = libraryApiMock.listLibraryDocuments.mock.calls.length;

    expect(rootButton).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(rootButton);
    expect(rootItem).toHaveAttribute("aria-expanded", "true");
    expect(rootButton).toHaveAttribute("aria-expanded", "true");
    expect(within(rootItem).getByRole("button", { name: "分组" })).toBeInTheDocument();

    await userEvent.click(rootButton);
    expect(rootItem).toHaveAttribute("aria-expanded", "false");
    expect(within(rootItem).queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("清除标签筛选")).not.toBeInTheDocument();
    expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledTimes(initialRequestCount);

    await userEvent.click(within(rootItem).getByRole("button", { name: "展开标签" }));
    await userEvent.click(within(rootItem).getByTitle("分组 · 按文件数量筛选（2）"));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        browseMode: "tag",
        selectedTagPaths: [childPath],
      }));
    });

    const filteredRequestCount = libraryApiMock.listLibraryDocuments.mock.calls.length;
    await userEvent.click(rootButton);
    expect(rootItem).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByLabelText("清除标签筛选")).toBeInTheDocument();

    rootButton.focus();
    await userEvent.keyboard("{Enter}");
    expect(rootItem).toHaveAttribute("aria-expanded", "true");
    expect(rootButton.closest(".affairs-sidebar-item")).not.toHaveClass("active");
    expect(within(rootItem).getByRole("button", { name: /分组/ }).closest(".affairs-sidebar-item"))
      .toHaveClass("active");
    expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledTimes(filteredRequestCount);
  });

  it("父标签单击展开，点击文件数量筛选", async () => {
    mockTags([
      tag("项目", 2),
      tag("项目/时间", 1, { parentPath: "项目", depth: 1 }),
    ]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    const rootButton = await screen.findByRole("button", { name: "项目" });
    await userEvent.click(rootButton);
    expect(screen.getByRole("button", { name: "时间" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "按文件数量筛选（2）" }));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        browseMode: "tag",
        selectedTagPaths: ["项目"],
      }));
    });
    await userEvent.click(screen.getByRole("button", { name: /时间/ }));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedTagPaths: ["项目/时间"],
      }));
    });
  });

  it("无子标签的根标签单击即可筛选", async () => {
    mockTags([tag("项目", 2)]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await userEvent.click(await screen.findByRole("button", { name: "项目" }));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        browseMode: "tag",
        selectedTagPaths: ["项目"],
      }));
    });
  });

  it("标签树路径会在面包屑里显示每一级标签名称", async () => {
    mockTags([
      tag("项目", 3),
      tag("项目/Alpha", 2, { parentPath: "项目", depth: 1 }),
      tag("项目/Alpha/合同", 1, { parentPath: "项目/Alpha", depth: 2 }),
    ]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await expandTag("项目");
    await expandTag("Alpha");
    await userEvent.click(await screen.findByRole("button", { name: /合同/ }));

    const breadcrumb = document.querySelector(".affairs-stage-breadcrumb") as HTMLElement;
    expect(within(breadcrumb).getByRole("button", { name: "项目" })).toBeInTheDocument();
    expect(within(breadcrumb).getByRole("button", { name: "Alpha" })).toBeInTheDocument();
    expect(within(breadcrumb).getByRole("button", { name: "合同" })).toBeInTheDocument();
  });

  it("面包屑空间不足时保留首级、上一级和当前级，名称仅在实际裁切时省略", async () => {
    mockTags([
      tag("项目", 3),
      tag("项目/Alpha", 2, { parentPath: "项目", depth: 1 }),
      tag("项目/Alpha/商务合作项目资料归档文件夹", 2, { parentPath: "项目/Alpha", depth: 2 }),
      tag("项目/Alpha/商务合作项目资料归档文件夹/合同", 1, { parentPath: "项目/Alpha/商务合作项目资料归档文件夹", depth: 3 }),
    ]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await expandTag("项目");
    await expandTag("Alpha");
    await expandTag("商务合作项目资料归档文件夹");
    await userEvent.click(await screen.findByRole("button", { name: /合同/ }));

    const breadcrumb = document.querySelector(".affairs-stage-breadcrumb") as HTMLElement;
    const items = breadcrumb.querySelector<HTMLElement>(".affairs-stage-breadcrumb-items")!;
    Object.defineProperty(items, "clientWidth", { configurable: true, value: 240 });
    const measure = items.querySelector<HTMLElement>(".affairs-stage-breadcrumb-measure")!;
    const widths = [42, 42, 180, 42];
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute("data-breadcrumb-ellipsis")) {
        return { width: 18, height: 24, top: 0, right: 18, bottom: 24, left: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      if (this.parentElement === measure) {
        const index = Array.from(measure.children).indexOf(this);
        const width = widths[index] ?? 0;
        return { width, height: 24, top: 0, right: width, bottom: 24, left: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return new DOMRect();
    });
    act(() => {
      Object.defineProperty(items, "clientWidth", { configurable: true, value: 142 });
      window.dispatchEvent(new Event("resize"));
    });
    act(() => window.dispatchEvent(new Event("resize")));
    await waitFor(() => {
      expect(within(breadcrumb).queryByRole("button", { name: "Alpha" })).not.toBeInTheDocument();
      expect(within(breadcrumb).getByRole("button", { name: "商务合作项目资料归档文件夹" })).toBeInTheDocument();
    });
    expect(within(breadcrumb).getByRole("button", { name: "项目" })).toBeInTheDocument();
    expect(within(breadcrumb).getByRole("button", { name: "合同" })).toBeInTheDocument();
    expect(breadcrumb.textContent).toContain("…");
    const previousLevelButton = within(breadcrumb).getByRole("button", {
      name: "商务合作项目资料归档文件夹",
    });
    expect(previousLevelButton.textContent).toBe("商务合作项目资料归档文件夹");

    act(() => {
      Object.defineProperty(items, "clientWidth", { configurable: true, value: 400 });
      window.dispatchEvent(new Event("resize"));
    });
    await waitFor(() => {
      expect(within(breadcrumb).getByRole("button", { name: "Alpha" })).toBeInTheDocument();
      expect(within(breadcrumb).getByRole("button", { name: "商务合作项目资料归档文件夹" })).toBeInTheDocument();
    });

    vi.restoreAllMocks();
  });

  it("标签支持多选过滤、顶部重置按钮和筛选后徽标数量", async () => {
    mockTags([
      tag("项目", 10),
      tag("项目/Alpha", 7, { parentPath: "项目", depth: 1 }),
      tag("类型", 10, { rootType: "type" }),
      tag("类型/PDF", 5, { rootType: "type", parentPath: "类型", depth: 1 }),
      tag("类型/Markdown", 3, { rootType: "type", parentPath: "类型", depth: 1 }),
    ]);
    libraryApiMock.listLibraryDocuments
      .mockResolvedValueOnce(createDocumentList([], {
        total: 3,
        tagFacetCounts: {
          "项目": 3,
          "项目/Alpha": 3,
          "类型": 3,
          "类型/PDF": 2,
          "类型/Markdown": 0,
        },
      }))
      .mockResolvedValue(createDocumentList([], {
        total: 2,
        tagFacetCounts: {
          "项目": 2,
          "项目/Alpha": 2,
          "类型": 2,
          "类型/PDF": 2,
          "类型/Markdown": 0,
        },
      }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await expandTag("项目");
    await userEvent.click(await screen.findByRole("button", { name: /Alpha/ }));
    expect(await screen.findByLabelText("清除标签筛选")).toBeInTheDocument();

    await expandTag("类型");
    await userEvent.click(await screen.findByRole("button", { name: /PDF/ }));

    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        browseMode: "tag",
        selectedTagPaths: ["项目/Alpha", "类型/PDF"],
      }));
    });

    await expandTag("类型");
    const tree = await screen.findByRole("tree", { name: "标签树" });
    expect(within(tree).getByTitle("PDF · 按文件数量筛选（2）")).toBeInTheDocument();
    expect(within(tree).queryByRole("button", { name: /Markdown/ })).not.toBeInTheDocument();
  });

  it("单标签筛选的文件视图将直接绑定目录置于匹配文件之前", async () => {
    mockTags([tag("项目", 1)]);
    libraryApiMock.listLibraryDocuments.mockImplementation(async (query) => createDocumentList(
      [createDocumentRecord({ documentId: "tagged-file", path: "客户/合同.md" })],
      {
        total: 1,
        tagDirectories: query.selectedTagPaths?.length
          ? [{
              path: "已标记目录",
              documentCount: 1,
              updatedAt: "2026-06-09T00:00:00.000Z",
              matchedTagPaths: ["项目"],
            }]
          : [],
      },
    ));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await userEvent.click(await screen.findByTitle("项目 · 按文件数量筛选（1）"));
    await userEvent.click(await screen.findByRole("button", { name: "列表" }));

    const directory = await screen.findByRole("button", { name: /已标记目录/ });
    const file = await screen.findByRole("button", { name: /合同\.md/ });
    const visibleRows = Array.from(document.querySelectorAll(".affairs-finder-virtual > *"));
    expect(visibleRows.indexOf(directory.parentElement!)).toBeLessThan(visibleRows.indexOf(file.parentElement!));
    expect(screen.queryByRole("button", { name: /客户/ })).not.toBeInTheDocument();
  });

  it("多标签筛选的文件视图在文件前显示命中任一所选标签的直接绑定目录", async () => {
    mockTags([tag("项目", 1), tag("业务", 1)]);
    libraryApiMock.listLibraryDocuments.mockImplementation(async (query) => createDocumentList(
      [createDocumentRecord({ documentId: "tagged-file", path: "客户/合同.md" })],
      {
        total: 1,
        tagFacetCounts: query.selectedTagPaths?.length ? { "项目": 1, "业务": 1 } : {},
        tagDirectories: query.selectedTagPaths?.length
          ? [{
              path: "项目目录",
              documentCount: 1,
              updatedAt: "2026-06-09T00:00:00.000Z",
              matchedTagPaths: ["项目"],
            }, {
              path: "业务目录",
              documentCount: 1,
              updatedAt: "2026-06-09T00:00:00.000Z",
              matchedTagPaths: ["业务"],
            }]
          : [],
      },
    ));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await userEvent.click(await screen.findByTitle("项目 · 按文件数量筛选（1）"));
    await userEvent.click(await screen.findByTitle("业务 · 按文件数量筛选（1）"));
    await userEvent.click(await screen.findByRole("button", { name: "列表" }));

    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedTagPaths: ["项目", "业务"],
      }));
    });
    const projectDirectory = await screen.findByRole("button", { name: /项目目录/ });
    const businessDirectory = await screen.findByRole("button", { name: /业务目录/ });
    const file = await screen.findByRole("button", { name: /合同\.md/ });
    const visibleRows = Array.from(document.querySelectorAll(".affairs-finder-virtual > *"));
    expect(visibleRows.indexOf(projectDirectory.parentElement!)).toBeLessThan(visibleRows.indexOf(file.parentElement!));
    expect(visibleRows.indexOf(businessDirectory.parentElement!)).toBeLessThan(visibleRows.indexOf(file.parentElement!));
  });

  it("标签筛选在列表视图可以切到目录视图，按文件实际路径分组显示", async () => {
    mockTags([tag("项目", 2), tag("项目/Alpha", 2, { parentPath: "项目", depth: 1 })]);
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([
        createDocumentRecord({ documentId: "a", path: "客户/合同/a.md" }),
        createDocumentRecord({ documentId: "b", path: "客户/方案/b.md" }),
      ], { total: 2 }),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await expandTag("项目");
    await userEvent.click(await screen.findByRole("button", { name: /Alpha/ }));
    await userEvent.click(await screen.findByRole("button", { name: "列表" }));
    await userEvent.click(await screen.findByRole("button", { name: "目录" }));

    expect(await screen.findByRole("button", { name: /客户/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /合同/ })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /方案/ })).toBeInTheDocument();
  });

  it("标签筛选目录视图为三级及更深目录保留各自层级缩进", async () => {
    mockTags([tag("项目", 1), tag("项目/Alpha", 1, { parentPath: "项目", depth: 1 })]);
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([
        createDocumentRecord({
          documentId: "nested-document",
          path: "一级/二级/三级/四级/文档.md",
        }),
      ], { total: 1 }),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await expandTag("项目");
    await userEvent.click(await screen.findByRole("button", { name: /Alpha/ }));
    await userEvent.click(await screen.findByRole("button", { name: "列表" }));
    await userEvent.click(await screen.findByRole("button", { name: "目录" }));

    for (const [name, depth] of [["一级", "1"], ["二级", "2"], ["三级", "3"], ["四级", "4"]]) {
      const row = await screen.findByRole("button", { name: new RegExp(name) });
      expect(row.querySelector(".affairs-finder-name-cell"))
        .toHaveStyle({ "--affairs-finder-depth": depth });
    }

    const documentRow = await screen.findByRole("button", { name: /文档\.md/ });
    expect(documentRow.querySelector(".affairs-finder-name-cell"))
      .toHaveStyle({ "--affairs-finder-depth": "4" });
  });

  it("列表视图下标签筛选后的文档点击只更新选中态，不会重新请求列表", async () => {
    mockTags([tag("项目", 1), tag("项目/Alpha", 1, { parentPath: "项目", depth: 1 })]);
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ documentId: "a", path: "客户/a.md" })], { total: 1 }),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await expandTag("项目");
    await userEvent.click(await screen.findByRole("button", { name: /Alpha/ }));
    await userEvent.click(await screen.findByRole("button", { name: "列表" }));
    await screen.findByRole("button", { name: /a\.md/ });
    const requestCount = libraryApiMock.listLibraryDocuments.mock.calls.length;

    await userEvent.click(screen.getByRole("button", { name: /a\.md/ }));

    expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledTimes(requestCount);
  });

  it("最近3天和7天置顶并保留真实计数，其他标签按访问数量优先", async () => {
    mockTags([
      tag("时间", 10, { rootType: "time" }),
      tag("时间/更早", 9, { rootType: "time", parentPath: "时间", depth: 1 }),
      tag("时间/最近7天", 4, { rootType: "time", parentPath: "时间", depth: 1 }),
      tag("时间/最近3天", 2, { rootType: "time", parentPath: "时间", depth: 1 }),
      tag("项目", 10),
      tag("项目/低频", 1, { parentPath: "项目", depth: 1 }),
      tag("项目/高频", 8, { parentPath: "项目", depth: 1 }),
    ]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await expandTag("时间");
    await expandTag("项目");

    const timeChildren = childTitlesOf("时间");
    expect(timeChildren).toEqual(["最近3天", "最近7天", "更早"]);
    const projectChildren = childTitlesOf("项目");
    expect(projectChildren[0]).toContain("高频");
  });

  it("年份和月份按数字降序排列，不受文档数量和输入顺序影响", async () => {
    mockTags([
      tag("时间", 60, { rootType: "time" }),
      ...["2024", "2025", "2026"].map((year, index) =>
        tag(`时间/${year}`, 30 - index * 10, { rootType: "time", parentPath: "时间", depth: 1 }),
      ),
      ...["02", "12", "9"].map((month, index) =>
        tag(`时间/2026/${month}`, 3 - index, { rootType: "time", parentPath: "时间/2026", depth: 2 }),
      ),
    ]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await expandTag("时间");
    const timeRoot = screen.getByRole("treeitem", { name: "时间范围" });
    const timeChildren = timeRoot.querySelectorAll(":scope > [role=group] > [role=treeitem]");
    expect(Array.from(timeChildren, (child) => child.getAttribute("aria-label")))
      .toEqual(["2026", "2025", "2024"]);

    await expandTag("2026");
    expect(childTitlesOf("2026")).toEqual(["12", "9", "02"]);
  });

  it("旧快照没有最近分类时不虚构标签，零计数标签在筛选后隐藏", async () => {
    mockTags([
      tag("时间", 1, { rootType: "time" }),
      tag("时间/2024", 1, { rootType: "time", parentPath: "时间", depth: 1 }),
    ]);
    libraryApiMock.listLibraryDocuments.mockResolvedValue(createDocumentList([], {
      total: 0,
      tagFacetCounts: {},
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await expandTag("时间");
    expect(childTitlesOf("时间")).toEqual(["2024"]);

    await userEvent.click(screen.getByTitle("2024 · 按文件数量筛选（1）"));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedTagPaths: ["时间/2024"],
      }));
    });
    expect(childTitlesOf("时间")).toEqual(["2024"]);
  });

  it("最近分类筛选后隐藏零计数的其他标签，同时保留当前选中项", async () => {
    mockTags([
      tag("时间", 3, { rootType: "time" }),
      tag("时间/最近3天", 2, { rootType: "time", parentPath: "时间", depth: 1 }),
      tag("时间/最近7天", 3, { rootType: "time", parentPath: "时间", depth: 1 }),
    ]);
    libraryApiMock.listLibraryDocuments.mockResolvedValue(createDocumentList([], {
      total: 0,
      tagFacetCounts: {},
    }));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await expandTag("时间");
    expect(childTitlesOf("时间")).toEqual(["最近3天", "最近7天"]);
    await userEvent.click(screen.getByTitle("最近3天 · 按文件数量筛选（2）"));

    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedTagPaths: ["时间/最近3天"],
      }));
    });
    expect(childTitlesOf("时间")).toEqual(["最近3天"]);
  });

  it.each(
    ["时间", "time"].flatMap((root) => [3, 7, 30].map((days) => ({ root, days }))),
  )("$root 选中最近 $days 天后隐藏其他非零最近分类，取消或切换到年份后恢复", async ({ root, days }) => {
    const recentCounts = new Map([[3, 19], [7, 27], [30, 60]]);
    const label = (value: number) => root === "时间" ? `最近${value}天` : `recent-${value}-days`;
    const selectedPath = `${root}/${label(days)}`;
    const selectedCount = recentCounts.get(days)!;
    const yearPath = `${root}/2026`;
    mockTags([
      tag(root, 60, { rootType: "time" }),
      ...Array.from(recentCounts, ([value, count]) =>
        tag(`${root}/${label(value)}`, count, { rootType: "time", parentPath: root, depth: 1 }),
      ),
      tag(`${root}/${label(90)}`, 0, { rootType: "time", parentPath: root, depth: 1 }),
      tag(yearPath, 60, { rootType: "time", parentPath: root, depth: 1 }),
    ]);
    libraryApiMock.listLibraryDocuments.mockImplementation(async (input: { selectedTagPaths: string[] }) => {
      const count = input.selectedTagPaths.includes(selectedPath) ? selectedCount : 60;
      return createDocumentList([], {
        total: count,
        tagFacetCounts: {
          [root]: count,
          [yearPath]: count,
          ...Object.fromEntries(Array.from(recentCounts, ([value, total]) =>
            [`${root}/${label(value)}`, Math.min(total, count)],
          )),
        },
      });
    });

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await expandTag(root);
    const tree = screen.getByRole("tree", { name: "标签树" });
    const expectAllRecentTags = () => {
      for (const [value, count] of recentCounts) {
        expect(within(tree).getByTitle(`${label(value)} · 按文件数量筛选（${count}）`)).toBeInTheDocument();
      }
      expect(within(tree).queryByRole("treeitem", { name: label(90) })).not.toBeInTheDocument();
    };
    const selectRecentTag = async () => {
      await userEvent.click(within(tree).getByTitle(`${label(days)} · 按文件数量筛选（${selectedCount}）`));
      await waitFor(() => {
        expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
          selectedTagPaths: [selectedPath],
        }));
      });
      expect(within(tree).getByTitle(`${label(days)} · 按文件数量筛选（${selectedCount}）`)).toBeInTheDocument();
      for (const value of recentCounts.keys()) {
        if (value !== days) {
          expect(within(tree).queryByRole("treeitem", { name: label(value) })).not.toBeInTheDocument();
        }
      }
      expect(within(tree).getByRole("treeitem", { name: "2026" })).toBeInTheDocument();
    };

    expectAllRecentTags();
    await selectRecentTag();
    await userEvent.click(within(tree).getByTitle(`2026 · 按文件数量筛选（${selectedCount}）`));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedTagPaths: [yearPath],
      }));
    });
    expectAllRecentTags();

    await selectRecentTag();
    await userEvent.click(within(tree).getByTitle(`${label(days)} · 按文件数量筛选（${selectedCount}）`));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedTagPaths: [],
      }));
    });
    expectAllRecentTags();

    await selectRecentTag();
    await userEvent.click(screen.getByLabelText("清除标签筛选"));
    expectAllRecentTags();
  });

  it("英文时间标签同样固定最近分类并按年月降序排列", async () => {
    mockTags([
      tag("time", 2, { rootType: "time" }),
      tag("time/2025", 1, { rootType: "time", parentPath: "time", depth: 1 }),
      tag("time/2026", 1, { rootType: "time", parentPath: "time", depth: 1 }),
      tag("time/recent-7-days", 1, { rootType: "time", parentPath: "time", depth: 1 }),
    ]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await expandTag("time");
    expect(childTitlesOf("time")).toEqual(["recent-7-days", "2026", "2025"]);
  });

  it("每层标签默认最多显示 5 个，支持展开和收起并记住状态", async () => {
    mockTags([
      tag("项目", 21),
      ...Array.from({ length: 7 }, (_, index) =>
        tag(`项目/子标签${index + 1}`, 10 - index, { parentPath: "项目", depth: 1 }),
      ),
    ]);

    const { LibraryPage } = await import("../LibraryPage");
    const firstRender = render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await expandTag("项目");
    expect(screen.getByRole("button", { name: /子标签5/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /子标签6/ })).not.toBeInTheDocument();

    const showMoreButton = await screen.findByRole("button", { name: "展开更多（2）" });
    expect(showMoreButton).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(showMoreButton);
    expect(await screen.findByRole("button", { name: /子标签7/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起" })).toHaveAttribute("aria-expanded", "true");

    firstRender.unmount();
    const secondRender = render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await expandTag("项目");
    expect(await screen.findByRole("button", { name: /子标签7/ })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.getByRole("button", { name: /子标签5/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /子标签6/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /子标签7/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "展开更多（2）" })).toHaveAttribute("aria-expanded", "false");

    secondRender.unmount();
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await expandTag("项目");
    expect(screen.queryByRole("button", { name: /子标签6/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "展开更多（2）" }));
    expect(await screen.findByRole("button", { name: /子标签7/ })).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText("搜索标签"));
    await userEvent.type(screen.getByRole("textbox", { name: "搜索标签" }), "子标签");
    expect(screen.getByRole("button", { name: /子标签7/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "收起" })).not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole("textbox", { name: "搜索标签" }));
    expect(screen.getByRole("button", { name: "收起" })).toBeInTheDocument();
  });

  it("标签树可以用拼音快速查找并定位标签", async () => {
    mockTags([tag("项目", 1), tag("项目/合同", 1, { parentPath: "项目", depth: 1 })]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await userEvent.click(await screen.findByLabelText("搜索标签"));
    await userEvent.type(await screen.findByRole("textbox", { name: "搜索标签" }), "hetong");

    expect(await screen.findByRole("button", { name: /合同/ })).toBeInTheDocument();
  });
});

function mockTags(tags: LibraryTagNode[]): void {
  libraryApiMock.getLibrarySnapshot.mockResolvedValue(createLibrarySnapshot({ tags }));
  libraryApiMock.listLibraryTags.mockResolvedValue(tags);
}

function tag(
  path: string,
  documentCount: number,
  overrides: Partial<LibraryTagNode> = {},
): LibraryTagNode {
  const parts = path.split("/");
  return {
    path,
    name: parts.at(-1) ?? path,
    rootType: overrides.rootType ?? "manual",
    parentPath: overrides.parentPath ?? null,
    depth: overrides.depth ?? 0,
    documentCount,
    ...overrides,
  };
}

function systemRootLabel(label: string): string {
  if (label === "时间" || label === "time") return "时间范围";
  if (label === "类型" || label === "type") return "智能分类";
  return label;
}

async function expandTag(label: string): Promise<void> {
  const row = await screen.findByRole("treeitem", { name: systemRootLabel(label) });
  const toggle = within(row).queryByRole("button", { name: /展开标签/ });
  if (toggle) {
    await userEvent.click(toggle);
  }
}

function childTitlesOf(rootLabel: string): string[] {
  const root = screen.getByRole("treeitem", { name: systemRootLabel(rootLabel) });
  const group = within(root).getByRole("group");
  return within(group)
    .getAllByRole("button", { name: /^(?!按文件数量筛选)/ })
    .map((button) => button.textContent?.trim() ?? "")
    .filter(Boolean);
}
