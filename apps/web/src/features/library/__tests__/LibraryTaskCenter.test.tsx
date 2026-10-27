import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { LibraryTask } from "@x-file/shared";

import { LibraryTaskCenter } from "../LibraryTaskCenter";
import { listLibraryTasks, listenLibraryTaskUpdates } from "../../../api/library";
import { createIndexStatus } from "./mockLibraryApi";

vi.mock("../../../api/library", () => ({ listLibraryTasks: vi.fn(), listenLibraryTaskUpdates: vi.fn() }));

function task(overrides: Partial<LibraryTask> = {}): LibraryTask {
  return {
    taskId: "tags", taskType: "library.tag_assignment", rootDir: "/library",
    targetPath: "客户资料", source: "test", state: "running", stage: "export_snapshot",
    totalCount: 445, processedCount: 445, errorSummary: null,
    queuedAt: "2026-10-26T00:00:00Z", startedAt: "2026-10-26T00:00:00Z", completedAt: null,
    ...overrides,
  };
}

function center(root = "/library") {
  return <LibraryTaskCenter rootDir={root} fallbackState="fresh" fallbackLabel="已就绪"><p>索引详情</p></LibraryTaskCenter>;
}

describe("统一任务中心", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(listLibraryTasks).mockReset().mockResolvedValue([]);
    vi.mocked(listenLibraryTaskUpdates).mockReset().mockResolvedValue(() => {});
  });
  afterEach(() => vi.useRealTimers());

  it("三类任务使用宿主状态；标签处理满额但导出未结束时明确显示正在保存", async () => {
    vi.mocked(listLibraryTasks).mockResolvedValue([
      task(),
      task({ taskId: "scan", taskType: "library.file_scan", totalCount: null, processedCount: 82, stage: "scan_files" }),
      task({ taskId: "index", taskType: "library.index", state: "failed", errorSummary: "磁盘空间不足" }),
    ]);
    render(center());
    fireEvent.click(screen.getByRole("button", { name: /任务中心/ }));
    const dialog = await screen.findByRole("dialog", { name: "任务中心" });
    const tagTask = await within(dialog).findByRole("region", { name: "标签分配" });
    expect(within(tagTask).getByText("正在保存")).toBeInTheDocument();
    expect(within(tagTask).queryByText("已完成")).not.toBeInTheDocument();
    expect(within(tagTask).getByText("导出索引")).toBeInTheDocument();
    fireEvent.click(within(tagTask).getByRole("button", { name: "标签分配" }));
    expect(within(tagTask).getByText(/进行中 · 导出索引/)).toBeInTheDocument();
    expect(within(tagTask).getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    expect(within(tagTask).getByRole("progressbar")).toHaveAttribute("aria-busy", "true");
    const scan = within(dialog).getByRole("region", { name: "文件遍历" });
    expect(within(scan).getByText("已处理 82")).toBeInTheDocument();
    expect(within(scan).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(dialog).getByText("磁盘空间不足")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "任务中心：2 个任务进行中" })).toBeInTheDocument();
  });

  it("关闭面板后继续轮询后台任务，键盘可再次打开和关闭", async () => {
    vi.useFakeTimers();
    vi.mocked(listLibraryTasks).mockResolvedValue([task()]);
    render(center());
    await act(async () => {});
    const trigger = screen.getByRole("button", { name: /任务中心/ });
    fireEvent.click(trigger);
    await act(async () => {});
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    vi.mocked(listLibraryTasks).mockResolvedValue([task({ state: "completed", completedAt: "2026-10-26T00:00:02Z" })]);
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    fireEvent.click(trigger);
    await act(async () => {});
    expect(screen.getByRole("region", { name: "标签分配" }).querySelector("time")).toHaveAttribute("datetime", "2026-10-26T00:00:02Z");
    expect(listLibraryTasks).toHaveBeenCalledTimes(5);
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("切库时丢弃未完成的旧请求且不显示其他库任务", async () => {
    let resolveOld!: (tasks: LibraryTask[]) => void;
    vi.mocked(listLibraryTasks).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    const view = render(center());
    vi.mocked(listLibraryTasks).mockResolvedValue([
      task({ rootDir: "/other", targetPath: "新库任务" }), task({ targetPath: "旧库任务" }),
    ]);
    view.rerender(center("/other"));
    fireEvent.click(screen.getByRole("button", { name: /任务中心/ }));
    fireEvent.click(await screen.findByRole("button", { name: "标签分配" }));
    expect(await screen.findByText("新库任务")).toBeInTheDocument();
    await act(async () => { resolveOld([task({ targetPath: "过期任务" })]); });
    expect(screen.queryByText("旧库任务")).not.toBeInTheDocument();
    expect(screen.queryByText("过期任务")).not.toBeInTheDocument();
  });

  it("慢请求不会叠加轮询，读取失败显示错误并保留上一份记录", async () => {
    vi.useFakeTimers();
    vi.mocked(listLibraryTasks).mockResolvedValueOnce([task()]).mockRejectedValueOnce(new Error("连接中断"));
    render(center());
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
    // 打开面板会重新读取，但网络失败不能清空真实记录。
    vi.mocked(listLibraryTasks).mockImplementation(() => new Promise(() => {}));
    fireEvent.click(screen.getByRole("button", { name: /任务中心/ }));
    await act(async () => {});
    expect(screen.getByRole("alert")).toHaveTextContent("连接中断");
    fireEvent.click(screen.getByRole("button", { name: "标签分配" }));
    expect(screen.getByText("客户资料")).toBeInTheDocument();
    const count = vi.mocked(listLibraryTasks).mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(listLibraryTasks).toHaveBeenCalledTimes(count);
  });

  it("索引详情默认收起，点击或键盘操作任务行后才展开，并可再次收起", async () => {
    const user = userEvent.setup();
    vi.mocked(listLibraryTasks).mockResolvedValue([task({ taskId: "index", taskType: "library.index" })]);
    render(center());
    await user.click(screen.getByRole("button", { name: /任务中心/ }));
    const row = await screen.findByRole("button", { name: "文档库索引" });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("索引详情")).not.toBeInTheDocument();
    await user.click(row);
    expect(screen.getByText("索引详情")).toBeInTheDocument();
    expect(row).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Enter}");
    expect(screen.queryByText("索引详情")).not.toBeInTheDocument();
    expect(row).toHaveAttribute("aria-expanded", "false");
  });

  it("没有本次运行记录时仍可通过索引状态行查看当前索引详情", async () => {
    const user = userEvent.setup();
    render(center());
    await user.click(screen.getByRole("button", { name: /任务中心/ }));
    expect(screen.queryByText("索引详情")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "文档库索引" }));
    expect(screen.getByText("索引详情")).toBeInTheDocument();
    expect(screen.queryByText("暂无后台任务")).not.toBeInTheDocument();
  });

  it("索引状态行在未展开时显示当前数量、总量与进度预览", async () => {
    render(
      <LibraryTaskCenter rootDir="/library" fallbackState="running" fallbackLabel="正在刷新" indexProgress={{ processedCount: 2341, totalCount: 3500 }}>
        <p>索引详情</p>
      </LibraryTaskCenter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /任务中心/ }));
    const row = screen.getByRole("button", { name: "文档库索引" });
    expect(within(row).getByText("2,341 / 3,500")).toBeInTheDocument();
    expect(within(row).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "67");
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("索引详情")).not.toBeInTheDocument();
    await act(async () => {});
  });

  it("已完成的索引任务保留数量进度，无需展开详情", async () => {
    vi.mocked(listLibraryTasks).mockResolvedValue([
      task({ taskId: "finished-index", taskType: "library.index", state: "completed", processedCount: 19982, totalCount: 19982 }),
    ]);
    render(center());
    fireEvent.click(screen.getByRole("button", { name: /任务中心/ }));
    const count = await screen.findByText("19,982 / 19,982");
    expect(count).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "文档库索引" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("button", { name: "文档库索引" })).toHaveAttribute("aria-expanded", "false");
  });

  it("历史任务按完成时间倒序显示且最多显示五条，活跃任务不受限", async () => {
    const history = Array.from({ length: 7 }, (_, index) => task({
      taskId: `done-${index}`,
      taskType: "library.file_scan",
      targetPath: `历史任务-${index}`,
      state: "completed",
      completedAt: `2026-10-27T00:00:0${index}Z`,
    }));
    vi.mocked(listLibraryTasks).mockResolvedValue([
      ...history,
      task({ taskId: "active-a", targetPath: "活跃任务甲", state: "running" }),
      task({ taskId: "active-b", targetPath: "活跃任务乙", state: "queued" }),
    ]);
    render(center());
    fireEvent.click(screen.getByRole("button", { name: /任务中心/ }));
    const historyRows = await screen.findAllByRole("region", { name: "文件遍历" });
    expect(historyRows).toHaveLength(5);
    expect(screen.getAllByRole("region", { name: "标签分配" })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "任务中心：2 个任务进行中" })).toBeInTheDocument();
    expect(screen.getAllByRole("time").map((time) => time.getAttribute("datetime"))).toEqual([
      "2026-10-27T00:00:06Z",
      "2026-10-27T00:00:05Z",
      "2026-10-27T00:00:04Z",
      "2026-10-27T00:00:03Z",
      "2026-10-27T00:00:02Z",
    ]);
  });

  it("标签任务标题直接显示分类名称及数量进度", async () => {
    const category = "客户/麦迪格眼科医院集团有限公司";
    vi.mocked(listLibraryTasks).mockResolvedValue([
      task({ categoryTitle: category, processedCount: 1847, totalCount: 4389 }),
    ]);
    render(center());
    fireEvent.click(screen.getByRole("button", { name: /任务中心/ }));
    const categoryTitle = await screen.findByText(category);
    expect(categoryTitle).toHaveClass("library-task-category");
    expect(categoryTitle).toHaveAttribute("title", category);
    expect(categoryTitle.closest(".library-task-card-heading")).toHaveTextContent("标签分配");
    expect(screen.getByText("1,847 / 4,389")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "标签分配" })).toHaveAttribute("aria-expanded", "false");
  });

  it("没有索引任务记录时，索引状态按实际完成时间参与排序且不固定置顶", async () => {
    vi.mocked(listLibraryTasks).mockResolvedValue([
      task({ taskId: "older", state: "completed", completedAt: "2026-10-27T00:00:01Z", categoryTitle: "较早任务" }),
      task({ taskId: "newer", state: "completed", completedAt: "2026-10-27T00:00:03Z", categoryTitle: "较新任务" }),
      task({ taskId: "active", state: "running", categoryTitle: "当前任务" }),
    ]);
    render(
      <LibraryTaskCenter rootDir="/library" fallbackState="fresh" fallbackLabel="已就绪"
        indexStatus={createIndexStatus({ lastCompletedAt: "2026-10-27T00:00:02Z" })}>
        <p>索引详情</p>
      </LibraryTaskCenter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /任务中心/ }));
    await screen.findByText("较新任务");
    const headings = [...screen.getByRole("dialog").querySelectorAll(".library-task-card-heading")]
      .map((heading) => heading.textContent);
    expect(headings[0]).toContain("当前任务");
    expect(headings[1]).toContain("较新任务");
    expect(headings[2]).toContain("文档库索引");
    expect(headings[3]).toContain("较早任务");
    fireEvent.click(screen.getByRole("button", { name: "文档库索引" }));
    expect(screen.getByText("索引详情")).toBeInTheDocument();
  });

  it("旧索引状态同样受五条历史上限约束，不额外占据列表首行", async () => {
    vi.mocked(listLibraryTasks).mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => task({
        taskId: `recent-${index}`, state: "completed",
        completedAt: `2026-10-27T00:00:0${index + 2}Z`,
      })),
    );
    render(
      <LibraryTaskCenter rootDir="/library" fallbackState="fresh" fallbackLabel="已就绪"
        indexStatus={createIndexStatus({ lastCompletedAt: "2026-10-27T00:00:01Z" })}>
        <p>索引详情</p>
      </LibraryTaskCenter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /任务中心/ }));
    await screen.findAllByRole("region", { name: "标签分配" });
    expect(screen.getAllByRole("region", { name: "标签分配" })).toHaveLength(5);
    expect(screen.queryByRole("button", { name: "文档库索引" })).not.toBeInTheDocument();
  });

  it("桌面事件实时更新保存进度，较早开始的轮询不能覆盖新事件", async () => {
    let update!: (task: LibraryTask) => void;
    let resolvePoll!: (tasks: LibraryTask[]) => void;
    vi.mocked(listenLibraryTaskUpdates).mockImplementation(async (callback) => {
      update = callback;
      return () => {};
    });
    vi.mocked(listLibraryTasks).mockImplementation(() => new Promise((resolve) => { resolvePoll = resolve; }));
    render(center());
    fireEvent.click(screen.getByRole("button", { name: /任务中心/ }));
    const saving = task({
      stage: "export_details", processedCount: 40, totalCount: 40,
      stageProgress: { processedCount: 20, totalCount: 200 },
    });
    await act(async () => { update(saving); });
    expect(screen.getByText("40 / 40")).toBeInTheDocument();
    expect(screen.getByText("保存文档详情 · 20 / 200")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "标签分配" })).toHaveAttribute("aria-valuenow", "10");
    await act(async () => { resolvePoll([task({ stage: "apply_tags", processedCount: 0, totalCount: 40 })]); });
    expect(screen.getByText("保存文档详情 · 20 / 200")).toBeInTheDocument();
    await act(async () => { update({ ...saving, stageProgress: { processedCount: 80, totalCount: 200 } }); });
    expect(screen.getByRole("progressbar", { name: "标签分配" })).toHaveAttribute("aria-valuenow", "40");
    await act(async () => { update({ ...saving, stage: "export_relations", stageProgress: { processedCount: 0, totalCount: null } }); });
    expect(screen.getByText("保存文档关联")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "标签分配" })).not.toHaveAttribute("aria-valuenow");
    expect(screen.queryByText("已完成")).not.toBeInTheDocument();
  });

  it("统计文件期间不显示虚构的总数或百分比", async () => {
    vi.mocked(listLibraryTasks).mockResolvedValue([
      task({ stage: "count_tag_files", totalCount: null, processedCount: 0 }),
    ]);
    render(center());
    fireEvent.click(screen.getByRole("button", { name: /任务中心/ }));
    const counting = await screen.findByText("正在统计待分配文件…");
    expect(counting).toBeInTheDocument();
    const row = screen.getByRole("button", { name: "标签分配" });
    expect(within(row).getByText("正在统计")).toBeInTheDocument();
    expect(within(row).queryByRole("progressbar")).not.toBeInTheDocument();
    expect(within(row).queryByText("0 / 0")).not.toBeInTheDocument();
  });

  it("后台计数按固定总量更新，未处理最后一个文件时不能显示百分之百", async () => {
    vi.useFakeTimers();
    vi.mocked(listLibraryTasks).mockResolvedValue([
      task({ stage: "apply_tags", totalCount: 445, processedCount: 0 }),
    ]);
    render(center());
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /任务中心/ }));
    await act(async () => {});
    expect(screen.getByText("0 / 445")).toBeInTheDocument();
    for (const count of [148, 444]) {
      vi.mocked(listLibraryTasks).mockResolvedValue([
        task({ stage: "apply_tags", totalCount: 445, processedCount: count }),
      ]);
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(screen.getByText(`${count} / 445`)).toBeInTheDocument();
      expect(screen.getByRole("progressbar", { name: "标签分配" })).not.toHaveAttribute("aria-valuenow", "100");
    }
    vi.mocked(listLibraryTasks).mockResolvedValue([
      task({ stage: "save_tag_results", totalCount: 445, processedCount: 445 }),
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(screen.getByText("445 / 445")).toBeInTheDocument();
    expect(screen.getByText("正在保存")).toBeInTheDocument();
    vi.mocked(listLibraryTasks).mockResolvedValue([
      task({ state: "completed", stage: null, totalCount: 445, processedCount: 445 }),
    ]);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(screen.queryByText("正在保存")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "标签分配" })).toHaveAttribute("data-state", "completed");
  });
});
