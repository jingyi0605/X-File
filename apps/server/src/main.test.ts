import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HttpServerManager } from "./http-server-manager.js";
import { configureInitialHttpServerState, resolveStandaloneSidecarProfile } from "./main.js";

test("独立 server 入口默认使用 full sidecar profile", () => {
  const previous = process.env.X_FILE_NODE_SIDECAR_PROFILE;
  delete process.env.X_FILE_NODE_SIDECAR_PROFILE;
  try {
    assert.equal(resolveStandaloneSidecarProfile(), "full");
  } finally {
    if (previous === undefined) {
      delete process.env.X_FILE_NODE_SIDECAR_PROFILE;
    } else {
      process.env.X_FILE_NODE_SIDECAR_PROFILE = previous;
    }
  }
});

test("显式 sidecar-only 配置仍然保留", () => {
  const previous = process.env.X_FILE_NODE_SIDECAR_PROFILE;
  process.env.X_FILE_NODE_SIDECAR_PROFILE = "sidecar-only";
  try {
    assert.equal(resolveStandaloneSidecarProfile(), "sidecar-only");
  } finally {
    if (previous === undefined) {
      delete process.env.X_FILE_NODE_SIDECAR_PROFILE;
    } else {
      process.env.X_FILE_NODE_SIDECAR_PROFILE = previous;
    }
  }
});

test("启动时保留已保存的认证并允许沿用凭据切换 LAN 监听地址", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-server-startup-"));
  const stateFile = path.join(tempDir, "http-server-state.json");

  try {
    const initialManager = new HttpServerManager(stateFile);
    initialManager.save({
      host: "127.0.0.1",
      authEnabled: false,
      authUsername: "lan-user",
      authPassword: "long-enough-password"
    });

    const manager = new HttpServerManager(stateFile);
    const initial = configureInitialHttpServerState(manager, {});
    assert.equal(initial.host, "127.0.0.1");
    assert.equal(initial.authConfigured, true);

    const lan = configureInitialHttpServerState(manager, { X_FILE_SERVER_HOST: "0.0.0.0" });
    assert.equal(lan.host, "0.0.0.0");
    assert.equal(lan.authEnabled, true);
    assert.equal(lan.authConfigured, true);
    assert.equal(manager.verifyCredentials("lan-user", "long-enough-password"), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("旧的无凭据 LAN 配置启动时安全回退到本机监听", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-server-startup-"));
  const stateFile = path.join(tempDir, "http-server-state.json");

  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      enabled: true,
      host: "0.0.0.0",
      port: 17321,
      authEnabled: true,
      auth: null
    }));

    const manager = new HttpServerManager(stateFile);
    const state = configureInitialHttpServerState(manager, {});

    assert.equal(state.host, "127.0.0.1");
    assert.equal(state.authEnabled, false);
    assert.equal(state.authConfigured, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("无认证时显式请求 LAN 监听仍然拒绝启动", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-server-startup-"));
  const manager = new HttpServerManager(path.join(tempDir, "http-server-state.json"));

  try {
    assert.throws(
      () => configureInitialHttpServerState(manager, { X_FILE_SERVER_HOST: "0.0.0.0" }),
      /请先配置并保存局域网访问用户名和密码/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
