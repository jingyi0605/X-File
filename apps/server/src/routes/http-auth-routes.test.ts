import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import Fastify from "fastify";

import { HttpServerManager } from "../http-server-manager.js";
import { registerHttpAuthRoutes } from "./http-auth-routes.js";

test("局域网请求必须先登录，登录后会话可以访问受保护内容", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-http-auth-"));
  const manager = new HttpServerManager(path.join(tempDir, "state.json"));
  manager.save({
    host: "0.0.0.0",
    authEnabled: true,
    authUsername: "lan-user",
    authPassword: "correct-password"
  });

  const app = Fastify({ logger: false });
  registerHttpAuthRoutes(app, manager);
  app.get("/api/content", async () => ({ content: "private" }));

  const state = manager.getState();
  assert.equal(state.authConfigured, true);
  assert.equal(state.authUsername, "lan-user");
  assert.equal("auth" in state, false);
  assert.equal(fs.readFileSync(path.join(tempDir, "state.json"), "utf8").includes("correct-password"), false);

  const unauthenticated = await app.inject({
    method: "GET",
    url: "/api/content",
    remoteAddress: "192.168.1.20"
  });
  assert.equal(unauthenticated.statusCode, 401);

  const invalidLogin = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: "192.168.1.20",
    payload: {
      username: "lan-user",
      password: "wrong-password"
    }
  });
  assert.equal(invalidLogin.statusCode, 401);

  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    remoteAddress: "192.168.1.20",
    payload: {
      username: "lan-user",
      password: "correct-password"
    }
  });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers["set-cookie"];
  assert.ok(cookie);
  assert.match(Array.isArray(cookie) ? cookie[0] : cookie, /Max-Age=31536000/);
  assert.match(Array.isArray(cookie) ? cookie[0] : cookie, /HttpOnly/);

  const authenticated = await app.inject({
    method: "GET",
    url: "/api/content",
    remoteAddress: "192.168.1.20",
    headers: {
      cookie: Array.isArray(cookie) ? cookie[0] : cookie
    }
  });
  assert.equal(authenticated.statusCode, 200);
  assert.deepEqual(authenticated.json(), { content: "private" });

  await app.close();
});

test("本机回环请求不要求局域网登录", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-http-auth-local-"));
  const manager = new HttpServerManager(path.join(tempDir, "state.json"));
  const app = Fastify({ logger: false });
  registerHttpAuthRoutes(app, manager);
  app.get("/api/content", async () => ({ content: "local" }));

  const response = await app.inject({
    method: "GET",
    url: "/api/content",
    remoteAddress: "127.0.0.1"
  });
  assert.equal(response.statusCode, 200);

  await app.close();
});
