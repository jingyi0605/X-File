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

  it("时间标签按最新优先，其他标签按访问数量优先，并显示最近7天标签", async () => {
    mockTags([
      tag("时间", 10, { rootType: "time" }),
      tag("时间/更早", 9, { rootType: "time", parentPath: "时间", depth: 1 }),
      tag("时间/最近7天", 4, { rootType: "time", parentPath: "时间", depth: 1 }),
      tag("项目", 10),
      tag("项目/低频", 1, { parentPath: "项目", depth: 1 }),
      tag("项目/高频", 8, { parentPath: "项目", depth: 1 }),
    ]);

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={() => undefined} platformData={platformData} />);

    await expandTag("时间");
    await expandTag("项目");

    const timeChildren = childTitlesOf("时间");
    expect(timeChildren[0]).toContain("最近7天");
    const projectChildren = childTitlesOf("项目");
    expect(projectChildren[0]).toContain("高频");
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
