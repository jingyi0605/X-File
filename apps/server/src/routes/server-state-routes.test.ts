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

test("server state 支持绑定所有网卡并返回可用监听地址", async () => {
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
  assert.equal(initial.json().hostOptions[0].value, "0.0.0.0");
  assert.equal(initial.json().actualHost, null);
  assert.equal(initial.json().actualPort, null);

  const lanWithoutCredentials = await app.inject({
    method: "PUT",
    url: "/api/server/state",
    payload: {
      host: "0.0.0.0",
      authEnabled: true
    }
  });
  assert.equal(lanWithoutCredentials.statusCode, 400);

  const saved = await app.inject({
    method: "PUT",
    url: "/api/server/state",
    payload: {
      enabled: true,
      host: "0.0.0.0",
      authEnabled: true,
      port: 33221,
      persistent: true,
      authUsername: "lan-user",
      authPassword: "long-enough-password"
    }
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().host, "0.0.0.0");
  assert.equal(saved.json().authEnabled, true);
  assert.equal(saved.json().authConfigured, true);
  assert.equal(saved.json().port, 33221);
  assert.equal(saved.json().actualHost, null);
  assert.equal(saved.json().actualPort, null);
  assert.equal(saved.json().persistent, true);
  assert.equal(saved.json().persistentPolicy.implementedByDesktopShell, true);
  assert.equal(saved.json().persistentPolicy.keepBackendOnWindowClose, true);

  const changedHostWithExistingAuth = await app.inject({
    method: "PUT",
    url: "/api/server/state",
    payload: {
      host: "192.168.1.10",
      authEnabled: true
    }
  });
  assert.equal(changedHostWithExistingAuth.statusCode, 200);
  assert.equal(changedHostWithExistingAuth.json().authConfigured, true);
  assert.equal(changedHostWithExistingAuth.json().authUsername, "lan-user");

  const rejected = await app.inject({
    method: "PUT",
    url: "/api/server/state",
    payload: {
      host: "not-an-ip"
    }
  });
  assert.equal(rejected.statusCode, 400);

  const disabledLanAuth = await app.inject({
    method: "PUT",
    url: "/api/server/state",
    payload: {
      host: "192.168.1.10",
      authEnabled: false
    }
  });
  assert.equal(disabledLanAuth.statusCode, 400);

  const enabledLoopbackAuth = await app.inject({
    method: "PUT",
    url: "/api/server/state",
    payload: {
      host: "127.0.0.1",
      authEnabled: true
    }
  });
  assert.equal(enabledLoopbackAuth.statusCode, 400);

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
    host: "0.0.0.0",
    authEnabled: true,
    authUsername: "lan-user",
    authPassword: "long-enough-password",
    port
  }, {
    manageLifecycle: true
  });
  assert.equal(started.running, true);
  assert.equal(started.actualHost, "0.0.0.0");
  assert.equal(started.actualPort, port);
  assert.equal(started.lifecycleState, "running");
  assert.ok(started.accessUrls?.some((url) => url.endsWith(`:${port}/`)));
  assert.equal(await canConnect(port), true);

  const stopped = await manager.applyStateChange({
    enabled: false
  }, {
    manageLifecycle: true
  });
  assert.equal(stopped.running, false);
  assert.equal(stopped.actualHost, null);
  assert.equal(stopped.actualPort, null);
  assert.equal(stopped.lifecycleState, "disabled");
  assert.equal(await canConnect(port), false);
});

test("运行中的 sidecar 在返回保存响应后切换 socket 监听地址", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-server-rebind-"));
  const manager = new HttpServerManager(path.join(tempDir, "state.json"));
  const apps: ReturnType<typeof Fastify>[] = [];
  manager.bindServerFactory(() => {
    const app = Fastify({ logger: false });
    app.get("/api/health", async () => ({ ok: true }));
    void registerServerStateRoutes(app, manager, new PersistentBackendManager(), {
      manageLifecycle: true
    });
    apps.push(app);
    return app;
  });
  const port = await findFreePort();

  try {
    await manager.applyStateChange({
      enabled: true,
      host: "127.0.0.1",
      authEnabled: false,
      authUsername: "lan-user",
      authPassword: "long-enough-password",
      port
    }, { manageLifecycle: true });

    const response = await apps[0].inject({
      method: "PUT",
      url: "/api/server/state",
      payload: { host: "0.0.0.0", authEnabled: true }
    });
    assert.equal(response.statusCode, 200);

    await waitFor(() => manager.getState().actualHost === "0.0.0.0");
    const address = apps.at(-1)?.server.address();
    assert.equal(address && typeof address !== "string" ? address.address : null, "0.0.0.0");
    assert.equal(manager.getState().actualPort, port);
    assert.equal(manager.verifyCredentials("lan-user", "long-enough-password"), true);
  } finally {
    await manager.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("等待 HTTP 服务状态超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
