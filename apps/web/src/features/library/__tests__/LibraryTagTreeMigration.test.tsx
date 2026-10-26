import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    const rootItem = within(tree).getByRole("treeitem", { name: root });
    const rootButton = within(rootItem).getByRole("button", { name: `${root} 2` });
    const initialRequestCount = libraryApiMock.listLibraryDocuments.mock.calls.length;

    expect(rootButton).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(rootButton);
    expect(rootItem).toHaveAttribute("aria-expanded", "true");
    expect(rootButton).toHaveAttribute("aria-expanded", "true");
    expect(within(rootItem).getByRole("button", { name: "分组 2" })).toBeInTheDocument();

    await userEvent.click(rootButton);
    expect(rootItem).toHaveAttribute("aria-expanded", "false");
    expect(within(rootItem).queryByRole("group")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("清除标签筛选")).not.toBeInTheDocument();
    expect(libraryApiMock.listLibraryDocuments).toHaveBeenCalledTimes(initialRequestCount);

    await userEvent.click(within(rootItem).getByRole("button", { name: "展开标签" }));
    await userEvent.click(within(rootItem).getByRole("button", { name: "分组 2" }));
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

  it("自定义根标签仍可点击筛选", async () => {
    mockTags([
      tag("项目", 2),
      tag("项目/时间", 1, { parentPath: "项目", depth: 1 }),
    ]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await userEvent.click(await screen.findByRole("button", { name: "项目 2" }));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        browseMode: "tag",
        selectedTagPaths: ["项目"],
      }));
    });
    await expandTag("项目");
    await userEvent.click(screen.getByRole("button", { name: /时间/ }));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedTagPaths: ["项目/时间"],
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
    const pdfButton = await within(tree).findByRole("button", { name: /PDF/ });
    expect(within(pdfButton).getByText("2")).toBeInTheDocument();
    expect(within(tree).queryByRole("button", { name: /Markdown/ })).not.toBeInTheDocument();
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
    expect(timeChildren).toEqual(["最近3天2", "最近7天4", "更早9"]);
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
    const timeRoot = screen.getByRole("treeitem", { name: "时间" });
    const timeChildren = timeRoot.querySelectorAll(":scope > [role=group] > [role=treeitem]");
    expect(Array.from(timeChildren, (child) => child.getAttribute("aria-label")))
      .toEqual(["2026", "2025", "2024"]);

    await expandTag("2026");
    expect(childTitlesOf("2026")).toEqual(["122", "91", "023"]);
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
    expect(childTitlesOf("时间")).toEqual(["20241"]);

    await userEvent.click(screen.getByRole("button", { name: "2024 1" }));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedTagPaths: ["时间/2024"],
      }));
    });
    expect(childTitlesOf("时间")).toEqual(["20240"]);
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
    expect(childTitlesOf("时间")).toEqual(["最近3天2", "最近7天3"]);
    await userEvent.click(screen.getByRole("button", { name: "最近3天 2" }));

    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedTagPaths: ["时间/最近3天"],
      }));
    });
    expect(childTitlesOf("时间")).toEqual(["最近3天0"]);
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
        expect(within(tree).getByRole("button", { name: `${label(value)} ${count}` })).toBeInTheDocument();
      }
      expect(within(tree).queryByRole("treeitem", { name: label(90) })).not.toBeInTheDocument();
    };
    const selectRecentTag = async () => {
      await userEvent.click(within(tree).getByRole("button", { name: `${label(days)} ${selectedCount}` }));
      await waitFor(() => {
        expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
          selectedTagPaths: [selectedPath],
        }));
      });
      expect(within(tree).getByRole("button", { name: `${label(days)} ${selectedCount}` })).toBeInTheDocument();
      for (const value of recentCounts.keys()) {
        if (value !== days) {
          expect(within(tree).queryByRole("treeitem", { name: label(value) })).not.toBeInTheDocument();
        }
      }
      expect(within(tree).getByRole("treeitem", { name: "2026" })).toBeInTheDocument();
    };

    expectAllRecentTags();
    await selectRecentTag();
    await userEvent.click(within(tree).getByRole("button", { name: `2026 ${selectedCount}` }));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(expect.objectContaining({
        selectedTagPaths: [yearPath],
      }));
    });
    expectAllRecentTags();

    await selectRecentTag();
    await userEvent.click(within(tree).getByRole("button", { name: `${label(days)} ${selectedCount}` }));
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
    expect(childTitlesOf("time")).toEqual(["recent-7-days1", "20261", "20251"]);
  });

  it("每层标签默认最多显示 5 个，并记住展开更多状态", async () => {
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

    await userEvent.click(await screen.findByRole("button", { name: /展开更多/ }));
    expect(await screen.findByRole("button", { name: /子标签7/ })).toBeInTheDocument();

    firstRender.unmount();
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);
    await expandTag("项目");
    expect(await screen.findByRole("button", { name: /子标签7/ })).toBeInTheDocument();
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

async function expandTag(label: string): Promise<void> {
  const row = await screen.findByRole("treeitem", { name: label });
  const toggle = within(row).queryByRole("button", { name: /展开标签/ });
  if (toggle) {
    await userEvent.click(toggle);
  }
}

function childTitlesOf(rootLabel: string): string[] {
  const root = screen.getByRole("treeitem", { name: rootLabel });
  const group = within(root).getByRole("group");
  return within(group)
    .getAllByRole("button")
    .map((button) => button.textContent?.trim() ?? "")
    .filter(Boolean);
}
