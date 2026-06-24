import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify from "fastify";

import { registerWebShellRoutes } from "./web-shell-routes.js";

test("web shell 生产态托管 dist 并对前端路由回退到 index.html", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-web-shell-dist-"));
  const distDir = path.join(tempDir, "dist");
  fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><html><body><div id=\"root\">x-file</div></body></html>");
  fs.writeFileSync(path.join(distDir, "assets", "app.js"), "console.log('x-file')");

  const previousDistDir = process.env.X_FILE_WEB_DIST_DIR;
  process.env.X_FILE_WEB_DIST_DIR = distDir;

  const app = Fastify({ logger: false });
  registerWebShellRoutes(app);

  try {
    const index = await app.inject({ method: "GET", url: "/" });
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /<div id="root">x-file<\/div>/);

    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.body, /console\.log\('x-file'\)/);

    const appRoute = await app.inject({ method: "GET", url: "/settings/network" });
    assert.equal(appRoute.statusCode, 200);
    assert.match(appRoute.body, /<div id="root">x-file<\/div>/);
  } finally {
    await app.close();
    if (previousDistDir === undefined) {
      delete process.env.X_FILE_WEB_DIST_DIR;
    } else {
      process.env.X_FILE_WEB_DIST_DIR = previousDistDir;
    }
  }
});

test("web shell 开发态把非 /api/* 请求转发到 Vite", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/assets/main.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end("console.log('vite-dev')");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body>vite-dev-shell</body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("没有拿到开发态测试端口");
  }

  const previousDevUrl = process.env.X_FILE_WEB_DEV_URL;
  const previousDistDir = process.env.X_FILE_WEB_DIST_DIR;
  process.env.X_FILE_WEB_DEV_URL = `http://127.0.0.1:${address.port}`;
  process.env.X_FILE_WEB_DIST_DIR = path.join(os.tmpdir(), "x-file-web-shell-missing-dist");

  const app = Fastify({ logger: false });
  registerWebShellRoutes(app, { forceDevProxy: true });

  try {
    const index = await app.inject({ method: "GET", url: "/" });
    assert.equal(index.statusCode, 200);
    assert.match(index.body, /vite-dev-shell/);

    const asset = await app.inject({ method: "GET", url: "/assets/main.js" });
    assert.equal(asset.statusCode, 200);
    assert.match(asset.body, /vite-dev/);
  } finally {
    await app.close();
    server.close();
    if (previousDevUrl === undefined) {
      delete process.env.X_FILE_WEB_DEV_URL;
    } else {
      process.env.X_FILE_WEB_DEV_URL = previousDevUrl;
    }
    if (previousDistDir === undefined) {
      delete process.env.X_FILE_WEB_DIST_DIR;
    } else {
      process.env.X_FILE_WEB_DIST_DIR = previousDistDir;
    }
  }
});

test("web shell 不抢 /api/* 和 /preview/* 路由", async () => {
  const app = Fastify({ logger: false });
  registerWebShellRoutes(app, { forceDevProxy: true });

  try {
    const apiMiss = await app.inject({ method: "GET", url: "/api/health" });
    assert.equal(apiMiss.statusCode, 404);

    const previewMiss = await app.inject({ method: "GET", url: "/preview/library-files/token/demo.txt" });
    assert.equal(previewMiss.statusCode, 404);
  } finally {
    await app.close();
  }
});
