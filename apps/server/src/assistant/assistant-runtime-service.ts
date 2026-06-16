// 文档助手运行时服务：把文档库根目录作为 codex / Claude Code 的工作区，
// 复用 session-sync-core 的 ClaudeRuntimeAdapter / CodexRuntimeAdapter /
// ProviderRuntimeService，自己只维护会话表与 SSE 事件流转。
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fsPromises, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

import {
  ClaudeRuntimeAdapter,
  ClaudeCodeAdapter,
  CodexAdapter,
  CodexRuntimeAdapter,
  ProviderRuntimeService,
  type NormalizedMessage,
  type NormalizedMessageAttachment,
  type ProviderRuntimeAdapter,
  type ProviderRuntimeRunRequest,
  type ProviderModelOption,
  type ProviderSubscription,
  type RuntimeAttachment,
  type RuntimeEvent
} from "@codingns/session-sync-core";

import type { LibraryBindingStore } from "../storage/library-binding-store.js";
import { AssistantError } from "./assistant-errors.js";
import { AssistantSessionStore, type AssistantSessionRecord } from "./assistant-session-store.js";
import {
  ASSISTANT_PROVIDER_IDS,
  isAssistantProviderId,
  type AssistantEventSink,
  type AssistantMessage,
  type AssistantPermissionAction,
  type AssistantPermissionKind,
  type AssistantPermissionRequest,
  type AssistantProviderId,
  type AssistantProviderInfo,
  type AssistantSessionSummary,
  type SendAssistantMessageInput,
  type StartAssistantSessionInput
} from "./assistant-types.js";

const X_FILE_WORKSPACE_ID = "x-file-library";
const DEFAULT_PERMISSION_MODE = "acceptEdits";

export class AssistantRuntimeService {
  private readonly runtime: ProviderRuntimeService;
  private readonly providerCapabilities = new Map<AssistantProviderId, {
    supportsAttachments: boolean;
    modelOptions: ProviderModelOption[];
    defaultReasoningLevel: string | null;
    supportedReasoningLevels: string[];
  }>();
  private readonly availableProviders = new Set<AssistantProviderId>();
  private readonly subscriptionsBySession = new Map<string, ProviderSubscription>();
  // 当前活跃 SSE 连接的 sink，用于把 codex 权限请求实时推给前端。
  private readonly sessionSinks = new Map<string, AssistantEventSink>();
  // 权限请求的 deferred，前端回复时 resolve，让 handleServerRequest 返回 codex。
  private readonly permissionDeferreds = new Map<
    string,
    { resolve: (value: unknown) => void; kind: AssistantPermissionKind; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly bindingStore: LibraryBindingStore,
    private readonly store = new AssistantSessionStore()
  ) {
    const adapters: ProviderRuntimeAdapter[] = [];

    try {
      const homeDir = this.resolveGlobalRuntimeHome("claude-code");
      adapters.push(
        new ClaudeRuntimeAdapter({
          homeDir,
          hookBridge: null
        })
      );
      this.providerCapabilities.set("claude-code", readAssistantProviderCapabilities(
        new ClaudeCodeAdapter({ homeDir })
      ));
      this.availableProviders.add("claude-code");
    } catch (error) {
      console.warn("[assistant] claude-code adapter 初始化失败", error);
    }

    try {
      const homeDir = this.resolveGlobalRuntimeHome("codex");
      adapters.push(
        new CodexRuntimeAdapter({
          homeDir,
          handleServerRequest: async (input) => this.handleCodexServerRequest(input)
        })
      );
      this.providerCapabilities.set("codex", readAssistantProviderCapabilities(
        new CodexAdapter({ homeDir }),
        getDefaultCodexModelOptions()
      ));
      this.availableProviders.add("codex");
    } catch (error) {
      console.warn("[assistant] codex adapter 初始化失败", error);
    }

    this.runtime = new ProviderRuntimeService(adapters);
  }

  listProviders(): AssistantProviderInfo[] {
    return ASSISTANT_PROVIDER_IDS.map((id) => {
      const status = this.detectProvider(id);
      const capabilities = this.providerCapabilities.get(id);
      return {
        id,
        label: id === "claude-code" ? "Claude Code" : "Codex",
        commandReady: status.commandReady,
        authReady: status.authReady,
        available: status.commandReady && status.authReady,
        detail: status.detail,
        supportsAttachments: capabilities?.supportsAttachments ?? false,
        modelOptions: capabilities?.modelOptions ?? [],
        defaultReasoningLevel: normalizeAssistantReasoningLevel(capabilities?.defaultReasoningLevel ?? null),
        supportedReasoningLevels: normalizeAssistantReasoningLevels(capabilities?.supportedReasoningLevels ?? []),
      };
    });
  }

  // 检测本机 CLI 命令与登录态是否就绪，给前端 provider 选择提供准确状态。
  private detectProvider(id: AssistantProviderId): {
    commandReady: boolean;
    authReady: boolean;
    detail: string | null;
  } {
    const command = id === "claude-code" ? "claude" : "codex";
    const label = id === "claude-code" ? "Claude Code" : "Codex";
    const commandReady = detectCommandReady(command);
    if (!commandReady) {
      return {
        commandReady: false,
        authReady: false,
        detail: `未检测到 ${command} 命令，请先安装 ${label} CLI`
      };
    }
    const authReady = detectAuthReady(id);
    if (!authReady) {
      return {
        commandReady: true,
        authReady: false,
        detail: `未检测到 ${label} 登录态，请先在终端登录`
      };
    }
    return { commandReady: true, authReady: true, detail: null };
  }

  resolveWorkspacePath(): string {
    const binding = this.bindingStore.read();
    if (!binding || !binding.rootDir?.trim()) {
      throw new AssistantError(400, "LIBRARY_NOT_BOUND", "请先绑定文档库根目录");
    }
    // 优先用镜像根目录（如果配置了），否则用原始根目录，作为 agent 的 cwd。
    return binding.mirrorRoot?.trim() || binding.rootDir.trim();
  }

  startSession(input: StartAssistantSessionInput): AssistantSessionSummary {
    if (!isAssistantProviderId(input.provider)) {
      throw new AssistantError(
        400,
        "ASSISTANT_PROVIDER_NOT_SUPPORTED",
        `不支持的 provider: ${String(input.provider)}`
      );
    }
    const status = this.detectProvider(input.provider);
    if (!status.commandReady || !status.authReady) {
      throw new AssistantError(
        503,
        "ASSISTANT_PROVIDER_UNAVAILABLE",
        status.detail ?? `${input.provider} 运行时不可用`
      );
    }

    const workspacePath = this.resolveWorkspacePath();
    const sessionId = randomUUID();
    const record = this.store.create({
      sessionId,
      provider: input.provider,
      workspacePath,
      runtimeHomeDir: this.resolveGlobalRuntimeHome(input.provider),
      providerSessionId: input.resumeProviderSessionId ?? null
    });
    return this.store.toSummary(record);
  }

  async sendMessage(
    sessionId: string,
    input: SendAssistantMessageInput,
    sink: AssistantEventSink
  ): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new AssistantError(404, "ASSISTANT_SESSION_NOT_FOUND", `会话不存在: ${sessionId}`);
    }
    if (!input.content?.trim()) {
      throw new AssistantError(400, "ASSISTANT_INVALID_INPUT", "消息内容不能为空");
    }

    this.store.setActiveRun(sessionId, true);
    this.sessionSinks.set(sessionId, sink);
    sink({ kind: "status", status: "starting", detail: null });
    const isFirstUserMessage = session.messages.length === 0;

    const runtimeAttachments = await this.materializeRuntimeAttachments(session, input.attachments ?? []);
    const userMessage = buildUserAssistantMessage({
      sessionId,
      providerSessionId: session.providerSessionId,
      content: input.content,
      sequence: this.store.nextSequence(sessionId),
      attachments: runtimeAttachments
    });
    this.store.appendMessage(sessionId, userMessage);
    if (isFirstUserMessage) {
      this.store.updateTitle(sessionId, buildSessionTitleFromContent(input.content, "新对话"));
    }
    sink({ kind: "message", message: userMessage });

    // 先订阅本 session 的事件，再启动 run，确保 message/complete/error 都能收到。
    // active-run-registry 的 attach 在 register 之前调用也是安全的。
    const subscription = this.runtime.subscribe(sessionId, (event) => {
      void this.handleRuntimeEvent(sessionId, event, sink, subscription);
    });
    this.subscriptionsBySession.set(sessionId, subscription);

    const request: ProviderRuntimeRunRequest = {
      sessionId,
      workspaceId: X_FILE_WORKSPACE_ID,
      workspacePath: session.workspacePath,
      provider: session.provider,
      providerSessionId: session.providerSessionId,
      rawStoreRef: session.rawStoreRef,
      runtimeHomeDir: session.runtimeHomeDir,
      runtimeEnv: null,
      options: {
        content: input.content,
        clientRequestId: randomUUID(),
        model: input.model ?? null,
        reasoningLevel: input.reasoningLevel ?? null,
        // 文档助手核心就是让 agent 操作文档库文件，默认放行编辑。
        permissionMode: DEFAULT_PERMISSION_MODE,
        providerPrompt: null,
        attachments: runtimeAttachments
      }
    };

    try {
      const handle = session.providerSessionId
        ? await this.runtime.continueSession(request)
        : await this.runtime.startSession(request);
      const snapshot = handle.getSnapshot();
      this.store.updateBinding(sessionId, snapshot.providerSessionId, snapshot.rawStoreRef);
    } catch (error) {
      this.finishRun(sessionId, subscription);
      const detail = error instanceof Error ? error.message : "provider runtime failed";
      sink({ kind: "error", detail, errorCode: "ASSISTANT_RUNTIME_ERROR" });
      sink({ kind: "end" });
    }
  }

  private async handleRuntimeEvent(
    sessionId: string,
    event: RuntimeEvent,
    sink: AssistantEventSink,
    subscription: ProviderSubscription
  ): Promise<void> {
    if (event.type === "message") {
      const message = toAssistantMessage(sessionId, event.message);
      this.store.appendMessage(sessionId, message);
      sink({ kind: "message", message });
      return;
    }

    if (event.type === "session_created") {
      this.store.updateBinding(sessionId, event.providerSessionId, event.rawStoreRef);
      return;
    }

    const runtimeStatus = mapRuntimeEventToAssistantStatus(event);
    if (runtimeStatus) {
      sink({ kind: "status", status: runtimeStatus.status, detail: event.detail });
      if (runtimeStatus.terminal) {
        this.finishRun(sessionId, subscription);
        sink({ kind: "end" });
      }
      // failed 状态运行时只会出现在 error 事件里，这里忽略，交给 error 分支处理。
      return;
    }

    if (event.type === "error") {
      sink({
        kind: "error",
        detail: event.detail ?? "provider runtime error",
        errorCode: event.errorCode
      });
      this.finishRun(sessionId, subscription);
      sink({ kind: "end" });
    }
  }

  private finishRun(sessionId: string, subscription: ProviderSubscription): void {
    this.store.setActiveRun(sessionId, false);
    this.sessionSinks.delete(sessionId);
    subscription.close();
    if (this.subscriptionsBySession.get(sessionId) === subscription) {
      this.subscriptionsBySession.delete(sessionId);
    }
  }

  // codex app-server 请求审批时回调：解析成可读请求，推给前端，等用户回复。
  private async handleCodexServerRequest(input: {
    sessionId: string;
    providerSessionId: string;
    request: Record<string, unknown>;
  }): Promise<unknown> {
    const parsed = parseCodexServerRequest(input.sessionId, input.request);
    const request: AssistantPermissionRequest = {
      requestId: randomUUID(),
      sessionId: input.sessionId,
      kind: parsed.kind,
      title: parsed.title,
      summary: parsed.summary,
      detail: parsed.detail,
      status: "pending",
      createdAt: new Date().toISOString()
    };
    this.store.addPermissionRequest(input.sessionId, request);

    const sink = this.sessionSinks.get(input.sessionId);
    sink?.({ kind: "permission_request", request });

    return new Promise<unknown>((resolve) => {
      // 5 分钟无人回复则自动批准，避免 codex 永久阻塞。
      const timer = setTimeout(() => {
        if (this.permissionDeferreds.has(request.requestId)) {
          this.permissionDeferreds.delete(request.requestId);
          this.store.resolvePermissionRequest(request.requestId, "approved");
          resolve(buildCodexApprovalResult(parsed.kind, "accept"));
        }
      }, 300000);
      this.permissionDeferreds.set(request.requestId, { resolve, kind: parsed.kind, timer });
    });
  }

  replyPermissionRequest(
    requestId: string,
    action: AssistantPermissionAction
  ): AssistantPermissionRequest | null {
    const deferred = this.permissionDeferreds.get(requestId);
    if (!deferred) {
      throw new AssistantError(404, "ASSISTANT_SESSION_NOT_FOUND", "权限请求不存在或已过期");
    }
    clearTimeout(deferred.timer);
    this.permissionDeferreds.delete(requestId);
    const status = action === "accept" ? "approved" : "rejected";
    const request = this.store.resolvePermissionRequest(requestId, status);
    deferred.resolve(buildCodexApprovalResult(deferred.kind, action));
    return request;
  }

  getPermissionRequests(sessionId: string): AssistantPermissionRequest[] {
    return this.store.getPermissionRequests(sessionId);
  }

  async interrupt(sessionId: string): Promise<void> {
    const session = this.store.get(sessionId);
    if (!session) {
      throw new AssistantError(404, "ASSISTANT_SESSION_NOT_FOUND", `会话不存在: ${sessionId}`);
    }
    try {
      await this.runtime.interrupt(sessionId);
    } catch (error) {
      // 没有 active run 时中断会抛 ACTIVE_RUN_NOT_FOUND / INTERRUPT_NOT_SUPPORTED，按幂等处理。
      if (
        !(error instanceof Error && /ACTIVE_RUN_NOT_FOUND|INTERRUPT_NOT_SUPPORTED/.test(error.message))
      ) {
        throw error;
      }
    }
  }

  getMessages(sessionId: string): AssistantMessage[] {
    return this.store.getMessages(sessionId);
  }

  // 载入历史会话（含消息），用于切换/恢复。若会话不存在返回 null。
  loadSession(sessionId: string): AssistantSessionRecord | null {
    return this.store.loadRecord(sessionId);
  }

  deleteSession(sessionId: string): boolean {
    return this.store.delete(sessionId);
  }

  getStore(): AssistantSessionStore {
    return this.store;
  }

  resolveAttachmentPath(sessionId: string, attachmentId: string): string | null {
    const directory = this.store.getAttachmentDirectory(sessionId);
    const safeId = attachmentId.trim();
    if (!safeId) {
      return null;
    }
    try {
      const matches = readdirSync(directory).filter((name) => name.startsWith(`${safeId}-`));
      if (matches[0]) {
        return path.join(directory, matches[0]);
      }
    } catch {
      return null;
    }
    return null;
  }

  // 精简版直接复用全局 CLI 登录态：claude 用 ~/.claude，codex 用 ~/.codex。
  // adapter 内部会把 CLAUDE_CONFIG_DIR / codex 配置指向这里，从而读到已登录的凭证。
  private resolveGlobalRuntimeHome(provider: AssistantProviderId): string {
    return provider === "claude-code"
      ? path.join(homedir(), ".claude")
      : path.join(homedir(), ".codex");
  }

  private async materializeRuntimeAttachments(
    session: AssistantSessionRecord,
    attachments: NonNullable<SendAssistantMessageInput["attachments"]>
  ): Promise<RuntimeAttachment[]> {
    if (attachments.length === 0) {
      return [];
    }

    const baseDir = this.store.getAttachmentDirectory(session.sessionId);
    await fsPromises.mkdir(baseDir, { recursive: true });

    const results: RuntimeAttachment[] = [];

    for (const attachment of attachments) {
      if (attachment.kind !== "image") {
        continue;
      }
      const parsed = parseDataUrl(attachment.dataUrl);
      if (!parsed) {
        continue;
      }
      const fileName = buildSafeAttachmentFileName(attachment.id, attachment.fileName, parsed.extension);
      const filePath = path.join(baseDir, fileName);
      await fsPromises.writeFile(filePath, parsed.buffer);
      results.push({
        id: attachment.id,
        kind: attachment.kind,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        fileSize: attachment.fileSize || parsed.buffer.byteLength,
        filePath
      });
    }

    return results;
  }
}

function toAssistantMessage(sessionId: string, message: NormalizedMessage): AssistantMessage {
  const toolCall = message.toolCall
    ? {
        callId: message.toolCall.callId,
        name: message.toolCall.name,
        input: message.toolCall.input,
        output: message.toolCall.output,
        error: message.toolCall.error,
        status: message.toolCall.status
      }
    : null;

  return {
    messageId: message.messageId,
    role: message.role,
    kind: message.kind,
    content: message.content,
    toolCall,
    attachments: normalizeAssistantAttachments(sessionId, message.attachments ?? []),
    timestamp: message.timestamp,
    sequence: message.sequence,
    providerSessionId: message.providerSessionId
  };
}

function normalizeAssistantAttachments(
  sessionId: string,
  attachments: NormalizedMessageAttachment[]
) {
  return attachments.map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    fileSize: attachment.fileSize,
    contentUrl: `/api/assistant/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(attachment.id)}`
  }));
}

function buildUserAssistantMessage(input: {
  sessionId: string;
  providerSessionId: string | null;
  content: string;
  sequence: number;
  attachments: RuntimeAttachment[];
}): AssistantMessage {
  return {
    messageId: `local-user-${randomUUID()}`,
    role: "user",
    kind: "text",
    content: input.content,
    toolCall: null,
    attachments: normalizeAssistantAttachments(input.sessionId, input.attachments),
    timestamp: new Date().toISOString(),
    sequence: input.sequence,
    providerSessionId: input.providerSessionId
  };
}

function parseDataUrl(value: string): { buffer: Buffer; extension: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/i.exec(value.trim());
  if (!match) {
    return null;
  }
  const mimeType = match[1]?.toLowerCase() ?? "";
  const extension = mimeType.includes("png")
    ? "png"
    : mimeType.includes("jpeg") || mimeType.includes("jpg")
      ? "jpg"
      : mimeType.includes("webp")
        ? "webp"
        : "bin";
  try {
    return {
      buffer: Buffer.from(match[2], "base64"),
      extension
    };
  } catch {
    return null;
  }
}

function buildSafeAttachmentFileName(id: string, fileName: string, fallbackExtension: string): string {
  const safeBase = fileName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "attachment";
  const hasExtension = /\.[A-Za-z0-9]+$/.test(safeBase);
  const normalized = hasExtension ? safeBase : `${safeBase}.${fallbackExtension}`;
  return `${id}-${normalized}`;
}

function readAssistantProviderCapabilities(adapter: {
  getProviderCapabilities(): {
    supportsAttachments: boolean;
    modelOptions?: ProviderModelOption[];
    defaultReasoningLevel?: string | null;
  };
}, fallbackModelOptions?: ProviderModelOption[]) {
  const capabilities = adapter.getProviderCapabilities();
  const modelOptions = capabilities.modelOptions?.length ? capabilities.modelOptions : (fallbackModelOptions ?? []);
  const reasoningLevels = new Set<string>();
  modelOptions.forEach((option) => {
    option.supportedReasoningEfforts?.forEach((level) => {
      reasoningLevels.add(level);
    });
  });
  if (capabilities.defaultReasoningLevel) {
    reasoningLevels.add(capabilities.defaultReasoningLevel);
  }
  return {
    supportsAttachments: capabilities.supportsAttachments,
    modelOptions,
    defaultReasoningLevel: capabilities.defaultReasoningLevel ?? null,
    supportedReasoningLevels: [...reasoningLevels]
  };
}

function getDefaultCodexModelOptions(): ProviderModelOption[] {
  return [
    {
      id: "provider-default",
      name: "默认",
      usesProviderDefault: true,
      supportedReasoningEfforts: ["minimal", "low", "medium", "high", "maximum"]
    },
    {
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      supportedReasoningEfforts: ["minimal", "low", "medium", "high", "maximum"]
    },
    {
      id: "codex-mini-latest",
      name: "Codex Mini Latest",
      supportedReasoningEfforts: ["minimal", "low", "medium", "high", "maximum"]
    }
  ];
}

function normalizeAssistantReasoningLevel(value: string | null) {
  if (!value) {
    return null;
  }
  if (value === "xhigh") {
    return "maximum";
  }
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "maximum") {
    return value;
  }
  return null;
}

function normalizeAssistantReasoningLevels(values: string[]) {
  const normalized = values
    .map((value) => normalizeAssistantReasoningLevel(value))
    .filter((value): value is NonNullable<ReturnType<typeof normalizeAssistantReasoningLevel>> => Boolean(value));
  return Array.from(new Set(normalized));
}

export function mapRuntimeEventToAssistantStatus(
  event: RuntimeEvent
): { status: "starting" | "running" | "completed" | "interrupted"; terminal: boolean } | null {
  if (event.type === "complete") {
    return {
      status: "completed",
      terminal: true
    };
  }

  if (event.type === "interrupted") {
    return {
      status: "interrupted",
      terminal: true
    };
  }

  if (event.type !== "status") {
    return null;
  }

  if (event.status === "starting" || event.status === "running") {
    return {
      status: event.status,
      terminal: false
    };
  }

  if (event.status === "completed" || event.status === "interrupted") {
    return {
      status: event.status,
      terminal: true
    };
  }

  return null;
}

function detectCommandReady(command: string): boolean {
  try {
    const checker = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(checker, [command], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

function detectAuthReady(id: AssistantProviderId): boolean {
  const home = homedir();
  if (id === "codex") {
    // codex 登录后凭证写在 ~/.codex/auth.json
    return existsSync(path.join(home, ".codex", "auth.json"));
  }
  // claude 登录态可能落在 keychain，文件不一定存在；~/.claude 存在即认为配置过。
  return existsSync(path.join(home, ".claude"));
}

// 解析 codex app-server 的 server request（JSON-RPC）成可读权限请求。
function parseCodexServerRequest(
  sessionId: string,
  request: Record<string, unknown>
): {
  kind: AssistantPermissionKind;
  title: string;
  summary: string;
  detail: string | null;
} {
  const method = typeof request.method === "string" ? request.method : "";
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : "";
    const reason = typeof params.reason === "string" ? params.reason : "";
    return {
      kind: "command",
      title: "Codex 请求执行命令",
      summary: command || "执行命令",
      detail: reason || null
    };
  }

  if (method === "item/fileChange/requestApproval") {
    const grantRoot = typeof params.grantRoot === "string" ? params.grantRoot : "";
    return {
      kind: "file_change",
      title: "Codex 请求改动文件",
      summary: grantRoot || "改动文件",
      detail: null
    };
  }

  const detail = safeStringify(params);
  return {
    kind: "other",
    title: `Codex 请求：${method || "未知操作"}`,
    summary: method || "未知操作",
    detail
  };
}

// 构造给 codex 的审批响应。command/file_change 都是 { decision }。
function buildCodexApprovalResult(
  _kind: AssistantPermissionKind,
  action: AssistantPermissionAction
): unknown {
  // codex 的 command/file_change 审批响应统一是 { decision }；other 兜底也用 decision。
  return { decision: action === "accept" ? "accept" : "decline" };
}

function safeStringify(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return "";
  }
}

const SESSION_TITLE_MAX_LENGTH = 72;

function buildSessionTitleFromContent(content: string, fallbackTitle: string): string {
  const title = normalizeSessionTitleSource(content);
  return title?.slice(0, SESSION_TITLE_MAX_LENGTH) || fallbackTitle;
}

function normalizeSessionTitleSource(content: string | null | undefined): string | null {
  const normalized = (typeof content === "string" ? content : "").trim().replace(/\s+/g, " ");
  if (normalized.length === 0) {
    return null;
  }
  return extractCodexSubagentTaskTitle(normalized) ?? normalized;
}

function extractCodexSubagentTaskTitle(title: string): string | null {
  const match = title.match(/^你是\s*Agent\s*[A-Za-z0-9_-]+\s*[,，。:：；;\s]*负责\s*(.+)$/i);
  const task = match?.[1]?.trim().replace(/^[：:，,。；;\s]+/, "").trim();
  return task || null;
}
