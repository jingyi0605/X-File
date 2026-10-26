import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServer } from "../app.js";

/**
 * 第 11 批基础合约测试：X-File 新路由必须保留旧文档库启用状态语义，配置保存后 DTO、binding 与后续快照一致。
 */
test("第 11 批基础合约：资料库配置路由持久化 enabled 并同步到快照 binding", async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-foundation-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = tempHome;
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-foundation-library-"));
  const app = createServer({
    httpServerRuntimeState: { running: false },
    sidecarProfile: "full",
  });

  try {
    const bindResponse = await app.inject({
      method: "PUT",
      url: "/api/library/binding",
      payload: { rootDir },
    });
    assert.equal(bindResponse.statusCode, 200);
    assert.equal(bindResponse.json().enabled, true);

    const saveConfigResponse = await app.inject({
      method: "PUT",
      url: "/api/library/config",
      payload: {
        enabled: false,
        allowedExtensions: ["md", ".PDF", ".md"],
        includedHiddenPaths: [".obsidian", ".obsidian", "docs/.secret"],
        hideDotFiles: false,
        hideSystemFolders: false,
        folderOpenBehavior: "single_click",
      },
    });
    assert.equal(saveConfigResponse.statusCode, 200);
    const config = saveConfigResponse.json();
    assert.equal(config.enabled, false);
    assert.equal(config.binding.enabled, false);
    assert.deepEqual(config.allowedExtensions, [".md", ".pdf"]);
    assert.deepEqual(config.includedHiddenPaths, [".obsidian", "docs/.secret"]);
    assert.equal(config.hideDotFiles, false);
    assert.equal(config.hideSystemFolders, false);
    assert.equal(config.folderOpenBehavior, "single_click");

    const snapshotResponse = await app.inject({ method: "GET", url: "/api/library/snapshot" });
    assert.equal(snapshotResponse.statusCode, 200);
    assert.equal(snapshotResponse.json().binding.enabled, false);
  } finally {
    await app.close();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
