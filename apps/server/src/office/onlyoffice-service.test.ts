import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LibraryIndexService } from "../library/index-service.js";
import { LibraryService } from "../library/library-service.js";
import { LibraryPreviewLinkService } from "../library/preview-link-service.js";
import { LibraryBindingStore } from "../storage/library-binding-store.js";
import { LibraryExportReader } from "../storage/library-export-reader.js";
import { IndexRuntimeStore } from "../storage/index-runtime-store.js";
import { OnlyOfficeSettingsStore } from "../storage/onlyoffice-settings-store.js";
import { TaskManager } from "../tasks/task-manager.js";
import { OnlyOfficeService } from "./onlyoffice-service.js";

test("ONLYOFFICE 预览覆盖 doc/xls/ppt 和 openxml 格式", () => {
  const { service, rootDir } = createOnlyOfficeFixture();
  for (const fileName of ["a.doc", "b.docx", "c.xls", "d.xlsx", "e.ppt", "f.pptx"]) {
    fs.writeFileSync(path.join(rootDir, fileName), "office", "utf8");
    const preview = service.buildLibraryPreview({
      filePath: fileName,
      version: "v1"
    });
    const editorConfig = preview.editorConfig as {
      documentType: string;
      document: { fileType: string };
    };

    assert.equal(editorConfig.document.fileType, path.extname(fileName).slice(1));
    assert.equal(preview.documentUrl.includes(`/preview/library-files/`), true);
    if (fileName.endsWith(".xls") || fileName.endsWith(".xlsx")) {
      assert.equal(editorConfig.documentType, "cell");
    } else if (fileName.endsWith(".ppt") || fileName.endsWith(".pptx")) {
      assert.equal(editorConfig.documentType, "slide");
    } else {
      assert.equal(editorConfig.documentType, "word");
    }
  }
});

test("ONLYOFFICE 回调保存成功后提交后台刷新", async () => {
  const { service, libraryService, rootDir } = createOnlyOfficeFixture();
  fs.writeFileSync(path.join(rootDir, "a.docx"), "old", "utf8");
  const preview = service.buildLibraryPreview({
    filePath: "a.docx",
    version: "v1"
  });
  const callbackToken = decodeURIComponent(preview.callbackUrl.split("/").pop() ?? "");
  const downloadServer = await startTextServer("new office content");

  try {
    const result = await service.handleCallback(callbackToken, {
      status: 2,
      url: downloadServer.url
    });
    assert.equal(result.error, 0);
    assert.equal(fs.readFileSync(path.join(rootDir, "a.docx"), "utf8"), "new office content");
    const status = libraryService.getSnapshot().status;
    assert.match(status.state, /^(queued|running)$/);
    assert.deepEqual(status.dirtyReasons, ["onlyoffice_callback"]);
  } finally {
    await downloadServer.close();
  }
});

function createOnlyOfficeFixture(): {
  service: OnlyOfficeService;
  libraryService: LibraryService;
  rootDir: string;
} {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-onlyoffice-"));
  const dataDir = path.join(tempDir, "data");
  const rootDir = path.join(tempDir, "library");
  fs.mkdirSync(rootDir, { recursive: true });

  const libraryService = new LibraryService(
    new LibraryBindingStore({ dataDir }),
    new LibraryExportReader(),
    new LibraryIndexService(new TaskManager(), new IndexRuntimeStore())
  );
  libraryService.saveBinding({ rootDir, completeInitialization: true });

  const settingsStore = new OnlyOfficeSettingsStore({ dataDir });
  settingsStore.write({
    enabled: true,
    serverUrl: "http://onlyoffice.local",
    publicBaseUrl: "http://127.0.0.1:17321",
    callbackBaseUrl: "http://127.0.0.1:17321",
    userDisplayName: null,
    userAvatarUrl: null,
    jwtSecret: null,
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z"
  });

  const service = new OnlyOfficeService(
    settingsStore,
    new LibraryPreviewLinkService(libraryService, "test-secret"),
    libraryService,
    "test-secret"
  );

  return {
    service,
    libraryService,
    rootDir
  };
}

async function startTextServer(content: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(content);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("测试下载服务没有拿到监听端口");
  }
  const listenAddress = address as AddressInfo;
  return {
    url: `http://127.0.0.1:${listenAddress.port}/download`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    })
  };
}
