import { describe, expect, it } from "vitest";

import { getMirrorSyncTasks, updateMirrorSyncProgress } from "./mirror-sync-progress";

describe("镜像同步任务历史", () => {
  it("每次进入连接阶段都会创建独立任务，后续阶段只更新当前任务", () => {
    const before = getMirrorSyncTasks().length;

    updateMirrorSyncProgress({
      phase: "connecting",
      transport: "snapshot",
      receivedDocuments: 0,
      totalDocuments: 10,
      receivedBytes: 0,
      totalBytes: 100,
    });
    const firstTask = getMirrorSyncTasks()[0];
    updateMirrorSyncProgress({ phase: "receiving", receivedDocuments: 5, receivedBytes: 50 });
    expect(getMirrorSyncTasks()).toHaveLength(before + 1);
    expect(getMirrorSyncTasks()[0]).toMatchObject({
      taskId: firstTask.taskId,
      phase: "receiving",
      receivedDocuments: 5,
      receivedBytes: 50,
    });

    updateMirrorSyncProgress({ phase: "complete" });
    updateMirrorSyncProgress({
      phase: "connecting",
      transport: "snapshot",
      receivedDocuments: 0,
      totalDocuments: 20,
      receivedBytes: 0,
      totalBytes: 200,
    });
    expect(getMirrorSyncTasks()).toHaveLength(before + 2);
    expect(getMirrorSyncTasks()[0].taskId).not.toBe(firstTask.taskId);
    expect(getMirrorSyncTasks()[1]).toMatchObject({
      taskId: firstTask.taskId,
      phase: "complete",
    });
  });
});
