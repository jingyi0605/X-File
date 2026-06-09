import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLibraryIndexOnce } from "@x-file/indexer";

import { LibraryService } from "./library-service.js";
import { TagService } from "./tag-service.js";
import { LibraryBindingStore } from "../storage/library-binding-store.js";
import { TagStore } from "../storage/tag-store.js";
import { TaskManager } from "../tasks/task-manager.js";

test("tag ensure 使用 libraryId/rootDir 存储并创建层级标签", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-tags-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });

  const bindingStore = new LibraryBindingStore({ dataDir });
  new LibraryService(bindingStore).saveBinding({
    rootDir,
    completeInitialization: true,
  });
  const tagService = new TagService(bindingStore, new TagStore({ dataDir }));

  const ensured = tagService.ensureTag({ path: " 项目 / 设计 " });
  assert.equal(ensured.path, "项目/设计");
  assert.equal(ensured.name, "设计");
  assert.equal(ensured.parentPath, "项目");

  const list = tagService.listTags();
  assert.equal(list.items.length, 2);

  const details = tagService.saveDocumentTags("docs/a.md", {
    tagIds: [ensured.id],
    createTagPaths: ["状态/进行中"],
  });
  assert.equal(details.documentId, "docs/a.md");
  assert.equal(details.manualTagIds.length, 2);
  assert.equal(details.resolvedTags.length, 2);
});

test("标签支持详情、编辑、禁用和删除子树", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-tags-crud-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });

  const bindingStore = new LibraryBindingStore({ dataDir });
  new LibraryService(bindingStore).saveBinding({
    rootDir,
    completeInitialization: true,
  });
  const tagService = new TagService(bindingStore, new TagStore({ dataDir }));

  const parent = tagService.ensureTag({ path: "项目" });
  const child = tagService.ensureTag({ path: "项目/设计" });
  const updated = tagService.updateTag(parent.id, {
    name: "产品",
    parentId: null,
    description: "产品资料",
    status: "disabled",
  });

  assert.equal(updated.path, "产品");
  assert.equal(updated.status, "disabled");
  assert.equal(tagService.getTagDetail(child.id).path, "产品/设计");

  const deleted = tagService.deleteTag(parent.id);
  assert.deepEqual(
    new Set(deleted.deletedTagIds),
    new Set([parent.id, child.id]),
  );
  assert.equal(tagService.listTags({ includeDisabled: true }).items.length, 0);
});

test("标签详情会基于文档路径和目录上下文给出推荐标签", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "x-file-tags-recommend-"),
  );
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });

  const bindingStore = new LibraryBindingStore({ dataDir });
  new LibraryService(bindingStore).saveBinding({
    rootDir,
    completeInitialization: true,
  });
  const tagService = new TagService(bindingStore, new TagStore({ dataDir }));

  const product = tagService.ensureTag({ path: "产品/需求" });
  const meeting = tagService.ensureTag({ path: "会议纪要" });
  const disabled = tagService.ensureTag({ path: "废弃" });
  tagService.updateTag(disabled.id, { status: "disabled" });

  const documentDetails =
    tagService.getDocumentTagDetails("产品资料/需求/移动端需求说明.md");
  assert.equal(
    documentDetails.recommendedTags?.some((item) => item.path === product.path),
    true,
  );
  assert.equal(
    documentDetails.recommendedTags?.some(
      (item) => item.path === disabled.path,
    ),
    false,
  );

  tagService.saveDocumentTags("产品资料/需求/移动端需求说明.md", {
    tagIds: [product.id],
  });
  const assignedDetails =
    tagService.getDocumentTagDetails("产品资料/需求/移动端需求说明.md");
  assert.equal(
    assignedDetails.recommendedTags?.some((item) => item.path === product.path),
    false,
  );

  const folderDetails = tagService.getFolderTagDetails("团队/会议纪要");
  assert.equal(
    folderDetails.recommendedTags?.some((item) => item.path === meeting.path),
    true,
  );
});

test("标签智能规则会按 CodingNS 规则参与推荐", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "x-file-tags-smart-rule-"),
  );
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });

  const bindingStore = new LibraryBindingStore({ dataDir });
  new LibraryService(bindingStore).saveBinding({
    rootDir,
    completeInitialization: true,
  });
  const tagService = new TagService(bindingStore, new TagStore({ dataDir }));

  const contract = tagService.createTag({
    name: "法务资料",
    smartRules: [
      {
        relation: "and",
        ruleType: "file_name_contains",
        matcher: { keyword: "合同" },
        enabled: true,
        priority: 0,
      },
    ],
  });
  const quote = tagService.createTag({
    name: "报价单",
    smartRules: [
      {
        relation: "and",
        ruleType: "file_extension_in",
        matcher: { extensions: ["xlsx"] },
        enabled: true,
        priority: 0,
      },
      {
        relation: "not",
        ruleType: "file_name_contains",
        matcher: { keyword: "草稿" },
        enabled: true,
        priority: 1,
      },
    ],
  });

  assert.equal(contract.smartRuleEnabled, true);
  assert.equal(tagService.listTags().summary.totalRuleEnabledTags, 2);

  const contractDetails = tagService.getDocumentTagDetails("商务/采购合同.md");
  const contractRecommendation = contractDetails.recommendedTags?.find(
    (item) => item.path === contract.path,
  );
  assert.equal(contractRecommendation?.reason, "smart_rule");
  assert.match(contractRecommendation?.evidence ?? "", /智能规则：文件名包含/);

  const quoteDetails = tagService.getDocumentTagDetails("商务/报价单.xlsx");
  assert.equal(
    quoteDetails.recommendedTags?.some((item) => item.path === quote.path),
    true,
  );

  const draftDetails = tagService.getDocumentTagDetails("商务/草稿报价单.xlsx");
  assert.equal(
    draftDetails.recommendedTags?.some(
      (item) => item.path === quote.path && item.reason === "smart_rule",
    ),
    false,
  );

  const updated = tagService.updateTag(contract.id, {
    name: "合同",
    parentId: null,
    smartRules: [],
  });
  assert.equal(updated.smartRuleEnabled, false);
  assert.equal(tagService.listTags().summary.totalRuleEnabledTags, 1);
});

test("保存智能规则后会复用 indexer 重算并把 smart_rule 写进导出结果", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "x-file-tags-recompute-"),
  );
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(path.join(rootDir, "商务"), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "商务", "采购合同.md"),
    "供应商付款条款",
    "utf8",
  );

  await runLibraryIndexOnce({ rootDir, allowedExtensions: [".md"] });

  const bindingStore = new LibraryBindingStore({ dataDir });
  new LibraryService(bindingStore).saveBinding({
    rootDir,
    completeInitialization: true,
  });
  const taskManager = new TaskManager();
  const tagService = new TagService(
    bindingStore,
    new TagStore({ dataDir }),
    taskManager,
  );
  tagService.registerTasks();

  const tag = tagService.createTag({
    name: "法务资料",
    smartRules: [
      {
        relation: "and",
        ruleType: "file_content_contains",
        matcher: { keyword: "付款条款" },
        enabled: true,
        priority: 0,
      },
    ],
  });

  await waitForTagRecompute(tagService);

  const list = new LibraryService(bindingStore).listDocuments({
    browseMode: "tag",
    selectedTagPath: tag.path,
  });
  assert.equal(list.total, 1);
  assert.equal(
    list.items[0]?.derivedTags.includes(tag.path) ||
      list.items[0]?.tags.includes(tag.path),
    true,
  );

  const details = tagService.getDocumentTagDetails(list.items[0]!.documentId);
  const smartResolved = details.resolvedTags.find(
    (item) => item.path === tag.path,
  );
  assert.equal(smartResolved?.sourceType, "smart_rule");
  assert.match(smartResolved?.evidence ?? "", /付款条款/);
});

async function waitForTagRecompute(tagService: TagService): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    const task = tagService.getRecomputeTask();
    if (task?.state === "fresh") {
      return;
    }
    if (task?.state === "failed" || task?.state === "queue_timeout") {
      throw new Error(task.errorSummary ?? "标签重算失败");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("等待标签重算超时");
}
