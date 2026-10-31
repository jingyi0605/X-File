import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createServer } from "./app.js";

test("移除内置助手后，两种服务模式均不注册助手及专用插件接口", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-without-assistant-"));
  const previousDataDir = process.env.X_FILE_DATA_DIR;
  process.env.X_FILE_DATA_DIR = dataDir;

  try {
    for (const sidecarProfile of ["full", "sidecar-only"] as const) {
      const server = createServer({ sidecarProfile });
      try {
        for (const request of [
          { method: "GET", url: "/api/assistant/providers" },
          { method: "GET", url: "/api/assistant/sessions" },
          { method: "POST", url: "/api/assistant/sessions" },
          { method: "GET", url: "/api/plugins" },
          { method: "POST", url: "/api/plugins/install" },
        ] as const) {
          const response = await server.inject(request);
          assert.equal(response.statusCode, 404, `${sidecarProfile} ${request.method} ${request.url}`);
        }

        for (const url of ["/api/health", "/api/integration/status"]) {
          const response = await server.inject({ method: "GET", url });
          assert.equal(response.statusCode, 200, `${sidecarProfile} ${url}`);
        }
        for (const request of [
          { method: "GET", url: "/api/office/onlyoffice/settings" },
          { method: "PUT", url: "/api/office/onlyoffice/settings" },
          { method: "GET", url: "/api/office/onlyoffice/status" },
          { method: "POST", url: "/api/office/onlyoffice/callback/token" },
        ] as const) {
          const response = await server.inject(request);
          assert.equal(response.statusCode, 404, `${sidecarProfile} ${request.method} ${request.url}`);
        }
      } finally {
        await server.close();
      }
    }
    assert.equal(fs.existsSync(path.join(dataDir, "plugin-registry.json")), false);
  } finally {
    if (previousDataDir === undefined) {
      delete process.env.X_FILE_DATA_DIR;
    } else {
      process.env.X_FILE_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Tauri 生产环境的本地 Origin 可以访问镜像 API", async () => {
  const server = createServer();
  try {
    for (const origin of [
      "tauri://localhost",
      "http://tauri.localhost",
      "https://tauri.localhost",
    ]) {
      const response = await server.inject({
        method: "GET",
        url: "/api/health",
        headers: { origin },
      });
      assert.equal(response.statusCode, 200, origin);
      assert.equal(response.headers["access-control-allow-origin"], origin);
      assert.equal(response.headers["access-control-allow-credentials"], "true");
    }
  } finally {
    await server.close();
  }
});
