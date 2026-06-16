// 文档助手会话存储：内存 Map + JSON 文件持久化。
// 每个会话一个 <dataDir>/assistant-sessions/<sessionId>.json，重启后可恢复历史列表与消息。
import { promises as fsPromises, existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  AssistantMessage,
  AssistantPermissionRequest,
  AssistantProviderId,
  AssistantSessionSummary
} from "./assistant-types.js";

export interface AssistantSessionRecord {
  sessionId: string;
  title: string;
  provider: AssistantProviderId;
  providerSessionId: string | null;
  rawStoreRef: string | null;
  workspacePath: string;
  runtimeHomeDir: string;
  createdAt: string;
  messages: AssistantMessage[];
  hasActiveRun: boolean;
  permissionRequests: AssistantPermissionRequest[];
}

export interface CreateAssistantSessionInput {
  sessionId: string;
  provider: AssistantProviderId;
  workspacePath: string;
  runtimeHomeDir: string;
  providerSessionId?: string | null;
}

// 落盘结构（去掉 hasActiveRun 这种瞬时状态）。
interface PersistedSession {
  sessionId: string;
  title: string;
  provider: AssistantProviderId;
  providerSessionId: string | null;
  rawStoreRef: string | null;
  workspacePath: string;
  runtimeHomeDir: string;
  createdAt: string;
  messages: AssistantMessage[];
  permissionRequests: AssistantPermissionRequest[];
}

export class AssistantSessionStore {
  private readonly sessions = new Map<string, AssistantSessionRecord>();
  private readonly sessionsDir: string;

  constructor(dataDir?: string) {
    this.sessionsDir = path.join(resolveDataDir(dataDir), "assistant-sessions");
  }

  create(input: CreateAssistantSessionInput): AssistantSessionRecord {
    const record: AssistantSessionRecord = {
      sessionId: input.sessionId,
      title: "新对话",
      provider: input.provider,
      providerSessionId: input.providerSessionId ?? null,
      rawStoreRef: null,
      workspacePath: input.workspacePath,
      runtimeHomeDir: input.runtimeHomeDir,
      createdAt: new Date().toISOString(),
      messages: [],
      hasActiveRun: false,
      permissionRequests: []
    };
    this.sessions.set(input.sessionId, record);
    void this.persist(record);
    return record;
  }

  get(sessionId: string): AssistantSessionRecord | null {
    return this.ensureLoaded(sessionId);
  }

  // 载入会话（内存优先，否则从磁盘恢复）。用于切换/恢复历史会话。
  loadRecord(sessionId: string): AssistantSessionRecord | null {
    return this.ensureLoaded(sessionId);
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId) || existsSync(this.sessionFilePath(sessionId));
  }

  appendMessage(sessionId: string, message: AssistantMessage): void {
    const record = this.ensureLoaded(sessionId);
    if (!record) {
      return;
    }
    const exists = record.messages.some((item) => item.messageId === message.messageId);
    if (exists) {
      record.messages = record.messages.map((item) =>
        item.messageId === message.messageId ? message : item
      );
    } else {
      record.messages.push(message);
      record.messages.sort((a, b) => a.sequence - b.sequence);
    }
    void this.persist(record);
  }

  updateTitle(sessionId: string, title: string): void {
    const record = this.ensureLoaded(sessionId);
    if (!record) {
      return;
    }
    const normalized = title.trim();
    if (!normalized || record.title === normalized) {
      return;
    }
    record.title = normalized;
    void this.persist(record);
  }

  updateBinding(
    sessionId: string,
    providerSessionId: string | null,
    rawStoreRef: string | null
  ): void {
    const record = this.ensureLoaded(sessionId);
    if (!record) {
      return;
    }
    if (providerSessionId) {
      record.providerSessionId = providerSessionId;
    }
    if (rawStoreRef) {
      record.rawStoreRef = rawStoreRef;
    }
    void this.persist(record);
  }

  setActiveRun(sessionId: string, active: boolean): void {
    const record = this.ensureLoaded(sessionId);
    if (!record) {
      return;
    }
    record.hasActiveRun = active;
  }

  getMessages(sessionId: string): AssistantMessage[] {
    const record = this.ensureLoaded(sessionId);
    return record ? [...record.messages] : [];
  }

  addPermissionRequest(sessionId: string, request: AssistantPermissionRequest): void {
    const record = this.ensureLoaded(sessionId);
    if (!record) {
      return;
    }
    record.permissionRequests.push(request);
    void this.persist(record);
  }

  resolvePermissionRequest(
    requestId: string,
    status: "approved" | "rejected"
  ): AssistantPermissionRequest | null {
    for (const record of this.sessions.values()) {
      const index = record.permissionRequests.findIndex((item) => item.requestId === requestId);
      if (index >= 0) {
        record.permissionRequests[index] = { ...record.permissionRequests[index], status };
        void this.persist(record);
        return record.permissionRequests[index];
      }
    }
    return null;
  }

  getPermissionRequests(sessionId: string): AssistantPermissionRequest[] {
    const record = this.ensureLoaded(sessionId);
    return record ? [...record.permissionRequests] : [];
  }

  delete(sessionId: string): boolean {
    const existed = this.has(sessionId);
    this.sessions.delete(sessionId);
    void fsPromises.rm(this.sessionFilePath(sessionId), { force: true });
    void fsPromises.rm(this.getAttachmentDirectory(sessionId), { recursive: true, force: true });
    return existed;
  }

  nextSequence(sessionId: string): number {
    const record = this.ensureLoaded(sessionId);
    const maxSequence = record?.messages.reduce((acc, message) => Math.max(acc, message.sequence), 0) ?? 0;
    return maxSequence + 1;
  }

  getAttachmentDirectory(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}-attachments`);
  }

  // 列出所有会话摘要：内存 + 磁盘合并，按创建时间倒序。
  listSummaries(): AssistantSessionSummary[] {
    const seen = new Set<string>();
    const summaries: AssistantSessionSummary[] = [];

    for (const record of this.sessions.values()) {
      seen.add(record.sessionId);
      summaries.push(this.toSummary(record));
    }

    for (const disk of this.readAllRecordsFromDisk()) {
      if (!seen.has(disk.sessionId)) {
        seen.add(disk.sessionId);
        summaries.push(this.toSummary(disk));
      }
    }

    return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  toSummary(record: AssistantSessionRecord): AssistantSessionSummary {
    return {
      sessionId: record.sessionId,
      title: record.title,
      provider: record.provider,
      providerSessionId: record.providerSessionId,
      workspacePath: record.workspacePath,
      createdAt: record.createdAt,
      hasActiveRun: record.hasActiveRun,
      messageCount: record.messages.length
    };
  }

  private sessionFilePath(sessionId: string): string {
    return path.join(this.sessionsDir, `${sessionId}.json`);
  }

  private ensureLoaded(sessionId: string): AssistantSessionRecord | null {
    const memory = this.sessions.get(sessionId);
    if (memory) {
      return memory;
    }
    const disk = this.readRecordFromDisk(sessionId);
    if (disk) {
      this.sessions.set(sessionId, disk);
      return disk;
    }
    return null;
  }

  private persist(record: AssistantSessionRecord): void {
    const data: PersistedSession = {
      sessionId: record.sessionId,
      title: record.title,
      provider: record.provider,
      providerSessionId: record.providerSessionId,
      rawStoreRef: record.rawStoreRef,
      workspacePath: record.workspacePath,
      runtimeHomeDir: record.runtimeHomeDir,
      createdAt: record.createdAt,
      messages: record.messages,
      permissionRequests: record.permissionRequests
    };
    void fsPromises
      .mkdir(this.sessionsDir, { recursive: true })
      .then(() =>
        fsPromises.writeFile(this.sessionFilePath(record.sessionId), JSON.stringify(data, null, 2))
      )
      .catch(() => {
        // 持久化失败不阻塞会话主流程。
      });
  }

  private readRecordFromDisk(sessionId: string): AssistantSessionRecord | null {
    return this.parseRecordFile(this.sessionFilePath(sessionId));
  }

  private readAllRecordsFromDisk(): AssistantSessionRecord[] {
    if (!existsSync(this.sessionsDir)) {
      return [];
    }
    const records: AssistantSessionRecord[] = [];
    for (const file of readdirSync(this.sessionsDir)) {
      if (!file.endsWith(".json")) {
        continue;
      }
      const record = this.parseRecordFile(path.join(this.sessionsDir, file));
      if (record) {
        records.push(record);
      }
    }
    return records;
  }

  private parseRecordFile(filePath: string): AssistantSessionRecord | null {
    try {
      const raw = readFileSync(filePath, "utf8");
      const data = JSON.parse(raw) as PersistedSession;
      const normalizedMessages = Array.isArray(data.messages) ? data.messages : [];
      const title = resolvePersistedSessionTitle(
        typeof data.title === "string" ? data.title : "",
        normalizedMessages
      );
      return {
        sessionId: data.sessionId,
        title,
        provider: data.provider,
        providerSessionId: data.providerSessionId,
        rawStoreRef: data.rawStoreRef,
        workspacePath: data.workspacePath,
        runtimeHomeDir: data.runtimeHomeDir,
        createdAt: data.createdAt,
        messages: normalizedMessages,
        // 重启后没有活跃运行。
        hasActiveRun: false,
        permissionRequests: data.permissionRequests
      };
    } catch {
      return null;
    }
  }
}

function resolveDataDir(explicitDataDir: string | undefined): string {
  if (explicitDataDir?.trim()) {
    return path.resolve(explicitDataDir);
  }
  if (process.env.X_FILE_DATA_DIR?.trim()) {
    return path.resolve(process.env.X_FILE_DATA_DIR);
  }
  return path.join(os.homedir(), ".x-file");
}

function resolvePersistedSessionTitle(title: string, messages: AssistantMessage[]): string {
  const normalized = title.trim();
  if (normalized && normalized !== "新对话") {
    return normalized;
  }

  const firstUserMessage = messages.find((message) => message.role === "user");
  const derived = buildSessionTitleFromContent(firstUserMessage?.content ?? "", "新对话");
  return derived || "新对话";
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
