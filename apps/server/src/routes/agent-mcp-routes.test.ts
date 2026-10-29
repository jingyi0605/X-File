import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { createHmac } from "node:crypto";

import { registerAgentMcpRoutes } from "./agent-mcp-routes.js";

const key = "x-file-mcp-test-credential-with-thirty-two-characters";

function fixture(t: test.TestContext) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-agent-mcp-http-"));
  const oldDataDir = process.env.X_FILE_DATA_DIR;
  const oldKey = process.env.X_FILE_AGENT_API_KEY;
  const oldCliPath = process.env.X_FILE_DESKTOP_CLI_PATH;
  process.env.X_FILE_DATA_DIR = dataDir;
  process.env.X_FILE_AGENT_API_KEY = key;
  process.env.X_FILE_DESKTOP_CLI_PATH = path.resolve(
    "../desktop/src-tauri/target/debug/x-file-desktop",
  );
  fs.writeFileSync(path.join(dataDir, "agent-integration.json"), JSON.stringify({
    enabled: true,
    apiKeyDigest: [...createHmac("sha256", "X-File agent credential v1").update(key).digest()],
    accessMode: "read_only",
    updatedAt: new Date().toISOString(),
  }));
  const app = Fastify({ logger: false });
  registerAgentMcpRoutes(app);
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    restore("X_FILE_DATA_DIR", oldDataDir);
    restore("X_FILE_AGENT_API_KEY", oldKey);
    restore("X_FILE_DESKTOP_CLI_PATH", oldCliPath);
  });
  return app;
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function headers(token = key) {
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
}

function callNative(dataDir: string, tool: string, args: Record<string, unknown> = {}) {
  const executable = process.env.X_FILE_DESKTOP_CLI_PATH!;
  const result = spawnSync(executable, ["cli", "--data-dir", dataDir, "call", tool, "--stdin"], {
    input: JSON.stringify(args), encoding: "utf8", env: { ...process.env, X_FILE_AGENT_API_KEY: key },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).result;
}

test("远程 MCP 支持 stateless 初始化、发现、调用和资源", async (t) => {
  const app = fixture(t);
  const initialized = await app.inject({
    method: "POST", url: "/api/mcp", headers: headers(),
    payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
  });
  assert.equal(initialized.statusCode, 200);
  assert.equal(initialized.json().result.protocolVersion, "2025-11-25");
  assert.equal(initialized.headers["mcp-protocol-version"], "2025-11-25");
  assert.equal(initialized.headers["mcp-session-id"], undefined);

  const tools = await app.inject({
    method: "POST", url: "/api/mcp", headers: { ...headers(), "mcp-protocol-version": "2025-11-25" },
    payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  });
  assert.equal(tools.statusCode, 200);
  assert.ok(tools.json().result.tools.some((tool: { name: string }) => tool.name === "xfile_status"));
  const unsupportedCursor = await app.inject({
    method: "POST", url: "/api/mcp", headers: { ...headers(), "mcp-protocol-version": "2025-11-25" },
    payload: { jsonrpc: "2.0", id: 8, method: "tools/list", params: { cursor: "next" } },
  });
  assert.equal(unsupportedCursor.json().error.code, -32602);

  const status = await app.inject({
    method: "POST", url: "/api/mcp", headers: { ...headers(), "mcp-protocol-version": "2025-11-25" },
    payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "xfile_status", arguments: {} } },
  });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().result.structuredContent.result.accessMode, "read_only");
  assert.equal("dataDir" in status.json().result.structuredContent.result, false);

  const resource = await app.inject({
    method: "POST", url: "/api/mcp", headers: { ...headers(), "mcp-protocol-version": "2025-11-25" },
    payload: { jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "xfile://skills/x-file" } },
  });
  assert.equal(resource.statusCode, 200);
  assert.match(resource.json().result.contents[0].text, /X-File/);

  const listForReadOnly = await app.inject({
    method: "POST", url: "/api/mcp", headers: { ...headers(), "mcp-protocol-version": "2025-11-25" },
    payload: { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} },
  });
  assert.ok(!listForReadOnly.json().result.tools.some((tool: { name: string }) => tool.name === "xfile_binding_set"));

  const writeDenied = await app.inject({
    method: "POST", url: "/api/mcp", headers: { ...headers(), "mcp-protocol-version": "2025-11-25" },
    payload: {
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "xfile_documents_tags_batch", arguments: {
        documentIds: ["doc-1"], operation: "add", tagPaths: ["Agent/远程"], dryRun: false,
        idempotencyKey: "http-read-only-denied-001",
      } },
    },
  });
  assert.equal(writeDenied.statusCode, 200);
  assert.equal(writeDenied.json().result.structuredContent.error.code, "READ_ONLY");

  const denied = await app.inject({
    method: "POST", url: "/api/mcp", headers: { ...headers(), "mcp-protocol-version": "2025-11-25" },
    payload: { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "xfile_binding_set", arguments: { rootDir: "/tmp" } } },
  });
  assert.equal(denied.json().result.structuredContent.error.code, "REMOTE_TOOL_DENIED");
});

test("遠程 MCP 鑑權、Origin、會話頭、Accept、協議版本和請求體邊界", async (t) => {
  const app = fixture(t);
  const request = { jsonrpc: "2.0", id: 1, method: "ping", params: {} };
  const noAuth = await app.inject({ method: "POST", url: "/api/mcp", headers: headers(""), payload: request });
  assert.equal(noAuth.statusCode, 401);
  assert.ok(!noAuth.body.includes(key));

  const origin = await app.inject({ method: "POST", url: "/api/mcp", headers: { ...headers(), origin: "https://agent.example" }, payload: request });
  assert.equal(origin.statusCode, 403);

  const session = await app.inject({ method: "POST", url: "/api/mcp", headers: { ...headers(), "mcp-session-id": "legacy-session" }, payload: request });
  assert.equal(session.statusCode, 400);

  const accept = await app.inject({ method: "POST", url: "/api/mcp", headers: { ...headers(), accept: "application/json" }, payload: request });
  assert.equal(accept.statusCode, 406);

  const version = await app.inject({ method: "POST", url: "/api/mcp", headers: headers(), payload: request });
  assert.equal(version.statusCode, 400);
  const invalidNotification = await app.inject({
    method: "POST", url: "/api/mcp", headers: { ...headers(), "mcp-protocol-version": "2025-11-25" },
    payload: { jsonrpc: "2.0", method: "tools/call", params: { name: "xfile_file_operation", arguments: { opType: "delete", srcPath: "important.md" } } },
  });
  assert.equal(invalidNotification.statusCode, 400);
  assert.equal(invalidNotification.json().error.code, "MCP_NOTIFICATION_INVALID");
  const initializedNotification = await app.inject({
    method: "POST", url: "/api/mcp", headers: { ...headers(), "mcp-protocol-version": "2025-11-25" },
    payload: { jsonrpc: "2.0", method: "notifications/initialized" },
  });
  assert.equal(initializedNotification.statusCode, 202);
  assert.equal(initializedNotification.body, "");

  const oversized = await app.inject({
    method: "POST", url: "/api/mcp", headers: headers(),
    payload: { jsonrpc: "2.0", id: 2, method: "ping", padding: "x".repeat(2 * 1024 * 1024 + 1) },
  });
  assert.equal(oversized.statusCode, 413);
  assert.equal(oversized.json().error.code, "MCP_REQUEST_TOO_LARGE");

  const get = await app.inject({ method: "GET", url: "/api/mcp" });
  assert.equal(get.statusCode, 405, get.body);
  const remove = await app.inject({ method: "DELETE", url: "/api/mcp" });
  assert.equal(remove.statusCode, 405, remove.body);
});

test("API Key 轮换后已有远程连接的下一次请求立即失效", async (t) => {
  const app = fixture(t);
  const request = {
    method: "POST",
    url: "/api/mcp",
    headers: { ...headers(), "mcp-protocol-version": "2025-11-25" },
    payload: { jsonrpc: "2.0", id: 1, method: "ping", params: {} },
  } as const;
  assert.equal((await app.inject(request)).statusCode, 200);
  const nextKey = "x-file-mcp-next-key-also-has-more-than-thirty-two-characters";
  const digest = createHmac("sha256", "X-File agent credential v1").update(nextKey).digest();
  fs.writeFileSync(path.join(process.env.X_FILE_DATA_DIR!, "agent-integration.json"), JSON.stringify({
    enabled: true,
    apiKeyDigest: [...digest],
    accessMode: "read_only",
  }));
  const revoked = await app.inject(request);
  assert.equal(revoked.statusCode, 401);
  assert.ok(!revoked.body.includes(nextKey));
});

test("远程 MCP 用组合查询冻结结果、批量加标签并读取幂等任务", async (t) => {
  const app = fixture(t);
  const dataDir = process.env.X_FILE_DATA_DIR!;
  const library = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-agent-mcp-library-"));
  t.after(() => fs.rmSync(library, { recursive: true, force: true }));
  const settingsPath = path.join(dataDir, "agent-integration.json");
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  settings.accessMode = "read_write";
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  callNative(dataDir, "xfile_binding_set", { rootDir: library });
  callNative(dataDir, "xfile_file_operation", { opType: "create_file", dstPath: "contract.md", content: "Confidential contract" });

  const request = async (id: number, method: string, params: Record<string, unknown> = {}) => app.inject({
    method: "POST", url: "/api/mcp",
    headers: { ...headers(), "mcp-protocol-version": "2025-11-25" },
    payload: { jsonrpc: "2.0", id, method, params },
  });
  const search = await request(1, "tools/call", {
    name: "xfile_documents_list",
    arguments: { browseMode: "tag", keyword: "Confidential", searchScope: "all", searchMode: "content", limit: 20 },
  });
  const documents = search.json().result.structuredContent.result;
  assert.equal(documents.total, 1);
  const documentIds = documents.items.map((item: { documentId: string }) => item.documentId);

  const preview = await request(2, "tools/call", {
    name: "xfile_documents_tags_batch",
    arguments: { documentIds, operation: "add", tagPaths: ["AI/Reviewed"], createTagPaths: ["AI/Reviewed"], dryRun: true },
  });
  const dryRun = preview.json().result.structuredContent.result;
  assert.equal(dryRun.matchedCount, 1);
  assert.deepEqual(dryRun.targetDocumentIds, documentIds);

  const applied = await request(3, "tools/call", {
    name: "xfile_documents_tags_batch",
    arguments: {
      documentIds: dryRun.targetDocumentIds, operation: "add", tagPaths: ["AI/Reviewed"],
      createTagPaths: ["AI/Reviewed"], dryRun: false, idempotencyKey: "remote-batch-contract-001",
    },
  });
  const result = applied.json().result.structuredContent.result;
  assert.equal(result.state, "completed");
  assert.equal(result.changedCount, 1);

  const task = await request(4, "tools/call", { name: "xfile_task_get", arguments: { taskId: result.taskId } });
  assert.equal(task.json().result.structuredContent.result.state, "completed");
  const tags = callNative(dataDir, "xfile_document_tags_get", { documentId: documentIds[0] });
  assert.ok(tags.manualTagIds.length > 0);
});
