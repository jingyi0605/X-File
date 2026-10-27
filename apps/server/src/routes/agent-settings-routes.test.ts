import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

import { AgentSettingsError, type AgentSettingsService } from "../integrations/agent-settings-service.js";
import { HttpServerManager } from "../http-server-manager.js";
import { registerAgentSettingsRoutes } from "./agent-settings-routes.js";
import { registerHttpAuthRoutes } from "./http-auth-routes.js";
import { createServer } from "../app.js";

const url = "/api/integration/agent/settings";
const settings = {
  enabled: false, apiKeyConfigured: false, updatedAt: null,
  executablePath: "/host/x-file", dataDir: "/host/.x-file", platform: "linux",
};

function fixture(t: test.TestContext, authenticated = false) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-agent-auth-"));
  const manager = new HttpServerManager(path.join(tempDir, "state.json"));
  if (authenticated) {
    manager.save({ host: "0.0.0.0", authEnabled: true, authUsername: "lan-user", authPassword: "correct-password" });
  }
  const calls: unknown[] = [];
  const service: AgentSettingsService = {
    get: async () => { calls.push("get"); return settings; },
    save: async (input) => { calls.push(input); return { settings }; },
  };
  const app = Fastify({ logger: false });
  registerHttpAuthRoutes(app, manager);
  registerAgentSettingsRoutes(app, service);
  t.after(async () => {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return { app, calls };
}

async function login(app: FastifyInstance): Promise<string> {
  const response = await app.inject({
    method: "POST", url: "/api/auth/login", remoteAddress: "192.168.1.20",
    payload: { username: "lan-user", password: "correct-password" },
  });
  assert.equal(response.statusCode, 200);
  const cookie = response.headers["set-cookie"];
  assert.ok(cookie);
  return Array.isArray(cookie) ? cookie[0]! : cookie;
}

test("本机设置无需局域网认证，敏感响应禁用缓存，输入与内部错误不泄露", async (t) => {
  const { app, calls } = fixture(t);
  const initial = await app.inject({ url });
  assert.equal(initial.statusCode, 200);
  assert.deepEqual(initial.json(), settings);
  assert.equal(initial.headers["cache-control"], "no-store");
  const saved = await app.inject({ method: "PUT", url, payload: { generateApiKey: true } });
  assert.equal(saved.statusCode, 200);
  for (const payload of [null, [], { enabled: "true" }, { apiKey: "short" }, { dataDir: "/other" }]) {
    const invalid = await app.inject({ method: "PUT", url, payload: JSON.stringify(payload), headers: { "content-type": "application/json" } });
    assert.equal(invalid.statusCode, 400);
  }
  for (const payload of ["sensitive-invalid-json", JSON.stringify({ apiKey: "s".repeat(9000) })]) {
    const invalid = await app.inject({ method: "PUT", url, payload, headers: { "content-type": "application/json" } });
    assert.ok([400, 413].includes(invalid.statusCode));
    assert.ok(!invalid.body.includes("sensitive-invalid-json"));
    assert.ok(!invalid.body.includes("s".repeat(32)));
    assert.equal(invalid.headers["cache-control"], "no-store");
  }
  assert.deepEqual(calls, ["get", { generateApiKey: true }]);
});

test("LAN 设置管理与其他 API 共用登录 Cookie，会话无效时拒绝 GET 和 PUT", async (t) => {
  const { app, calls } = fixture(t, true);
  for (const method of ["GET", "PUT"] as const) {
    const request = { method, url, remoteAddress: "192.168.1.20", ...(method === "PUT" ? { payload: { generateApiKey: true } } : {}) };
    const denied = await app.inject(request);
    assert.equal(denied.statusCode, 401);
    assert.equal(denied.json().code, "AUTH_REQUIRED");
  }

  const cookie = await login(app);
  for (const method of ["GET", "PUT"] as const) {
    const response = await app.inject({
      method, url, remoteAddress: "192.168.1.20", headers: { cookie },
      ...(method === "PUT" ? { payload: { generateApiKey: true } } : {}),
    });
    assert.equal(response.statusCode, 200);
  }
  assert.deepEqual(calls, ["get", { generateApiKey: true }]);

  await app.inject({ method: "POST", url: "/api/auth/logout", remoteAddress: "192.168.1.20", headers: { cookie } });
  const loggedOut = await app.inject({ url, remoteAddress: "192.168.1.20", headers: { cookie } });
  assert.equal(loggedOut.statusCode, 401);
});

test("复用既有全局 hook 在 full 与 sidecar-only 服务中保护 Agent 设置", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-agent-app-auth-"));
  const manager = new HttpServerManager(path.join(tempDir, "state.json"));
  manager.save({ host: "0.0.0.0", authEnabled: true, authUsername: "lan-user", authPassword: "correct-password" });
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  for (const sidecarProfile of ["full", "sidecar-only"] as const) {
    const app = createServer({ sidecarProfile, httpServerManager: manager });
    try {
      const denied = await app.inject({ url, remoteAddress: "192.168.1.20" });
      assert.equal(denied.statusCode, 401);
      const cookie = await login(app);
      const allowed = await app.inject({ url, remoteAddress: "192.168.1.20", headers: { cookie } });
      assert.equal(allowed.statusCode, 200);
    } finally {
      await app.close();
    }
  }
});

test("设置验证错误映射为 400，未知内部错误不回显内容", async (t) => {
  const invalidService: AgentSettingsService = {
    get: async () => { throw new AgentSettingsError(400, "API_KEY_REQUIRED", "请先配置 API Key"); },
    save: async () => { throw new Error("internal-secret"); },
  };
  const manager = new HttpServerManager();
  const alternate = Fastify({ logger: false });
  registerHttpAuthRoutes(alternate, manager);
  registerAgentSettingsRoutes(alternate, invalidService);
  t.after(() => alternate.close());
  const expected = await alternate.inject({ url });
  assert.equal(expected.statusCode, 400);
  assert.equal(expected.json().errorCode, "API_KEY_REQUIRED");
  const hidden = await alternate.inject({ method: "PUT", url, payload: { generateApiKey: true } });
  assert.equal(hidden.statusCode, 500);
  assert.ok(!hidden.body.includes("internal-secret"));
});
