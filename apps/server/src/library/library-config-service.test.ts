import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LibraryConfigService } from "./library-config-service.js";
import { LibraryService } from "./library-service.js";
import { LibraryBindingStore } from "../storage/library-binding-store.js";
import { LibraryConfigStore } from "../storage/library-config-store.js";

test("配置保存同步更新 binding 和资料库内配置文件", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-config-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });

  const bindingStore = new LibraryBindingStore({ dataDir });
  const libraryService = new LibraryService(bindingStore);
  const configService = new LibraryConfigService(bindingStore, new LibraryConfigStore());
  libraryService.saveBinding({ rootDir, completeInitialization: true });

  const config = configService.saveConfig({
    enabled: false,
    mirrorRoot: " /tmp/mirror ",
    allowedExtensions: ["md", ".PDF", ".md"],
    includedHiddenPaths: [".obsidian", ".obsidian", " .secret/docs "],
    hideDotFiles: false,
    hideSystemFolders: false,
    folderOpenBehavior: "single_click"
  });

  assert.equal(config.enabled, false);
  assert.equal(config.mirrorRoot, "/tmp/mirror");
  assert.deepEqual(config.allowedExtensions, [".md", ".pdf"]);
  assert.deepEqual(config.includedHiddenPaths, [".obsidian", ".secret/docs"]);
  assert.equal(config.hideDotFiles, false);
  assert.equal(config.hideSystemFolders, false);
  assert.equal(config.folderOpenBehavior, "single_click");

  const binding = bindingStore.read();
  assert.equal(binding?.enabled, false);
  assert.equal(binding?.mirrorRoot, "/tmp/mirror");
  assert.deepEqual(binding?.allowedExtensions, [".md", ".pdf"]);

  const configFile = JSON.parse(
    fs.readFileSync(path.join(rootDir, ".ai-index", "doc-semantic-index.config.json"), "utf8")
  ) as {
    enabled: boolean;
    allowedExtensions: string[];
    hideDotFiles: boolean;
    hideSystemFolders: boolean;
    folderOpenBehavior: string;
  };
  assert.equal(configFile.enabled, false);
  assert.deepEqual(configFile.allowedExtensions, [".md", ".pdf"]);
  assert.equal(configFile.hideDotFiles, false);
  assert.equal(configFile.hideSystemFolders, false);
  assert.equal(configFile.folderOpenBehavior, "single_click");
});

test("索引范围配置变化会排队一次配置变更刷新", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-config-refresh-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });

  const bindingStore = new LibraryBindingStore({ dataDir });
  new LibraryService(bindingStore).saveBinding({ rootDir, completeInitialization: true });
  let refreshCount = 0;
  const configService = new LibraryConfigService(
    bindingStore,
    new LibraryConfigStore(),
    () => {
      refreshCount += 1;
      return {
        taskId: "task-config-refresh",
        status: {
          state: "queued",
          dirtyReasons: ["library_config_changed"],
          lastRequestedAt: null,
          lastStartedAt: null,
          lastCompletedAt: null,
          lastFailedAt: null,
          nextAllowedAt: null,
          runningTaskId: "task-config-refresh",
          runningStage: null,
          errorSummary: null,
        },
      };
    },
  );

  const config = configService.saveConfig({
    allowedExtensions: [".md", ".png"],
  });

  assert.equal(refreshCount, 1);
  assert.equal(config.applyConfigTaskId, "task-config-refresh");
  assert.equal(config.applyConfigStatus?.state, "queued");
});
