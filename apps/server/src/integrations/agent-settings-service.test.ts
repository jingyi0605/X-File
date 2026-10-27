import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

import { resolveNativeCli } from "@x-file/indexer";
import { createServer } from "../app.js";
import { HttpServerManager } from "../http-server-manager.js";
import { AgentSettingsError, createAgentSettingsService } from "./agent-settings-service.js";

test("真实 HTTP 注入调用 Rust 管理配置，CLI 同时遵守开关、换钥与撤销", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-web-agent-"));
  const oldEnv = Object.fromEntries(["X_FILE_DATA_DIR"].map((key) => [key, process.env[key]]));
  process.env.X_FILE_DATA_DIR = dataDir;
  const manager = new HttpServerManager(path.join(dataDir, "http-state.json"));
  manager.save({ host: "0.0.0.0", authEnabled: true, authUsername: "lan-user", authPassword: "correct-password" });
  const app = createServer({ httpServerManager: manager });
  t.after(async () => {
    await app.close();
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const url = "/api/integration/agent/settings";
  let remote = false;
  let sessionCookie = "";
  const request = async (input?: object, expected = 200) => {
    const result = await app.inject({
      ...(input ? { method: "PUT" as const, url, payload: input } : { url }),
      ...(remote ? {
        remoteAddress: "192.0.2.5",
        headers: { host: "primary.example.com", cookie: sessionCookie },
      } : {}),
    });
    assert.equal(result.statusCode, expected, result.body);
    assert.equal(result.headers["cache-control"], "no-store");
    return result.json();
  };
  const cli = (key: string) => {
    const result = spawnSync(resolveNativeCli(), ["cli", "call", "xfile_status"], {
      encoding: "utf8", timeout: 15_000,
      env: { ...process.env, X_FILE_AGENT_API_KEY: key },
    });
    assert.ifError(result.error);
    return JSON.parse(result.stdout);
  };
  const initial = await request();
  assert.equal(initial.enabled, false);
  assert.equal(initial.apiKeyConfigured, false);
  assert.equal(initial.dataDir, path.resolve(dataDir));
  await request({ enabled: true }, 400);
  const generated = await request({ generateApiKey: true });
  assert.equal(generated.apiKey.length, 67);
  assert.equal(generated.settings.enabled, false);
  assert.ok(!fs.readFileSync(path.join(dataDir, "agent-integration.json"), "utf8").includes(generated.apiKey));
  assert.equal(cli(generated.apiKey).error.code, "AGENT_DISABLED");
  await request({ enabled: true });
  assert.equal(cli(generated.apiKey).ok, true);
  const read = await request();
  assert.equal(read.apiKey, undefined);
  assert.ok(!JSON.stringify(read).includes(generated.apiKey));
  const rotated = await request({ generateApiKey: true });
  assert.equal(cli(generated.apiKey).error.code, "UNAUTHORIZED");
  assert.equal(cli(rotated.apiKey).ok, true);
  await request({ apiKey: "short" }, 400);
  assert.equal(cli(rotated.apiKey).ok, true);
  const customKey = "custom-api-key-with-at-least-thirty-two-characters";
  const custom = await request({ apiKey: customKey });
  assert.equal(custom.apiKey, undefined);
  assert.equal(cli(rotated.apiKey).error.code, "UNAUTHORIZED");
  assert.equal(cli(customKey).ok, true);
  await request({ generateApiKey: true, clearApiKey: true }, 400);
  assert.equal(cli(customKey).ok, true);
  const revoked = await request({ clearApiKey: true });
  assert.equal(revoked.settings.enabled, false);
  assert.equal(revoked.settings.apiKeyConfigured, false);
  assert.equal(cli(customKey).error.code, "AGENT_DISABLED");
  const login = await app.inject({
    method: "POST", url: "/api/auth/login", remoteAddress: "192.0.2.5",
    payload: { username: "lan-user", password: "correct-password" },
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"];
  assert.ok(cookie);
  sessionCookie = Array.isArray(cookie) ? cookie[0]! : cookie;
  remote = true;
  const remoteSettings = await request();
  assert.equal(remoteSettings.dataDir, path.resolve(dataDir));
  assert.equal(remoteSettings.enabled, false);
  const remoteKey = await request({ generateApiKey: true, enabled: true });
  assert.equal(cli(remoteKey.apiKey).ok, true);
  await request({ clearApiKey: true });
  assert.equal(cli(remoteKey.apiKey).error.code, "AGENT_DISABLED");
});

test("原生入口缺失时明确返回不可用，不创建另一份设置也不回显进程错误", async (t) => {
  const oldExecutable = process.env.X_FILE_DESKTOP_CLI_PATH;
  const missing = path.join(os.tmpdir(), randomUUID(), "private-cli-path");
  process.env.X_FILE_DESKTOP_CLI_PATH = missing;
  t.after(() => {
    if (oldExecutable === undefined) delete process.env.X_FILE_DESKTOP_CLI_PATH;
    else process.env.X_FILE_DESKTOP_CLI_PATH = oldExecutable;
  });
  await assert.rejects(createAgentSettingsService().get(), (error) => {
    assert.ok(error instanceof AgentSettingsError);
    assert.equal(error.statusCode, 503);
    assert.ok(!error.message.includes(missing));
    return true;
  });
});
