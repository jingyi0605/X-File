// 文档助手运行时服务：把文档库根目录作为插件 provider 的工作区，
// 主 APP 只维护会话表、SSE 和权限桥。真正的 provider runtime 固定由 external sidecar/runtime bridge 提供。
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fsPromises, readdirSync } from "node:fs";

import {
  ProviderRuntimeService,
  type NormalizedMessage,
  type NormalizedMessageAttachment,
  type ProviderRuntimeAdapter,
  type ProviderRuntimeRunRequest,
  type ProviderSubscription,
  type RuntimeAttachment,
  type RuntimeEvent
} from "@codingns/session-sync-core";
import type {
  AssistantPluginPermissionRequest,
  AssistantPluginRuntimeCapability,
  AssistantPluginRuntimeModule
} from "@x-file/shared";

import type { LibraryBindingStore } from "../storage/library-binding-store.js";
import type { PluginService } from "../plugins/plugin-service.js";
import { AssistantError } from "./assistant-errors.js";
import { AssistantSessionStore, type AssistantSessionRecord } from "./assistant-session-store.js";
import {
  isAssistantProviderId,
  type AssistantEventSink,
  type AssistantMessage,
  type AssistantPermissionAction,
  type AssistantPermissionRequest,
  type AssistantProviderId,
  type AssistantProviderInfo,
  type AssistantSessionSummary,
  type SendAssistantMessageInput,
  type StartAssistantSessionInput
} from "./assistant-types.js";

const X_FILE_WORKSPACE_ID = "x-file-library";
const DEFAULT_PERMISSION_MODE = "acceptEdits";

interface AssistantProviderRuntimeHost {
  runtime: ProviderRuntimeService;
  capabilities: ReturnType<typeof normalizePluginCapabilities>;
  runtimeHomeDir: string;
}

export class AssistantRuntimeService {
  private runtimeBySession = new Map<string, ProviderRuntimeService>();
  private readonly providerCapabilities = new Map<AssistantProviderId, {
    supportsAttachments: boolean;
    modelOptions: Array<{
      id: string;
      name: string;
      usesProviderDefault?: boolean;
      supportedReasoningEfforts?: string[];
    }>;
    defaultReasoningLevel: string | null;
    supportedReasoningLevels: string[];
  }>();
  private readonly subscriptionsBySession = new Map<string, ProviderSubscription>();
  // 当前活跃 SSE 连接的 sink，用于把插件权限请求实时推给前端。
  private readonly sessionSinks = new Map<string, AssistantEventSink>();
  // 权限请求的 deferred，前端回复时 resolve，让宿主只回插件定义的 provider-specific 结果。
  private readonly permissionDeferreds = new Map<
    string,
    { resolve: (value: unknown) => void; responseBuilder: (action: AssistantPermissionAction) => unknown | Promise<unknown>; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly bindingStore: LibraryBindingStore,
    private readonly pluginService: PluginService,
    private readonly store = new AssistantSessionStore()
  ) {}

  async listProviders(): Promise<AssistantProviderInfo[]> {
    const entries = await Promise.all(
      this.pluginService.listEnabledAssistantProviders().map(async (item) => {
        const resolvedCapabilities = await this.resolveProviderCapabilities(item.providerId);
        return {
          item,
          capabilities: resolvedCapabilities,
        };
      })
    );
    return entries.map(({ item, capabilities }) => {
      return {
        id: item.providerId,
        label: item.manifest.provider?.displayName ?? item.manifest.name,
        commandReady: item.health.commandReady ?? false,
        authReady: item.health.authReady ?? false,
        available: item.health.commandReady === true && item.health.authReady === true,
        detail: item.health.detail ?? null,
        supportsAttachments: capabilities?.supportsAttachments ?? false,
        modelOptions: capabilities?.modelOptions ?? [],
        defaultReasoningLevel: normalizeAssistantReasoningLevel(capabilities?.defaultReasoningLevel ?? null),
        supportedReasoningLevels: normalizeAssistantReasoningLevels(capabilities?.supportedReasoningLevels ?? []),
      };
    });
  }

  resolveWorkspacePath(): string {
    const binding = this.bindingStore.read();
    if (!binding || !binding.rootDir?.trim()) {
      throw new AssistantError(400, "LIBRARY_NOT_BOUND", "请先绑定文档库根目录");
    }
    // 优先用镜像根目录（如果配置了），否则用原始根目录，作为 agent 的 cwd。
    return binding.mirrorRoot?.trim() || binding.rootDir.trim();
  }

  async startSession(input: StartAssistantSessionInput): Promise<AssistantSessionSummary> {
    if (!isAssistantProviderId(input.provider)) {
      throw new AssistantError(
        400,
        "ASSISTANT_PROVIDER_NOT_SUPPORTED",
        `不支持的 provider: ${String(input.provider)}`
      );
    }
    const status = (await this.listProviders()).find((item) => item.id === input.provider);
    if (!status || !status.commandReady || !status.authReady) {
      throw new AssistantError(
        503,
        "ASSISTANT_PROVIDER_UNAVAILABLE",
        status?.detail ?? `${input.provider} 运行时不可用`
      );
    }

    const workspacePath = this.resolveWorkspacePath();
    const sessionId = randomUUID();
    const record = this.store.create({
      sessionId,
      provider: input.provider,
      workspacePath,
      runtimeHomeDir: await this.resolveRuntimeHomeDir(input.provider),
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
    const runtime = await this.resolveRuntimeForSession(session);
    const subscription = runtime.subscribe(sessionId, (event) => {
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
        ? await runtime.continueSession(request)
        : await runtime.startSession(request);
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
    this.mirrorRuntimeBindingToSessionStore(sessionId, event.providerSessionId, event.rawStoreRef);

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

  private mirrorRuntimeBindingToSessionStore(
    sessionId: string,
    providerSessionId: string | null,
    rawStoreRef: string | null
  ): void {
    if (!providerSessionId && !rawStoreRef) {
      return;
    }
    this.store.updateBinding(sessionId, providerSessionId, rawStoreRef);
  }

  private finishRun(sessionId: string, subscription: ProviderSubscription): void {
    this.store.setActiveRun(sessionId, false);
    this.sessionSinks.delete(sessionId);
    subscription.close();
    if (this.subscriptionsBySession.get(sessionId) === subscription) {
      this.subscriptionsBySession.delete(sessionId);
    }
  }

  // 插件 runtime 请求审批时回调：宿主只存储、推给前端并等待回复，不再解析 provider-specific 协议。
  private async handlePluginPermissionRequest(input: {
    sessionId: string;
    request: AssistantPluginPermissionRequest;
    responseBuilder: (action: AssistantPermissionAction) => unknown | Promise<unknown>;
  }): Promise<unknown> {
    const request: AssistantPermissionRequest = {
      requestId: randomUUID(),
      sessionId: input.sessionId,
      kind: input.request.kind,
      title: input.request.title,
      summary: input.request.summary,
      detail: input.request.detail,
      metadata: buildAssistantPermissionMetadata(input.request),
      status: "pending",
      createdAt: new Date().toISOString()
    };
    this.store.addPermissionRequest(input.sessionId, request);

    return new Promise<unknown>((resolve) => {
      // 5 分钟无人回复则自动批准，避免 provider runtime 永久阻塞。
      const timer = setTimeout(() => {
        if (this.permissionDeferreds.has(request.requestId)) {
          this.permissionDeferreds.delete(request.requestId);
          this.store.resolvePermissionRequest(request.requestId, "approved");
          void Promise.resolve(input.responseBuilder("accept")).then(resolve);
        }
      }, 300000);
      this.permissionDeferreds.set(request.requestId, {
        resolve,
        responseBuilder: input.responseBuilder,
        timer
      });
      const sink = this.sessionSinks.get(input.sessionId);
      sink?.({ kind: "permission_request", request });
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
    void Promise.resolve(deferred.responseBuilder(action)).then(deferred.resolve);
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
      const runtime = this.runtimeBySession.get(sessionId);
      if (!runtime) {
        return;
      }
      await runtime.interrupt(sessionId);
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

  async dispose(): Promise<void> {
    for (const deferred of this.permissionDeferreds.values()) {
      clearTimeout(deferred.timer);
    }
    this.permissionDeferreds.clear();
    this.sessionSinks.clear();
    this.subscriptionsBySession.clear();
    const runtimes = [...new Set(this.runtimeBySession.values())];
    this.runtimeBySession.clear();
    this.providerCapabilities.clear();
    for (const runtime of runtimes) {
      await runtime.dispose();
    }
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

  private async resolveRuntimeForSession(session: AssistantSessionRecord): Promise<ProviderRuntimeService> {
    const cached = this.runtimeBySession.get(session.sessionId);
    if (cached) {
      return cached;
    }

    const plugin = await this.pluginService.getEnabledAssistantRuntimePlugin(session.provider);
    if (!plugin) {
      throw new AssistantError(
        503,
        "ASSISTANT_PROVIDER_UNAVAILABLE",
        `${session.provider} 插件未安装或未启用`
      );
    }

    const host = await this.buildRuntimeHost(session, plugin.runtimeModule);
    const runtime = host.runtime;
    this.runtimeBySession.set(session.sessionId, runtime);
    this.providerCapabilities.set(session.provider, host.capabilities);
    return runtime;
  }

  private async resolveRuntimeHomeDir(provider: AssistantProviderId): Promise<string> {
    const plugin = await this.pluginService.getEnabledAssistantRuntimePlugin(provider);
    if (plugin?.runtimeModule.provider.runtimeHomeDir?.trim()) {
      return plugin.runtimeModule.provider.runtimeHomeDir.trim();
    }
    return provider === "claude-code"
      ? path.join(homedir(), ".claude")
      : path.join(homedir(), ".codex");
  }

  private async resolveProviderCapabilities(provider: AssistantProviderId) {
    const cached = this.providerCapabilities.get(provider);
    if (cached) {
      return cached;
    }
    const plugin = await this.pluginService.getEnabledAssistantRuntimePlugin(provider);
    if (!plugin) {
      return null;
    }
    const normalized = normalizePluginCapabilities(plugin.runtimeModule.capabilities);
    this.providerCapabilities.set(provider, normalized);
    return normalized;
  }

  private async buildRuntimeHost(
    session: AssistantSessionRecord | null,
    runtimeModule: AssistantPluginRuntimeModule
  ): Promise<AssistantProviderRuntimeHost> {
    const runtimeAdapter = await runtimeModule.createRuntimeAdapter({
      permissionBridge: {
        requestPermission: async (input) => this.handlePluginPermissionRequest({
          sessionId: session?.sessionId ?? input.sessionId,
          request: input.request,
          responseBuilder: (action) => {
            if (typeof runtimeModule.buildPermissionResponse === "function") {
              return runtimeModule.buildPermissionResponse({
                action,
                request: input.request
              });
            }
            return { decision: action === "accept" ? "accept" : "decline" };
          }
        })
      },
      session: {
        sessionId: session?.sessionId ?? "assistant-provider-probe",
        workspaceId: X_FILE_WORKSPACE_ID,
        workspacePath: session?.workspacePath ?? this.resolveWorkspacePath()
      }
    }) as ProviderRuntimeAdapter;

    return {
      runtime: new ProviderRuntimeService([runtimeAdapter]),
      capabilities: normalizePluginCapabilities(runtimeModule.capabilities),
      runtimeHomeDir: runtimeModule.provider.runtimeHomeDir
    };
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

function normalizePluginCapabilities(capabilities: AssistantPluginRuntimeCapability) {
  return {
    supportsAttachments: capabilities.supportsAttachments,
    modelOptions: capabilities.modelOptions ?? [],
    defaultReasoningLevel: capabilities.defaultReasoningLevel ?? null,
    supportedReasoningLevels: capabilities.supportedReasoningLevels ?? []
  };
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

function buildAssistantPermissionMetadata(input: AssistantPluginPermissionRequest): AssistantPermissionRequest["metadata"] {
  if (input.kind === "command") {
    const payload = input.payload ?? null;
    return {
      kind: "command",
      command: typeof payload?.command === "string" ? payload.command : input.summary,
      reason: typeof payload?.reason === "string" ? payload.reason : input.detail,
      cwd: typeof payload?.cwd === "string" ? payload.cwd : null
    };
  }

  if (input.kind === "file_change") {
    const payload = input.payload ?? null;
    const rawChanges = Array.isArray(payload?.changes) ? payload.changes : [];
    const changes = rawChanges.flatMap((change: (typeof rawChanges)[number]) => {
      if (!change || typeof change !== "object") {
        return [];
      }
      const record = change as Record<string, unknown>;
      const path = typeof record.path === "string" ? record.path.trim() : "";
      if (!path) {
        return [];
      }
      const rawKind = typeof record.kind === "string"
        ? record.kind.trim().toLowerCase()
        : typeof record.action === "string"
          ? record.action.trim().toLowerCase()
          : "";
      return [{
        path,
        action: normalizeFileChangeAction(rawKind)
      }];
    });
    const diffSummary = rawChanges
      .map((change: (typeof rawChanges)[number]) => {
        if (!change || typeof change !== "object") {
          return "";
        }
        const record = change as Record<string, unknown>;
        const diff = typeof record.diff === "string" ? record.diff : record.patch;
        return typeof diff === "string" ? diff.trim() : "";
      })
      .find(Boolean) || null;

    return {
      kind: "file_change",
      primaryPath: typeof payload?.primaryPath === "string"
        ? payload.primaryPath
        : typeof payload?.grantRoot === "string"
          ? payload.grantRoot
          : changes[0]?.path ?? input.summary,
      changes,
      diffSummary
    };
  }

  const payload = input.payload ?? null;
  return {
    kind: "other",
    method: typeof payload?.method === "string" ? payload.method : null,
    payloadText: input.detail ?? null
  };
}

function normalizeFileChangeAction(rawKind: string): "add" | "update" | "delete" | "unknown" {
  if (rawKind === "add" || rawKind === "create") {
    return "add";
  }
  if (rawKind === "delete" || rawKind === "remove") {
    return "delete";
  }
  if (rawKind === "update" || rawKind === "modify" || rawKind === "edit") {
    return "update";
  }
  return "unknown";
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
