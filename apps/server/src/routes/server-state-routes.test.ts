import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify from "fastify";

import { HttpServerManager } from "../http-server-manager.js";
import { PersistentBackendManager } from "../lifecycle/persistent-backend-manager.js";
import { registerServerStateRoutes } from "./server-state-routes.js";

test("server state 默认和保存后都只监听 127.0.0.1", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-server-state-"));
  const app = Fastify({ logger: false });
  await registerServerStateRoutes(
    app,
    new HttpServerManager(path.join(tempDir, "state.json")),
    new PersistentBackendManager()
  );

  const initial = await app.inject({ method: "GET", url: "/api/server/state" });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.json().host, "127.0.0.1");

  const saved = await app.inject({
    method: "PUT",
    url: "/api/server/state",
    payload: {
      enabled: true,
      port: 33221,
      persistent: true
    }
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().host, "127.0.0.1");
  assert.equal(saved.json().port, 33221);
  assert.equal(saved.json().persistent, true);
  assert.equal(saved.json().persistentPolicy.implementedByDesktopShell, true);
  assert.equal(saved.json().persistentPolicy.keepBackendOnWindowClose, true);

  const rejected = await app.inject({
    method: "PUT",
    url: "/api/server/state",
    payload: {
      host: "0.0.0.0"
    }
  });
  assert.equal(rejected.statusCode, 400);

  await app.close();
});

test("server state 生命周期模式可以真实启停本机 HTTP 服务", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-server-lifecycle-"));
  const manager = new HttpServerManager(path.join(tempDir, "state.json"), {
    running: false
  });
  manager.bindServerFactory(() => {
    const app = Fastify({ logger: false });
    app.get("/api/health", async () => ({ ok: true }));
    void registerServerStateRoutes(app, manager, new PersistentBackendManager(), {
      manageLifecycle: true
    });
    return app;
  });

  const port = await findFreePort();
  const started = await manager.applyStateChange({
    enabled: true,
    port
  }, {
    manageLifecycle: true
  });
  assert.equal(started.running, true);
  assert.equal(started.lifecycleState, "running");
  assert.equal(await canConnect(port), true);

  const stopped = await manager.applyStateChange({
    enabled: false
  }, {
    manageLifecycle: true
  });
  assert.equal(stopped.running, false);
  assert.equal(stopped.lifecycleState, "disabled");
  assert.equal(await canConnect(port), false);
});

async function findFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("没有拿到测试端口");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return port;
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}
