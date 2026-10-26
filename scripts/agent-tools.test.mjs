import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = process.env.X_FILE_DESKTOP_CLI_PATH || path.join(
  root, "apps/desktop/src-tauri/target/debug", process.platform === "win32" ? "x-file-desktop.exe" : "x-file-desktop",
);
const skill = fs.readFileSync(path.join(root, "skills/x-file/SKILL.md"), "utf8");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-agent-tools-"));
  const library = path.join(directory, "library");
  const data = path.join(directory, "state");
  fs.mkdirSync(library);
  fs.mkdirSync(data);
  const key = "x-file-test-credential-thirty-two-characters";
  saveAccess({ data }, true, key);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, library, data, key };
}

function saveAccess(f, enabled, key) {
  fs.writeFileSync(path.join(f.data, "agent-integration.json"), JSON.stringify({
    enabled, apiKeyDigest: key ? [...createHmac("sha256", "X-File agent credential v1").update(key).digest()] : null,
    updatedAt: new Date().toISOString(),
  }));
}

function environment(f) {
  return { ...process.env, X_FILE_AGENT_API_KEY: f.key };
}

function cli(f, args, input) {
  const result = spawnSync(executable, ["cli", "--data-dir", f.data, ...args], {
    input, encoding: "utf8", timeout: 30_000, env: environment(f),
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function invoke(f, name, args = {}, errorCode, flags = []) {
  const process = cli(f, [...flags, "call", name, "--stdin"], JSON.stringify(args));
  let response;
  try { response = JSON.parse(process.stdout); }
  catch { assert.fail(`stdout 必须是一个 JSON 结果：${process.stdout}\nstderr：${process.stderr}`); }
  assert.equal(response.schemaVersion, 1);
  assert.equal(response.tool, name);
  if (errorCode) {
    assert.notEqual(process.status, 0);
    assert.equal(response.ok, false);
    assert.equal(response.error.code, errorCode, JSON.stringify(response));
    return response.error;
  }
  assert.equal(process.status, 0, JSON.stringify(response));
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.result;
}

function bind(f) {
  return invoke(f, "xfile_binding_set", { rootDir: f.library });
}

test("CLI 工具发现、输入格式、只读模式与内嵌 SKILL", t => {
  const f = fixture(t);
  const list = JSON.parse(cli(f, ["list"]).stdout);
  assert.equal(list.tools.length, 31);
  assert.equal(new Set(list.tools.map(tool => tool.name)).size, list.tools.length);
  const schema = JSON.parse(cli(f, ["schema", "xfile_file_operation"]).stdout);
  assert.equal(schema.inputSchema.additionalProperties, false);
  assert.ok(schema.outputSchema);
  assert.equal(schema.annotations.destructiveHint, true);
  const readOnly = JSON.parse(cli(f, ["--read-only", "list"]).stdout);
  assert.ok(readOnly.tools.every(tool => tool.annotations.readOnlyHint));
  invoke(f, "xfile_binding_set", { rootDir: f.library }, "READ_ONLY", ["--read-only"]);
  assert.equal(fs.existsSync(path.join(f.data, "library-binding.json")), false);

  const positional = JSON.parse(cli(f, ["call", "xfile_status", "{}"]).stdout);
  assert.equal(positional.result.binding, null);
  const request = path.join(f.directory, "request.json");
  fs.writeFileSync(request, "{}");
  assert.equal(JSON.parse(cli(f, ["call", "xfile_status", "--input-file", request]).stdout).ok, true);
  assert.equal(cli(f, ["skill"]).stdout, skill);
  assert.match(cli(f, ["--help"]).stdout, /--input-file/);
  assert.equal(cli(f, ["call", "xfile_status", "--stdin"], "{").status, 2);
  invoke(f, "xfile_documents_list", { limit: 0 }, "INVALID_ARGUMENT");
  invoke(f, "xfile_status", { unexpected: true }, "INVALID_ARGUMENT");
  invoke(f, "xfile_file_operation", { opType: "write", srcPath: "a.md" }, "INVALID_ARGUMENT");
  invoke(f, "xfile_unknown", {}, "TOOL_NOT_FOUND");
  invoke(f, "xfile_documents_list", {}, "NOT_BOUND");
});

test("真实 CLI 完成资料库、文件、标签、收藏与索引流程", t => {
  const f = fixture(t);
  bind(f);
  assert.equal(invoke(f, "xfile_binding_get").rootDir, fs.realpathSync(f.library));
  assert.equal(invoke(f, "xfile_status").transport, "native");
  invoke(f, "xfile_config_set", { folderOpenBehavior: "single_click" });
  invoke(f, "xfile_config_set", { hideSystemFolders: false });
  assert.equal(invoke(f, "xfile_config_get").folderOpenBehavior, "single_click");
  assert.equal(fs.realpathSync(invoke(f, "xfile_host_directories", { path: f.directory }).currentPath), fs.realpathSync(f.directory));

  invoke(f, "xfile_file_operation", { opType: "create_directory", dstPath: "docs" });
  const created = invoke(f, "xfile_file_operation", {
    opType: "create_file", dstPath: "docs/合同.md", content: "合同 alpha\n第一版正文",
  });
  assert.equal(created.indexUpdated, true, JSON.stringify(created));
  const first = invoke(f, "xfile_file_read", { path: "docs/合同.md" });
  assert.match(first.version, /^[a-f0-9]{64}$/);
  assert.equal(first.content, "合同 alpha\n第一版正文");
  const part = invoke(f, "xfile_file_read", { path: "docs/合同.md", limitBytes: 4 });
  assert.equal(part.content, "合");
  assert.equal(part.nextOffset, 3);
  assert.equal(part.truncated, true);
  assert.equal(invoke(f, "xfile_file_read", { path: "docs/合同.md", offset: part.nextOffset }).content.startsWith("同"), true);
  invoke(f, "xfile_file_read", { path: "docs/合同.md", offset: 1 }, "INVALID_ARGUMENT");
  assert.equal(invoke(f, "xfile_file_preview", { path: "docs/合同.md" }).content, first.content);
  const documents = invoke(f, "xfile_documents_list", { keyword: "alpha" });
  assert.equal(documents.items.length, 1);
  const documentId = documents.items[0].documentId;
  assert.equal(invoke(f, "xfile_files_list", { path: "docs" }).items[0].name, "合同.md");

  const topic = invoke(f, "xfile_tags_ensure", { path: "主题/合同" });
  assert.equal(invoke(f, "xfile_tags_ensure", { path: "主题/合同" }).id, topic.id);
  assert.equal(invoke(f, "xfile_tags_get", { tagId: topic.id }).path, "主题/合同");
  invoke(f, "xfile_document_tags_set", { documentId, tagIds: [topic.id] });
  assert.deepEqual(invoke(f, "xfile_document_tags_get", { documentId }).manualTagIds, [topic.id]);
  invoke(f, "xfile_document_tags_set", { documentId, tagIds: ["missing"] }, "TAG_NOT_FOUND");
  assert.deepEqual(invoke(f, "xfile_document_tags_get", { documentId }).manualTagIds, [topic.id]);
  invoke(f, "xfile_folder_tags_set", { folderPath: "docs", tagIds: [], createTagPaths: ["部门/法务"] });
  assert.equal(invoke(f, "xfile_folder_tags_get", { folderPath: "docs" }).bindingTagIds.length, 1);
  const automatic = invoke(f, "xfile_tags_create", {
    name: "自动合同", description: "智能规则", smartRules: [
      { ruleType: "file_content_contains", matcher: { keyword: "alpha" }, relation: "and", enabled: true },
    ],
  });
  assert.ok(invoke(f, "xfile_document_tags_get", { documentId }).indexedTags.includes("自动合同"));
  const updatedTag = invoke(f, "xfile_tags_update", { tagId: automatic.id, name: "自动合同更新" });
  assert.equal(updatedTag.description, "智能规则");
  assert.equal(updatedTag.smartRules.length, 1);
  assert.ok(invoke(f, "xfile_tags_list").items.length >= 3);

  const favorites = [
    { kind: "folder", path: "docs", label: "合同目录" },
    { kind: "folder", path: "", label: "根目录" },
  ];
  invoke(f, "xfile_favorites_set", { favorites });
  assert.deepEqual(invoke(f, "xfile_favorites_get").items.map(({ kind, path, label }) => ({ kind, path, label })), favorites);
  const edited = invoke(f, "xfile_file_operation", {
    opType: "write", srcPath: "docs/合同.md", content: "合同 beta\n第二版正文", expectedVersion: first.version,
  });
  assert.equal(edited.indexUpdated, true, JSON.stringify(edited));
  invoke(f, "xfile_file_operation", {
    opType: "write", srcPath: "docs/合同.md", content: "不应覆盖", expectedVersion: first.version,
  }, "VERSION_CONFLICT");
  assert.equal(invoke(f, "xfile_documents_list", { keyword: "beta" }).items.length, 1);
  assert.deepEqual(invoke(f, "xfile_document_tags_get", { documentId }).manualTagIds, [topic.id]);
  assert.equal(invoke(f, "xfile_document_tags_get", { documentId }).indexedTags.includes("自动合同更新"), false);
  assert.equal(invoke(f, "xfile_tags_recompute").state, "fresh");
  assert.equal(invoke(f, "xfile_tags_recompute_status").state, "fresh");
  invoke(f, "xfile_tags_delete", { tagId: automatic.id });
  assert.ok(!invoke(f, "xfile_tags_list").items.some(tag => tag.id === automatic.id));

  invoke(f, "xfile_file_operation", { opType: "copy", srcPath: "docs/合同.md", dstPath: "docs/副本.md" });
  invoke(f, "xfile_file_operation", { opType: "move", srcPath: "docs/副本.md", dstPath: "docs/归档.md" });
  invoke(f, "xfile_file_operation", { opType: "copy", srcPath: "docs/合同.md", dstPath: "docs/归档.md" }, "ALREADY_EXISTS");
  invoke(f, "xfile_file_operation", { opType: "delete", srcPath: "docs/归档.md" });
  invoke(f, "xfile_file_operation", { opType: "copy", srcPath: "docs", dstPath: "copy" });
  invoke(f, "xfile_file_operation", { opType: "delete", srcPath: "copy", recursive: true });
  invoke(f, "xfile_index_refresh", { targetPaths: ["docs"] });
  assert.equal(invoke(f, "xfile_index_status").state, "cooldown");
  assert.equal(invoke(f, "xfile_snapshot").documentCount, 1);
  const settings = invoke(f, "xfile_onlyoffice_settings_get");
  assert.equal(settings.enabled, false);
  const office = invoke(f, "xfile_onlyoffice_settings_set", {
    enabled: false, serverUrl: "http://127.0.0.1:19099", jwtSecret: "test-secret",
  });
  assert.equal(JSON.stringify(office).includes("test-secret"), false);
  assert.equal(invoke(f, "xfile_onlyoffice_settings_set", { userDisplayName: "Agent" }).serverUrl, "http://127.0.0.1:19099");
  assert.equal(invoke(f, "xfile_onlyoffice_status").state, "disabled");
});

test("文件路径、符号链接、二进制读取和失败清理", t => {
  const f = fixture(t);
  bind(f);
  fs.writeFileSync(path.join(f.library, "bytes.bin"), Buffer.from([0, 255, 12, 128]));
  const binary = invoke(f, "xfile_file_read", { path: "bytes.bin", encoding: "base64" });
  assert.deepEqual(Buffer.from(binary.content, "base64"), Buffer.from([0, 255, 12, 128]));
  invoke(f, "xfile_file_read", { path: "bytes.bin" }, "UNSUPPORTED_ENCODING");
  for (const invalid of ["../outside", "/etc/passwd", "C:\\outside", "a/../../b"]) {
    invoke(f, "xfile_file_read", { path: invalid }, invalid.includes("..") ? "PATH_OUTSIDE_LIBRARY" : "PATH_INVALID");
  }
  invoke(f, "xfile_file_read", { path: ".ai-index/anything" }, "PATH_RESERVED");
  invoke(f, "xfile_documents_list", { selectedFolderPath: "../outside" }, "PATH_OUTSIDE_LIBRARY");
  invoke(f, "xfile_folder_tags_set", { folderPath: "../outside", tagIds: [] }, "PATH_OUTSIDE_LIBRARY");
  invoke(f, "xfile_file_operation", { opType: "delete", srcPath: "." }, "PATH_INVALID");
  fs.writeFileSync(path.join(f.library, ".private.md"), "hidden");
  invoke(f, "xfile_file_read", { path: ".private.md" }, "PATH_HIDDEN");
  if (process.platform !== "win32") {
    const outside = path.join(f.directory, "outside.md");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(f.library, "escape.md"));
    invoke(f, "xfile_file_read", { path: "escape.md" }, "PATH_OUTSIDE_LIBRARY");
    invoke(f, "xfile_file_operation", { opType: "delete", srcPath: "escape.md" }, "PATH_SYMLINK");
    assert.equal(fs.readFileSync(outside, "utf8"), "outside");
    fs.symlinkSync(path.join(f.library, ".private.md"), path.join(f.library, "alias.md"));
    invoke(f, "xfile_file_read", { path: "alias.md" }, "PATH_HIDDEN");
    fs.mkdirSync(path.join(f.library, "node_modules"));
    fs.symlinkSync(path.join(f.library, "node_modules"), path.join(f.library, "visible-alias"));
    invoke(f, "xfile_files_list", { path: "visible-alias" }, "PATH_HIDDEN");
    fs.chmodSync(path.join(f.library, "bytes.bin"), 0o600);
    invoke(f, "xfile_file_operation", { opType: "copy", srcPath: "bytes.bin", dstPath: "copy.bin" });
    assert.equal(fs.statSync(path.join(f.library, "copy.bin")).mode & 0o777, 0o600);
    fs.mkdirSync(path.join(f.library, "links"));
    fs.symlinkSync(outside, path.join(f.library, "links", "bad.md"));
    invoke(f, "xfile_file_operation", { opType: "copy", srcPath: "links", dstPath: "failed-copy" }, "PATH_SYMLINK");
    assert.equal(fs.existsSync(path.join(f.library, "failed-copy")), false);
  }
});

test("两个 CLI 进程不能用同一旧版本互相覆盖", async t => {
  const f = fixture(t);
  bind(f);
  invoke(f, "xfile_file_operation", { opType: "create_file", dstPath: "shared.md", content: "原文" });
  const current = invoke(f, "xfile_file_read", { path: "shared.md" });
  const write = content => new Promise((resolve, reject) => {
    const child = spawn(executable, ["cli", "--data-dir", f.data, "call", "xfile_file_operation",
      JSON.stringify({ opType: "write", srcPath: "shared.md", content, expectedVersion: current.version })],
    { stdio: ["ignore", "pipe", "pipe"], env: environment(f) });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      try {
        assert.ok(code === 0 || code === 1, stderr);
        resolve(JSON.parse(stdout));
      } catch (error) { reject(error); }
    });
  });
  const results = await Promise.all([write("编辑甲"), write("编辑乙")]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).error.code, "VERSION_CONFLICT");
  assert.ok(["编辑甲", "编辑乙"].includes(fs.readFileSync(path.join(f.library, "shared.md"), "utf8")));
});

test("文件修改后索引失败仍报告已应用，并允许单独恢复索引", t => {
  const f = fixture(t);
  bind(f);
  invoke(f, "xfile_file_operation", { opType: "create_file", dstPath: "recover.md", content: "旧内容" });
  const current = invoke(f, "xfile_file_read", { path: "recover.md" });
  const exports = path.join(f.library, ".ai-index", "exports");
  const backup = path.join(f.directory, "exports-backup");
  fs.renameSync(exports, backup);
  fs.writeFileSync(exports, "故障注入：阻止创建导出目录");
  const result = invoke(f, "xfile_file_operation", {
    opType: "write", srcPath: "recover.md", content: "恢复测试新内容", expectedVersion: current.version,
  });
  assert.equal(result.success, true);
  assert.equal(result.indexUpdated, false);
  assert.ok(result.indexError);
  assert.equal(fs.readFileSync(path.join(f.library, "recover.md"), "utf8"), "恢复测试新内容");
  fs.unlinkSync(exports);
  fs.renameSync(backup, exports);
  invoke(f, "xfile_index_refresh", { targetPaths: ["recover.md"] });
  assert.equal(invoke(f, "xfile_documents_list", { keyword: "恢复测试新内容" }).items.length, 1);
});

class McpClient {
  constructor(f, flags = []) {
    this.child = spawn(executable, ["mcp", "--data-dir", f.data, ...flags], { stdio: ["pipe", "pipe", "pipe"], env: environment(f) });
    this.pending = new Map();
    this.sequence = 0;
    this.stderr = "";
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", text => { this.stderr += text; });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", text => {
      let message;
      try {
        message = JSON.parse(text);
        assert.equal(message.jsonrpc, "2.0");
      } catch (error) {
        for (const request of this.pending.values()) request.reject(error);
        return;
      }
      const request = this.pending.get(message.id);
      if (request) {
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        request.resolve(message);
      }
    });
    this.child.on("exit", (code, signal) => {
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(`MCP exited ${code}/${signal}: ${this.stderr}`));
      }
      this.pending.clear();
    });
  }

  request(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out: ${this.stderr}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: "2025-11-25", capabilities: {},
      clientInfo: { name: "x-file-integration-tests", version: "1.0.0" },
    });
    assert.ok(response.result, JSON.stringify(response));
    assert.equal(response.result.protocolVersion, "2025-11-25");
    assert.equal(response.result.serverInfo.name, "x-file");
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return response.result;
  }

  async close() {
    if (this.child.exitCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 5000);
    try {
      const [code, signal] = await exited;
      assert.equal(signal, null, this.stderr);
      assert.equal(code, 0, this.stderr);
    } finally {
      clearTimeout(timer);
      this.lines.close();
    }
  }
}

test("真实 MCP stdio 握手、发现、读写、资源、错误恢复与正常退出", async t => {
  const f = fixture(t);
  bind(f);
  const client = new McpClient(f);
  t.after(() => client.close());
  const info = await client.initialize();
  assert.ok(info.capabilities.tools);
  assert.ok(info.capabilities.resources);
  const list = await client.request("tools/list");
  assert.equal(list.result.tools.length, 31);
  const call = async (name, args = {}) => {
    const response = await client.request("tools/call", { name, arguments: args });
    assert.ok(response.result, JSON.stringify(response));
    assert.deepEqual(JSON.parse(response.result.content[0].text), response.result.structuredContent);
    return response.result;
  };
  const created = await call("xfile_file_operation", { opType: "create_file", dstPath: "mcp.md", content: "MCP 原生调用" });
  assert.equal(created.isError, false);
  assert.equal(created.structuredContent.result.indexUpdated, true);
  const read = await call("xfile_file_read", { path: "mcp.md" });
  assert.equal(read.structuredContent.result.content, "MCP 原生调用");
  assert.equal((await call("xfile_file_preview", { path: "mcp.md" })).isError, false);
  const invalid = await call("xfile_file_read", { path: "../outside" });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, "PATH_OUTSIDE_LIBRARY");
  const badArgs = await call("xfile_file_read", { path: 123 });
  assert.equal(badArgs.isError, true);
  const unknown = await client.request("tools/call", { name: "unknown", arguments: {} });
  assert.equal(unknown.error.code, -32602);
  assert.equal((await client.request("unknown/method")).error.code, -32601);
  assert.ok((await client.request("ping")).result);
  const resources = await client.request("resources/list");
  assert.equal(resources.result.resources[0].uri, "xfile://skills/x-file");
  const resource = await client.request("resources/read", { uri: "xfile://skills/x-file" });
  assert.equal(resource.result.contents[0].text, skill);
  assert.equal((await client.request("resources/read", { uri: "xfile://unknown" })).error.code, -32002);
  assert.equal((await call("xfile_documents_list", { keyword: "MCP" })).structuredContent.result.items.length, 1);
});

test("MCP 只读模式同时限制工具发现和实际写调用", async t => {
  const f = fixture(t);
  bind(f);
  const client = new McpClient(f, ["--read-only"]);
  t.after(() => client.close());
  await client.initialize();
  const list = await client.request("tools/list");
  assert.ok(list.result.tools.every(tool => tool.annotations.readOnlyHint));
  const result = await client.request("tools/call", {
    name: "xfile_file_operation", arguments: { opType: "create_file", dstPath: "blocked.md" },
  });
  assert.equal(result.result.isError, true);
  assert.equal(result.result.structuredContent.error.code, "READ_ONLY");
  assert.equal(fs.existsSync(path.join(f.library, "blocked.md")), false);
});


test("开关、缺失或错误密钥及已连接 MCP 的换钥和撤销", async t => {
  const f = fixture(t);
  bind(f);
  const client = new McpClient(f);
  t.after(() => client.close());
  await client.initialize();
  const call = () => client.request("tools/call", { name: "xfile_status", arguments: {} });
  assert.equal((await call()).result.structuredContent.ok, true);
  const oldKey = f.key;
  for (const invalidKey of ["", "invalid"]) {
    f.key = invalidKey;
    invoke(f, "xfile_status", {}, "UNAUTHORIZED");
    const denied = spawnSync(executable, ["mcp", "--data-dir", f.data], {
      env: environment(f), encoding: "utf8", timeout: 10_000,
    });
    assert.equal(denied.status, 1);
    assert.equal(denied.stdout, "");
    assert.match(denied.stderr, /UNAUTHORIZED/);
  }
  f.key = oldKey;
  saveAccess(f, true, "replacement-test-credential-thirty-two-characters");
  assert.equal((await call()).result.structuredContent.error.code, "UNAUTHORIZED");
  invoke(f, "xfile_status", {}, "UNAUTHORIZED");
  f.key = "replacement-test-credential-thirty-two-characters";
  invoke(f, "xfile_status");
  saveAccess(f, false, f.key);
  invoke(f, "xfile_status", {}, "AGENT_DISABLED");
  assert.equal((await call()).result.structuredContent.error.code, "AGENT_DISABLED");
  const denied = spawnSync(executable, ["mcp", "--data-dir", f.data], {
    env: environment(f), encoding: "utf8", timeout: 10_000,
  });
  assert.equal(denied.status, 1);
  assert.equal(denied.stdout, "");
  assert.match(denied.stderr, /AGENT_DISABLED/);
  assert.ok(!denied.stderr.includes(f.key));
  assert.equal(JSON.parse(cli(f, ["list"]).stdout).tools.length, 31);
  assert.equal(cli(f, ["skill"]).stdout, skill);
  fs.unlinkSync(path.join(f.data, "agent-integration.json"));
  invoke(f, "xfile_status", {}, "AGENT_DISABLED");
  fs.writeFileSync(path.join(f.data, "agent-integration.json"), "{broken");
  invoke(f, "xfile_status", {}, "SETTINGS_ERROR");
});
