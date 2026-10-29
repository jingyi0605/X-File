import { execFile } from "node:child_process";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveNativeCli } from "@x-file/indexer";

const MCP_PATH = "/api/mcp";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const CLI_TIMEOUT_MS = 5 * 60_000;
const REMOTE_DENIED_TOOLS = new Set([
  "xfile_binding_get",
  "xfile_binding_set",
  "xfile_config_get",
  "xfile_config_set",
  "xfile_host_directories",
  "xfile_snapshot",
]);
const SUPPORTED_PROTOCOLS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
]);
const SKILL_URI = "xfile://skills/x-file";

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface CliEnvelope {
  schemaVersion: number;
  ok: boolean;
  tool: string;
  result?: Record<string, unknown>;
  error?: { code?: string; message?: string };
  tools?: unknown[];
  readOnly?: boolean;
}

export function registerAgentMcpRoutes(app: FastifyInstance): void {
  const activeRequests = new Set<FastifyRequest>();
  app.route({
    method: "POST",
    url: MCP_PATH,
    bodyLimit: MAX_REQUEST_BYTES,
    preParsing: async (request, _reply, payload) => {
      let size = 0;
      payload.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) payload.destroy(new Error("MCP_REQUEST_TOO_LARGE"));
      });
      return payload;
    },
    onRequest: async (request, reply) => {
      if (activeRequests.size >= 8) {
        return reply.code(429).header("retry-after", "1").send(httpError("MCP_BUSY", "Too many concurrent MCP requests."));
      }
      activeRequests.add(request);
    },
    onResponse: async (request) => {
      activeRequests.delete(request);
    },
    errorHandler: (error, _request, reply) => {
      const tooLarge = error.statusCode === 413 || error.message === "MCP_REQUEST_TOO_LARGE";
      const statusCode = tooLarge ? 413 : 400;
      return reply.code(statusCode).send({
        error: { code: tooLarge ? "MCP_REQUEST_TOO_LARGE" : "MCP_INVALID_REQUEST", message: "MCP request could not be processed." },
      });
    },
    handler: async (request, reply) => {
      if (request.headers.origin) {
        return reply.code(403).send(httpError("ORIGIN_NOT_ALLOWED", "Browser-origin MCP requests are not supported."));
      }
      if (!acceptsStreamableHttp(request.headers.accept)) {
        return reply.code(406).send(httpError("MCP_NOT_ACCEPTABLE", "Accept must include application/json and text/event-stream."));
      }
      if (!isJsonContentType(request.headers["content-type"])) {
        return reply.code(415).send(httpError("MCP_UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json."));
      }
      if (request.headers["mcp-session-id"]) {
        return reply.code(400).send(httpError("MCP_SESSION_INVALID", "This endpoint uses stateless MCP requests."));
      }

      const apiKey = readBearerToken(request);
      if (!apiKey) {
        return unauthorized(reply);
      }

      const status = await runCli(apiKey, ["cli", "call", "xfile_status", "--stdin"], "{}");
      if (!status.ok) {
        return authError(reply, status.error?.code);
      }

      const message = request.body as JsonRpcMessage;
      if (!isJsonRpcMessage(message)) {
        return reply.code(400).send(httpError("MCP_INVALID_REQUEST", "Expected one JSON-RPC 2.0 message."));
      }
      const protocolHeader = request.headers["mcp-protocol-version"];
      if (message.method !== "initialize"
        && (typeof protocolHeader !== "string" || !SUPPORTED_PROTOCOLS.has(protocolHeader))) {
        return reply.code(400).send(httpError("MCP_PROTOCOL_VERSION_INVALID", "A supported MCP-Protocol-Version header is required."));
      }
      if (isNotification(message)) {
        if (!isAllowedNotification(message.method as string)) {
          return reply.code(400).send(httpError("MCP_NOTIFICATION_INVALID", "Only notifications/initialized is supported."));
        }
        await dispatch(message, status.result ?? {}, apiKey);
        return reply.code(202).send();
      }
      const response = await dispatch(message, status.result ?? {}, apiKey);
      return reply
        .header("content-type", "application/json")
        .header("mcp-protocol-version", getNegotiatedProtocol(protocolHeader, response))
        .header("cache-control", "no-store")
        .send(response);
    },
  });

  app.get(MCP_PATH, async (_request, reply) =>
    reply.code(405).header("allow", "POST").send(httpError("MCP_METHOD_NOT_ALLOWED", "Server-initiated SSE is not supported.")));
  app.delete(MCP_PATH, async (_request, reply) =>
    reply.code(405).header("allow", "POST").send(httpError("MCP_METHOD_NOT_ALLOWED", "Stateless MCP requests do not have sessions to delete.")));
}

async function dispatch(
  message: JsonRpcMessage,
  status: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const id = message.id;
  const method = message.method as string;
  const params = isRecord(message.params) ? message.params : {};

  if (method === "initialize") {
    const requested = isRecord(params) && typeof params.protocolVersion === "string"
      ? params.protocolVersion
      : "";
    if (!SUPPORTED_PROTOCOLS.has(requested)) {
      return rpcError(id, -32602, "Unsupported protocol version.");
    }
    return rpcResult(id, {
      protocolVersion: requested,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: {
        name: "x-file",
        version: typeof status.version === "string" ? status.version : "unknown",
      },
      instructions: "Use xfile_status to confirm the bound library. Read xfile://skills/x-file for tool guidance.",
    });
  }
  if (method === "ping") return rpcResult(id, {});
  if (method === "tools/list") {
    if (params.cursor !== undefined) return rpcError(id, -32602, "Tool pagination is not supported.");
    const readOnly = status.accessMode !== "read_write";
    const result = await runCli(apiKey, ["cli", ...(readOnly ? ["--read-only"] : []), "list"]);
    if (!Array.isArray(result.tools)) return rpcError(id, -32603, "Unable to list X-File tools.");
    return rpcResult(id, {
      tools: result.tools.filter((tool) => isRecord(tool) && !REMOTE_DENIED_TOOLS.has(String(tool.name))),
    });
  }
  if (method === "tools/call") {
    if (typeof params.name !== "string" || (params.arguments !== undefined && !isRecord(params.arguments))) {
      return rpcError(id, -32602, "Invalid tool call parameters.");
    }
    if (REMOTE_DENIED_TOOLS.has(params.name)) {
      return rpcResult(id, toolResult({
        schemaVersion: 1,
        ok: false,
        tool: params.name,
        error: { code: "REMOTE_TOOL_DENIED", message: "This tool is unavailable over remote MCP." },
      }));
    }
    const result = await runCli(
      apiKey,
      ["cli", ...(status.accessMode !== "read_write" ? ["--read-only"] : []), "call", params.name, "--stdin"],
      JSON.stringify(params.arguments ?? {}),
    );
    if (result.error?.code === "TOOL_NOT_FOUND") return rpcError(id, -32602, "Unknown X-File tool.");
    return rpcResult(id, toolResult(params.name === "xfile_status" ? sanitizeRemoteEnvelope(result) : result));
  }
  if (method === "resources/list") {
    if (params.cursor !== undefined) return rpcError(id, -32602, "Resource pagination is not supported.");
    return rpcResult(id, {
      resources: [{
        uri: SKILL_URI,
        name: "x-file-skill",
        mimeType: "text/markdown",
        description: "X-File external Agent workflow",
      }],
    });
  }
  if (method === "resources/read") {
    if (params.uri !== SKILL_URI) return rpcError(id, -32002, "Resource not found.");
    const skill = await runCli(apiKey, ["cli", "skill"]);
    if (!skill.ok) return rpcError(id, -32603, "Unable to read X-File skill.");
    return rpcResult(id, { contents: [{ uri: SKILL_URI, mimeType: "text/markdown", text: skill.stdout }] });
  }
  return rpcError(id, -32601, "Method not found.");
}

function toolResult(envelope: CliEnvelope): Record<string, unknown> {
  const safeEnvelope = stripHostPaths(envelope) as CliEnvelope;
  const payload = JSON.stringify(safeEnvelope);
  return {
    content: [{ type: "text", text: payload }],
    structuredContent: safeEnvelope,
    isError: !safeEnvelope.ok,
  };
}

function sanitizeRemoteEnvelope(envelope: CliEnvelope): CliEnvelope {
  if (envelope.tool !== "xfile_status" || !envelope.result) return envelope;
  const binding = isRecord(envelope.result.binding) ? { ...envelope.result.binding } : envelope.result.binding;
  if (isRecord(binding)) delete binding.rootDir;
  const result: Record<string, unknown> = { ...envelope.result, binding };
  delete result.dataDir;
  delete result.mirrorRoot;
  delete result.defaultRootDir;
  delete result.executablePath;
  return { ...envelope, result };
}

function stripHostPaths(value: unknown, insideError = false): unknown {
  if (Array.isArray(value)) return value.map((item) => stripHostPaths(item, insideError));
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (["rootDir", "dataDir", "executablePath", "mirrorRoot", "previewPath"].includes(key)) continue;
    if (insideError && key === "message" && typeof item === "string" && looksLikeHostPath(item)) {
      output[key] = "The native operation failed; host path details were removed.";
    } else {
      output[key] = stripHostPaths(item, key === "error");
    }
  }
  return output;
}

function looksLikeHostPath(value: string): boolean {
  return /(?:[A-Za-z]:\\|\\\\[^\\]+\\|\/Users\/|\/home\/|\/private\/|\/var\/|\/tmp\/)/.test(value);
}

async function runCli(
  apiKey: string,
  args: string[],
  stdin = "",
): Promise<CliEnvelope & { stdout?: string }> {
  let executable: string;
  try {
    executable = resolveNativeCli();
  } catch {
    return failure("NATIVE_CLI_UNAVAILABLE", "X-File native CLI is unavailable.");
  }

  const output = await new Promise<{ stdout: string; stderr: string; error: Error | null }>((resolve) => {
    const child = execFile(executable, args, {
      env: { ...process.env, X_FILE_AGENT_API_KEY: apiKey },
      timeout: CLI_TIMEOUT_MS,
      maxBuffer: MAX_RESPONSE_BYTES,
      windowsHide: true,
    }, (error, stdout, stderr) => resolve({ stdout, stderr, error }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });

  try {
    const parsed = JSON.parse(output.stdout) as CliEnvelope;
    return { ...parsed, stdout: output.stdout };
  } catch {
    if (args.at(-1) === "skill" && !output.error) {
      return { schemaVersion: 1, ok: true, tool: "skill", result: {}, stdout: output.stdout };
    }
    const disabled = output.stdout.includes("AGENT_DISABLED");
    const unauthorized = output.stdout.includes("UNAUTHORIZED");
    return failure(
      disabled ? "AGENT_DISABLED" : unauthorized ? "UNAUTHORIZED" : "NATIVE_CLI_ERROR",
      disabled ? "External Agent access is disabled." : unauthorized ? "Invalid Agent API key." : "X-File native CLI request failed.",
    );
  }
}

function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return isRecord(value) && value.jsonrpc === "2.0"
    && typeof value.method === "string"
    && (!("id" in value) || typeof value.id === "string" || typeof value.id === "number" || value.id === null);
}

function isNotification(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && !("id" in message);
}

function isAllowedNotification(method: string): boolean {
  return ["notifications/initialized", "notifications/cancelled", "notifications/progress"].includes(method);
}

function acceptsStreamableHttp(value: string | undefined): boolean {
  if (!value) return false;
  const accepted = value.split(",").map((item) => item.split(";")[0]?.trim().toLowerCase());
  return accepted.includes("application/json") && accepted.includes("text/event-stream");
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  const contentType = Array.isArray(value) ? value[0] : value;
  return contentType?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function readBearerToken(request: FastifyRequest): string | null {
  const value = request.headers.authorization;
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice(7).trim();
  return /^[\x21-\x7e]{32,512}$/.test(token) ? token : null;
}

function unauthorized(reply: FastifyReply): unknown {
  return reply.code(401).header("www-authenticate", "Bearer").send(httpError("UNAUTHORIZED", "A valid X-File Agent API key is required."));
}

function authError(reply: FastifyReply, code?: string): unknown {
  if (code === "AGENT_DISABLED") return reply.code(403).header("cache-control", "no-store").send(httpError(code, "External Agent access is disabled."));
  return unauthorized(reply);
}

function httpError(code: string, message: string): Record<string, unknown> {
  return { error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function getNegotiatedProtocol(protocolHeader: string | string[] | undefined, response: Record<string, unknown>): string {
  if (typeof protocolHeader === "string" && SUPPORTED_PROTOCOLS.has(protocolHeader)) {
    return protocolHeader;
  }
  if (isRecord(response.result)
    && typeof response.result.protocolVersion === "string") {
    return response.result.protocolVersion;
  }
  return "2025-11-25";
}

function failure(code: string, message: string): CliEnvelope & { stdout?: string } {
  return { schemaVersion: 1, ok: false, tool: "remote-mcp", error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
