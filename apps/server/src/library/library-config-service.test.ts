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
    mirrorRoot: " /tmp/mirror ",
    allowedExtensions: ["md", ".PDF", ".md"],
    includedHiddenPaths: [".obsidian", ".obsidian", " .secret/docs "],
    folderOpenBehavior: "single_click"
  });

  assert.equal(config.mirrorRoot, "/tmp/mirror");
  assert.deepEqual(config.allowedExtensions, [".md", ".pdf"]);
  assert.deepEqual(config.includedHiddenPaths, [".obsidian", ".secret/docs"]);
  assert.equal(config.folderOpenBehavior, "single_click");

  const binding = bindingStore.read();
  assert.equal(binding?.mirrorRoot, "/tmp/mirror");
  assert.deepEqual(binding?.allowedExtensions, [".md", ".pdf"]);

  const configFile = JSON.parse(
    fs.readFileSync(path.join(rootDir, ".ai-index", "doc-semantic-index.config.json"), "utf8")
  ) as { allowedExtensions: string[]; folderOpenBehavior: string };
  assert.deepEqual(configFile.allowedExtensions, [".md", ".pdf"]);
  assert.equal(configFile.folderOpenBehavior, "single_click");
});
