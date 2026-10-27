import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runNativeLibraryWorker as runBuiltNativeLibraryWorker } from "@x-file/indexer";

import { runNativeLibraryWorker, type NativeLibraryTaskProgress } from "./native-client.js";

test("标签 worker 在结束前逐行传递进度并忽略无效记录", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-worker-progress-"));
  const executable = path.join(directory, "worker.sh");
  const acknowledgement = path.join(directory, "progress-received");
  const acknowledgementArg = `'${acknowledgement.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    "cat >/dev/null",
    "printf '%s' '[x-file-tag-progress] {\"stage\":\"apply_tags\",' >&2",
    "sleep 0.05",
    "printf '%s\\n' '\"processedCount\":1,\"totalCount\":3}' >&2",
    "printf '%s\\n' '[x-file-tag-progress] null' >&2",
    "printf '%s\\n' '[x-file-tag-progress] {\"stage\":\"export_details\",\"processedCount\":3,\"totalCount\":3,\"stageProgress\":{\"processedCount\":12,\"totalCount\":100}}' >&2",
    "printf '%s\\n' '[x-file-tag-progress] {\"stage\":\"export_details\",\"processedCount\":3,\"totalCount\":3,\"stageProgress\":{\"processedCount\":-1,\"totalCount\":100}}' >&2",
    "attempt=0",
    `while [ ! -f ${acknowledgementArg} ] && [ \"$attempt\" -lt 100 ]; do`,
    "  sleep 0.01",
    "  attempt=$((attempt + 1))",
    "done",
    `[ -f ${acknowledgementArg} ] || exit 3`,
    "printf '%s\\n' '{\"ok\":true}'",
    "sleep 0.15",
  ].join("\n"), "utf8");
  fs.chmodSync(executable, 0o755);
  const originalPath = process.env.X_FILE_DESKTOP_CLI_PATH;
  process.env.X_FILE_DESKTOP_CLI_PATH = executable;
  const progress: unknown[] = [];
  let resolved = false;
  try {
    const resultPromise = runNativeLibraryWorker<{ ok: boolean }>("tags-only", { rootDir: directory }, undefined, (item) => {
      progress.push(item);
      assert.equal(resolved, false);
      fs.writeFileSync(acknowledgement, "received");
    }).then((result) => { resolved = true; return result; });
    const result = await resultPromise;
    assert.deepEqual(progress, [
      { stage: "apply_tags", processedCount: 1, totalCount: 3 },
      { stage: "export_details", processedCount: 3, totalCount: 3, stageProgress: { processedCount: 12, totalCount: 100 } },
      { stage: "export_details", processedCount: 3, totalCount: 3 },
    ]);
    assert.deepEqual(result, { ok: true });
  } finally {
    if (originalPath === undefined) delete process.env.X_FILE_DESKTOP_CLI_PATH;
    else process.env.X_FILE_DESKTOP_CLI_PATH = originalPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("真实原生 CLI 分开报告四十个标签文件与保存进度，并保留索引时间线", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-tag-stages-"));
  const runtime = path.join(root, ".ai-index/runtime");
  fs.mkdirSync(runtime, { recursive: true });
  const now = "2026-10-27T00:00:00Z";
  const documents = Array.from({ length: 120 }, (_, index) => ({
    documentId: `doc-${index}`, path: `${index < 40 ? "target" : "other"}/${index}.md`,
    title: `文件 ${index}`, summary: "", tags: ["原有标签"], derivedTags: [], mtime: now,
  }));
  const snapshotPath = path.join(runtime, "export-catalog-snapshot.json");
  fs.writeFileSync(snapshotPath, JSON.stringify({ version: 1, generatedAt: now, documents, tags: [] }));
  const statusPath = path.join(root, ".ai-index/runtime-status.json");
  const indexStatus = { state: "fresh", lastCompletedAt: "2026-10-26T00:00:00Z" };
  fs.writeFileSync(statusPath, JSON.stringify(indexStatus));
    const progress: NativeLibraryTaskProgress[] = [];
  try {
    const input = {
      rootDir: root, tagScope: { kind: "folder" as const, folderPath: "target" },
      tagStore: {
        libraryId: "test", rootDir: root, tags: [], tagRules: [], documentTags: [],
        folderTags: [], updatedAt: now,
      },
    };
    await runBuiltNativeLibraryWorker<{ scannedCount: number; updatedCount: number }>("tags-only", input);
    const result = await runBuiltNativeLibraryWorker<{ scannedCount: number; updatedCount: number }>("tags-only", input, undefined, (item) => progress.push(item));
    assert.equal(result.scannedCount, 40);
    assert.equal(result.updatedCount, 40);
    assert.deepEqual(progress.find((item) => item.stage === "apply_tags"), {
      stage: "apply_tags", processedCount: 0, totalCount: 40,
    });
    assert.deepEqual(progress.find((item) => item.stage === "export_details"), {
      stage: "export_details", processedCount: 40, totalCount: 40,
      stageProgress: { processedCount: 0, totalCount: 40 },
    });
    assert.equal(progress.some((item) => item.stage === "export_details"
      && item.stageProgress?.processedCount === 40), true);
    assert.equal(progress.at(-1)?.stage, "publish_tag_results");
    assert.deepEqual(JSON.parse(fs.readFileSync(statusPath, "utf8")), indexStatus);
    const saved = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as { documents: typeof documents };
    assert.deepEqual(saved.documents[0]?.tags, []);
    assert.deepEqual(saved.documents[40]?.tags, ["原有标签"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
