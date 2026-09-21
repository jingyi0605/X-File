import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryDocumentList } from "@x-file/shared";

import {
  createDocumentList,
  createDocumentRecord,
  createFileList,
  createFileNode,
  createIndexStatus,
  createLibraryBinding,
  createLibraryConfig,
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

describe("第 6 批：索引状态、刷新策略和缓存替换", () => {
  beforeEach(() => {
    localStorage.clear();
    resetLibraryApiMock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("索引状态指示灯悬浮后显示详情、当前阶段、导出阶段、进度和可滚动技术详情", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        status: createIndexStatus({
          state: "running",
          dirtyReasons: ["manual_refresh"],
          lastRequestedAt: "2026-06-10T01:00:00.000Z",
          lastStartedAt: "2026-06-10T01:00:01.000Z",
          lastCompletedAt: "2026-06-10T00:59:00.000Z",
          lastFailedAt: "2026-06-10T00:58:00.000Z",
          nextAllowedAt: "2026-06-10T01:01:00.000Z",
          runningTaskId: "task-export-search",
          runningStage: "export_search",
          errorSummary: "测试错误摘要",
          progress: {
            scannedCount: 12,
            indexedCount: 3,
            unchangedCount: 8,
            skippedCount: 1,
            failedCount: 0,
            totalCount: null,
            maxConcurrency: 1,
            activeTaskCount: 1,
            pendingTaskCount: 0,
            completedTaskCount: 12,
          },
        }),
      }),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    const indicator = await screen.findByRole("button", { name: /索引状态.*正在刷新/ });
    expect(screen.queryByText("文档库索引器状态")).not.toBeInTheDocument();

    // 顶部索引状态按钮不再展示长句进度说明
    expect(screen.queryByText("已处理 12，其中新增索引 3，失败 0")).not.toBeInTheDocument();

    await userEvent.hover(indicator);

    const popover = await screen.findByRole("dialog", { name: "文档库索引器状态" });
    expect(within(popover).getByText("当前状态")).toBeInTheDocument();
    expect(within(popover).getByText("正在刷新")).toBeInTheDocument();
    expect(within(popover).getByText("运行阶段")).toBeInTheDocument();
    expect(within(popover).getByText("导出搜索索引")).toBeInTheDocument();
    // 错误摘要出现在主信息区（始终可见）
    expect(within(popover).getByText("错误摘要")).toBeInTheDocument();
    expect(within(popover).getByText("测试错误摘要")).toBeInTheDocument();

    // 摘要指标四栏：已扫描数量 / 已索引数量 等标签可见
    expect(within(popover).getByText("已扫描数量")).toBeInTheDocument();
    expect(within(popover).getByText("已索引数量")).toBeInTheDocument();

    // 技术详情默认折叠，点击展开后才显示时间线
    const technicalToggle = within(popover).getByRole("button", { name: "技术详情" });
    expect(within(popover).queryByText("最近完成")).not.toBeInTheDocument();
    await userEvent.click(technicalToggle);

    const technical = within(popover).getByText("最近完成");
    expect(technical).toBeInTheDocument();
  });

  it("第一次初始化扫描时，中间主区显示全幅进度态而不是空白空态", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        documentCount: 0,
        status: createIndexStatus({
          state: "running",
          runningTaskId: "task-bootstrap",
          runningStage: "index_text",
          lastCompletedAt: null,
          progress: {
            scannedCount: 45,
            indexedCount: 32,
            unchangedCount: 13,
            skippedCount: 0,
            failedCount: 0,
            totalCount: 100,
            maxConcurrency: 1,
            activeTaskCount: 1,
            pendingTaskCount: 0,
            completedTaskCount: 45,
          },
        }),
      }),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(createDocumentList());

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    const indicator = await screen.findByRole("button", { name: /索引状态.*正在刷新/ });
    expect(await screen.findByText("正在初始化文档库")).toBeInTheDocument();
    expect(within(indicator).getByText("45%")).toBeInTheDocument();
    expect(screen.getByText("索引进度 45%")).toBeInTheDocument();
    expect(screen.getByText("已处理 45 / 100（其中新增索引 32）")).toBeInTheDocument();
    expect(screen.getByText("已处理 45，其中新增索引 32，失败 0")).toBeInTheDocument();
    expect(screen.queryByText("这个位置暂时没有可显示的文档。")).not.toBeInTheDocument();
  });

  it("点击刷新按钮会手动请求文档库刷新", async () => {
    const runningStatus = createIndexStatus({
      state: "running",
      dirtyReasons: ["manual_refresh"],
      runningTaskId: "task-refresh-1",
      runningStage: "index",
    });
    libraryApiMock.requestLibraryRefresh.mockResolvedValue({
      taskId: "task-refresh-1",
      deduped: false,
      status: runningStatus,
    });

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await userEvent.click(await screen.findByRole("button", { name: "刷新文档库" }));

    await waitFor(() => {
      expect(libraryApiMock.requestLibraryRefresh).toHaveBeenCalledWith({
        reason: "manual_refresh",
        targetPath: null,
      });
    });
  });

  it("进入子文件夹后刷新仍请求全量索引", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        folders: [
          {
            path: "售前文档",
            name: "售前文档",
            parentPath: null,
            directDocumentCount: 56,
            documentCount: 7929,
          },
        ],
      }),
    );
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([
        createFileNode({ path: "售前文档", name: "售前文档", kind: "directory" }),
      ]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await userEvent.dblClick(await screen.findByRole("button", { name: /售前文档/ }));
    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(
        expect.objectContaining({ selectedFolderPath: "售前文档" }),
      );
    });

    await userEvent.click(screen.getByRole("button", { name: "刷新文档库" }));

    await waitFor(() => {
      expect(libraryApiMock.requestLibraryRefresh).toHaveBeenCalledWith({
        reason: "manual_refresh",
        targetPath: null,
      });
    });
  });

  it("接口返回新列表后替换旧缓存，已删除文件不会继续显示", async () => {
    libraryApiMock.listLibraryDocuments
      .mockResolvedValueOnce(
        createDocumentList([
          createDocumentRecord({
            documentId: "doc-old",
            path: "docs/已删除旧文件.md",
          }),
        ]),
      )
      .mockResolvedValueOnce(
        createDocumentList([
          createDocumentRecord({
            documentId: "doc-new",
            path: "docs/新文件.md",
          }),
        ]),
      );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    expect(await screen.findByText("已删除旧文件.md")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "刷新文档库" }));

    expect(await screen.findByText("新文件.md")).toBeInTheDocument();
    expect(screen.queryByText("已删除旧文件.md")).not.toBeInTheDocument();
  });

  it("稳态下 progress 缺失时用文档计数兜底显示摘要网格与目录状态", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        documentCount: 17316,
        status: createIndexStatus({
          state: "fresh",
          progress: null,
        }),
      }),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ path: "docs/稳态文件.md" })], {
        directoryStatus: {
          path: ".",
          state: "fresh",
          source: "snapshot",
          lastRequestedAt: null,
          lastCompletedAt: "2026-06-09T00:00:00.000Z",
          lastFailedAt: null,
          runningTaskId: null,
          errorSummary: null,
        },
      }),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    const indicator = await screen.findByRole("button", { name: /索引状态.*已就绪/ });
    await userEvent.hover(indicator);

    const popover = await screen.findByRole("dialog", { name: "文档库索引器状态" });
    // progress 缺失时摘要网格不再空白：四栏标签全部出现
    expect(within(popover).getByText("索引总数")).toBeInTheDocument();
    expect(within(popover).getByText("已扫描数量")).toBeInTheDocument();
    expect(within(popover).getByText("问题数量")).toBeInTheDocument();
    expect(within(popover).getByText("已索引数量")).toBeInTheDocument();
    // 用 documentCount 兜底后，“索引总数 / 已扫描数量 / 已索引数量”都会回到文档计数。
    expect(within(popover).getAllByText("17316").length).toBeGreaterThanOrEqual(2);
    // 当前概览补充目录状态两行（对齐父仓库图2）
    expect(within(popover).getByText("当前目录")).toBeInTheDocument();
    expect(within(popover).getByText("根目录")).toBeInTheDocument();
    expect(within(popover).getByText("目录刷新状态")).toBeInTheDocument();
  });

  it("进入文档库视图时不会仅因为快照较旧自动发起刷新", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        status: createIndexStatus({
          state: "fresh",
          lastCompletedAt: "2026-06-09T00:00:00.000Z",
        }),
      }),
    );
    libraryApiMock.listLibraryDocuments.mockResolvedValue(
      createDocumentList([createDocumentRecord({ path: "docs/普通文件.md" })]),
    );

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    expect(await screen.findByText("普通文件.md")).toBeInTheDocument();
    expect(libraryApiMock.requestLibraryRefresh).not.toHaveBeenCalled();
  });

  it("索引运行中会自动轮询状态，并在完成后刷新当前显示", async () => {
    libraryApiMock.getLibrarySnapshot
      .mockResolvedValueOnce(
        createLibrarySnapshot({
          status: createIndexStatus({
            state: "running",
            runningTaskId: "task-running",
            runningStage: "index",
            lastCompletedAt: null,
          }),
        }),
      )
      .mockResolvedValue(
        createLibrarySnapshot({
          status: createIndexStatus({
            state: "fresh",
            runningTaskId: null,
            runningStage: null,
            lastCompletedAt: "2026-06-10T01:00:03.000Z",
          }),
        }),
      );
    libraryApiMock.listLibraryDocuments
      .mockResolvedValueOnce(createDocumentList([createDocumentRecord({ path: "docs/运行中.md" })]))
      .mockResolvedValue(createDocumentList([createDocumentRecord({ path: "docs/完成后.md" })]));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    expect(await screen.findByText("运行中.md")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /索引状态.*正在刷新/ })).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 4300));
    });

    await waitFor(() => expect(libraryApiMock.getLibrarySnapshot).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: /索引状态.*已就绪/ })).toBeInTheDocument();
    expect(await screen.findByText("完成后.md")).toBeInTheDocument();
  }, 10_000);

  it("目录模式下索引仍在 running 时轮询会主动重拉当前目录列表", async () => {
    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        status: createIndexStatus({
          state: "running",
          runningTaskId: "task-running",
          runningStage: "index",
        }),
        folders: [
          { path: "临时文件", name: "临时文件", parentPath: null, directDocumentCount: 0, documentCount: 2 },
        ],
      }),
    );
    libraryApiMock.listLibraryFiles.mockResolvedValue(
      createFileList([createFileNode({ path: "临时文件", name: "临时文件", kind: "directory" })]),
    );
    libraryApiMock.listLibraryDocuments
      .mockResolvedValueOnce(createDocumentList([createDocumentRecord({ path: "docs/根目录旧文件.md" })]))
      .mockResolvedValueOnce(createDocumentList([createDocumentRecord({ path: "临时文件/账号.md" })]))
      .mockResolvedValue(createDocumentList([createDocumentRecord({ path: "临时文件/账号_副本.md" })]));

    const { LibraryPage } = await import("../LibraryPage");
    render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await userEvent.dblClick(await screen.findByRole("button", { name: /临时文件/ }));
    expect(await screen.findByText("账号.md")).toBeInTheDocument();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 4300));
    });

    await waitFor(() => {
      expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(
        expect.objectContaining({
          browseMode: "folder",
          selectedFolderPath: "临时文件",
        }),
      );
    });
    expect(await screen.findByText("账号_副本.md")).toBeInTheDocument();
  }, 10_000);

  it("空列表在索引轮询期间保持空态稳定，不会反复闪回骨架屏", async () => {
    let resolveSecondDocuments: ((value: LibraryDocumentList) => void) | undefined;
    let pollCallback: (() => void) | null = null;
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation((((handler: TimerHandler) => {
        if (typeof handler === "function") {
          pollCallback = handler as () => void;
        }
        return 1;
      }) as typeof window.setInterval));
    const clearIntervalSpy = vi
      .spyOn(window, "clearInterval")
      .mockImplementation((() => undefined) as typeof window.clearInterval);

    libraryApiMock.getLibrarySnapshot.mockResolvedValue(
      createLibrarySnapshot({
        status: createIndexStatus({
          state: "running",
          runningTaskId: "task-running",
          runningStage: "index",
        }),
      }),
    );
    libraryApiMock.listLibraryDocuments
      .mockResolvedValueOnce(createDocumentList())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondDocuments = resolve;
          }),
      )
      .mockResolvedValue(createDocumentList());

    const { LibraryPage } = await import("../LibraryPage");
    const rendered = render(<LibraryPage onOpenSettings={vi.fn()} platformData={platformData} />);

    await waitFor(() => {
      expect(screen.getByText("这个位置暂时没有可显示的文档。")).toBeInTheDocument();
    });
    expect(document.querySelector(".affairs-stage-skeleton")).toBeNull();

    await act(async () => {
      pollCallback?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("这个位置暂时没有可显示的文档。")).toBeInTheDocument();
    expect(document.querySelector(".affairs-stage-skeleton")).toBeNull();

    if (resolveSecondDocuments) {
      resolveSecondDocuments(createDocumentList());
    }
    await act(async () => {
      await Promise.resolve();
    });
    rendered.unmount();
    clearIntervalSpy.mockRestore();
    setIntervalSpy.mockRestore();
  });

});
