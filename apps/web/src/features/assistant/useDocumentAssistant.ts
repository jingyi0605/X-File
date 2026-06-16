// 文档助手会话 hook：管理 provider、历史会话、消息流与当前文档上下文。
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AssistantAttachment,
  AssistantMessage,
  AssistantPermissionAction,
  AssistantPermissionRequest,
  AssistantProviderId,
  AssistantProviderInfo,
  AssistantSessionSummary
} from "@x-file/shared";

import {
  deleteAssistantSession,
  getAssistantSession,
  interruptAssistantSession,
  listAssistantProviders,
  listAssistantSessions,
  replyAssistantPermissionRequest,
  startAssistantSession,
  streamAssistantMessage,
  type AssistantStreamHandle
} from "./api/assistant";
import { resolveApiUrl } from "../../api/http";
import { t } from "../../i18n";

export interface DocumentAssistantContext {
  selectionLabel: string;
  selectionSummary: string;
  sourceRefs: string[];
  selectionKind: "empty" | "file" | "files" | "folder" | "folders" | "mixed";
}

export interface DocumentAssistantState {
  providers: AssistantProviderInfo[];
  provider: AssistantProviderId | null;
  messages: AssistantMessage[];
  permissionRequests: AssistantPermissionRequest[];
  sessions: AssistantSessionSummary[];
  currentSessionId: string | null;
  sending: boolean;
  activeRun: boolean;
  error: string | null;
  ready: boolean;
  init: () => Promise<void>;
  ensureSessionReady: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  newSession: (provider?: AssistantProviderId) => Promise<string | null>;
  loadSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  switchProvider: (provider: AssistantProviderId) => void;
  sendMessage: (input: {
    content: string;
    model?: string | null;
    reasoningLevel?: string | null;
    attachments?: Array<AssistantAttachment & { dataUrl: string }>;
  }) => Promise<void>;
  interrupt: () => Promise<void>;
  replyPermission: (requestId: string, action: AssistantPermissionAction) => Promise<void>;
}

export function useDocumentAssistant(context: DocumentAssistantContext | null = null): DocumentAssistantState {
  const [providers, setProviders] = useState<AssistantProviderInfo[]>([]);
  const [provider, setProvider] = useState<AssistantProviderId | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessage[]>([]);
  const [permissionRequests, setPermissionRequests] = useState<AssistantPermissionRequest[]>([]);
  const [sessions, setSessions] = useState<AssistantSessionSummary[]>([]);
  const [sending, setSending] = useState(false);
  const [activeRun, setActiveRun] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const initedRef = useRef(false);
  const streamRef = useRef<AssistantStreamHandle | null>(null);
  const providerRef = useRef<AssistantProviderId | null>(null);
  const sessionRef = useRef<string | null>(null);
  const sequenceRef = useRef(0);
  const contextRef = useRef<DocumentAssistantContext | null>(context);
  const ensureSessionTicketRef = useRef(0);

  providerRef.current = provider;
  sessionRef.current = sessionId;
  contextRef.current = context;

  const refreshSessions = useCallback(async () => {
    try {
      const list = await listAssistantSessions();
      setSessions(list);
    } catch {
      // 会话列表读取失败不阻塞主流程。
    }
  }, []);

  const mergeSessionSummary = useCallback((summary: AssistantSessionSummary) => {
    setSessions((current) => {
      const next = current.filter((item) => item.sessionId !== summary.sessionId);
      next.unshift(summary);
      next.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return next;
    });
  }, []);


  useEffect(() => {
    if (!sessionId || !activeRun || streamRef.current) {
      return;
    }

    let cancelled = false;
    const timer = window.setInterval(async () => {
      if (cancelled) {
        return;
      }
      try {
        const latest = await getAssistantSession(sessionId);
        if (cancelled) {
          return;
        }
        setMessages(latest.messages);
        setActiveRun(latest.session.hasActiveRun);
        setPermissionRequests(await listPendingPermissionRequests(sessionId));
      } catch {
        // 轮询兜底失败不打断当前界面。
      }
    }, 1200);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeRun, sessionId]);

  const init = useCallback(async () => {
    if (initedRef.current) {
      return;
    }
    initedRef.current = true;
    try {
      const list = await listAssistantProviders();
      setProviders(list);
      const firstAvailable = list.find((item) => item.available)?.id ?? null;
      if (firstAvailable) {
        setProvider(firstAvailable);
      }
      void refreshSessions();
    } catch (e) {
      setError(e instanceof Error ? e.message : "读取 provider 失败");
    } finally {
      setReady(true);
    }
  }, [refreshSessions]);

  const stopStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.abort();
      streamRef.current = null;
    }
  }, []);

  const resetRunState = useCallback(() => {
    stopStream();
    setMessages([]);
    setPermissionRequests([]);
    setSessionId(null);
    sessionRef.current = null;
    sequenceRef.current = 0;
    setActiveRun(false);
    setSending(false);
  }, [stopStream]);

  const newSession = useCallback(async (nextProvider?: AssistantProviderId) => {
    ensureSessionTicketRef.current += 1;
    stopStream();
    setMessages([]);
    setPermissionRequests([]);
    setSessionId(null);
    sessionRef.current = null;
    sequenceRef.current = 0;
    setActiveRun(false);
    setSending(false);
    const targetProvider = nextProvider ?? providerRef.current;
    if (targetProvider) {
      setProvider(targetProvider);
      providerRef.current = targetProvider;
    }
    if (!targetProvider) {
      return null;
    }
    try {
      const summary = await startAssistantSession({ provider: targetProvider });
      setSessionId(summary.sessionId);
      sessionRef.current = summary.sessionId;
      mergeSessionSummary(summary);
      return summary.sessionId;
    } catch (e) {
      setError(e instanceof Error ? e.message : "创建会话失败");
      return null;
    }
  }, [mergeSessionSummary, stopStream]);

  const loadSession = useCallback(async (targetSessionId: string) => {
    ensureSessionTicketRef.current += 1;
    stopStream();
    try {
      const detail = await getAssistantSession(targetSessionId);
      setSessionId(detail.session.sessionId);
      sessionRef.current = detail.session.sessionId;
      setProvider(detail.session.provider);
      providerRef.current = detail.session.provider;
      const maxSeq = detail.messages.reduce((acc, message) => Math.max(acc, message.sequence), 0);
      sequenceRef.current = maxSeq;
      setMessages(detail.messages);
      mergeSessionSummary(detail.session);
      setPermissionRequests(detail.session.hasActiveRun ? await listPendingPermissionRequests(detail.session.sessionId) : []);
      setActiveRun(detail.session.hasActiveRun);
      setSending(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "载入会话失败");
    }
  }, [mergeSessionSummary, stopStream]);

  const ensureSessionReady = useCallback(async () => {
    if (sessionRef.current) {
      return;
    }
    const ticket = ensureSessionTicketRef.current + 1;
    ensureSessionTicketRef.current = ticket;
    try {
      const list = await listAssistantSessions();
      if (ensureSessionTicketRef.current !== ticket || sessionRef.current) {
        return;
      }
      setSessions(list);
      const latest = list[0];
      if (latest) {
        await loadSession(latest.sessionId);
      }
    } catch {
      // 空态下保持无会话，交给 UI 引导用户新建。
    }
  }, [loadSession]);

  const deleteSession = useCallback(
    async (targetSessionId: string) => {
      try {
        await deleteAssistantSession(targetSessionId);
        if (sessionRef.current === targetSessionId) {
          resetRunState();
        }
        await refreshSessions();
      } catch (e) {
        setError(e instanceof Error ? e.message : "删除会话失败");
      }
    },
    [refreshSessions, resetRunState]
  );

  const switchProvider = useCallback(
    (next: AssistantProviderId) => {
      setProvider((current) => {
        if (current === next) {
          return current;
        }
        resetRunState();
        return next;
      });
    },
    [resetRunState]
  );

  const sendMessage = useCallback(
    async (input: {
      content: string;
      model?: string | null;
      reasoningLevel?: string | null;
      attachments?: Array<AssistantAttachment & { dataUrl: string }>;
    }) => {
      const trimmed = input.content.trim();
      if (!trimmed) {
        return;
      }
      const currentProvider = providerRef.current;
      if (!currentProvider) {
        setError("请先选择 provider");
        return;
      }
      setError(null);
      setSending(true);

      let targetSession = sessionRef.current;
      if (!targetSession) {
        try {
          const summary = await startAssistantSession({ provider: currentProvider });
          targetSession = summary.sessionId;
          ensureSessionTicketRef.current += 1;
          sessionRef.current = targetSession;
          setSessionId(targetSession);
          mergeSessionSummary(summary);
          setMessages([]);
          setPermissionRequests([]);
          sequenceRef.current = 0;
          await loadSession(targetSession);
          targetSession = sessionRef.current ?? targetSession;
        } catch (e) {
          setSending(false);
          setError(e instanceof Error ? e.message : "创建会话失败");
          return;
        }
      }

      setActiveRun(true);

      streamRef.current = streamAssistantMessage(
        targetSession,
        {
          content: `${buildDocumentAssistantPrefix(contextRef.current)}${trimmed}`,
          model: input.model ?? null,
          reasoningLevel: input.reasoningLevel ?? null,
          attachments: input.attachments ?? []
        },
        {
          onEvent: (event) => {
            if (event.kind === "message") {
              setMessages((prev) => {
                const exists = prev.some((message) => message.messageId === event.message.messageId);
                if (exists) {
                  return prev.map((message) =>
                    message.messageId === event.message.messageId ? event.message : message
                  );
                }
                const next = [...prev, event.message];
                next.sort((left, right) => left.sequence - right.sequence);
                return next;
              });
              setSessions((current) =>
                current.map((session) =>
                  session.sessionId === targetSession
                    ? {
                        ...session,
                        provider: currentProvider,
                        messageCount: Math.max(session.messageCount, event.message.sequence),
                        hasActiveRun: true
                      }
                    : session
                )
              );
            } else if (event.kind === "status") {
              setActiveRun(event.status === "starting" || event.status === "running");
              setSessions((current) =>
                current.map((session) =>
                  session.sessionId === targetSession
                    ? {
                        ...session,
                        hasActiveRun: event.status === "starting" || event.status === "running"
                      }
                    : session
                )
              );
            } else if (event.kind === "error") {
              setError(event.detail);
              setActiveRun(false);
            } else if (event.kind === "permission_request") {
              setPermissionRequests((prev) => {
                const exists = prev.some((request) => request.requestId === event.request.requestId);
                return exists ? prev : [...prev, event.request];
              });
            }
          },
          onError: (e) => {
            setError(e.message);
            setSending(false);
            setActiveRun(false);
            streamRef.current = null;
            void refreshSessions();
          },
          onClose: () => {
            setSending(false);
            setActiveRun(false);
            streamRef.current = null;
            void refreshSessions();
          }
        }
      );
    },
    [mergeSessionSummary, refreshSessions]
  );

  const interrupt = useCallback(async () => {
    if (!sessionRef.current) {
      return;
    }
    try {
      await interruptAssistantSession(sessionRef.current);
    } catch (e) {
      setError(e instanceof Error ? e.message : "中断失败");
    } finally {
      setActiveRun(false);
      setSending(false);
    }
  }, []);

  const replyPermission = useCallback(
    async (requestId: string, action: AssistantPermissionAction) => {
      const targetSession = sessionRef.current;
      if (!targetSession) {
        return;
      }
      setPermissionRequests((prev) =>
        prev.map((request) =>
          request.requestId === requestId
            ? { ...request, status: action === "accept" ? "approved" : "rejected" }
            : request
        )
      );
      try {
        await replyAssistantPermissionRequest(targetSession, requestId, action);
      } catch (e) {
        setError(e instanceof Error ? e.message : "权限回复失败");
      }
    },
    []
  );

  useEffect(() => {
    return () => {
      stopStream();
    };
  }, [stopStream]);

  return {
    providers,
    provider,
    messages,
    permissionRequests,
    sessions,
    currentSessionId: sessionId,
    sending,
    activeRun,
    error,
    ready,
    init,
    ensureSessionReady,
    refreshSessions,
    newSession,
    loadSession,
    deleteSession,
    switchProvider,
    sendMessage,
    interrupt,
    replyPermission
  };
}

export function formatAssistantSessionMeta(session: AssistantSessionSummary): string {
  const date = new Date(session.createdAt);
  const dateLabel = Number.isNaN(date.getTime())
    ? session.createdAt
    : `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2, "0")}:${String(
        date.getMinutes()
      ).padStart(2, "0")}`;
  const runLabel = session.hasActiveRun ? "运行中" : "已停止";
  return `${dateLabel} · ${session.messageCount} 条 · ${runLabel}`;
}

export function getAssistantProviderBadgeLabel(provider: AssistantProviderId | null | undefined): string {
  if (provider === "claude-code") {
    return "Claude Code";
  }
  return "Codex";
}

function buildDocumentAssistantPrefix(context: DocumentAssistantContext | null): string {
  if (!context) {
    return `${t("assistantPromptPreambleEmpty")}\n\n`;
  }

  return `${t("assistantPromptPreamble", {
    title: context.selectionLabel,
    summary: context.selectionSummary,
    sourceRef: context.sourceRefs.join("\n")
  })}\n\n`;
}

async function listPendingPermissionRequests(sessionId: string): Promise<AssistantPermissionRequest[]> {
  try {
    const response = await fetch(resolveApiUrl(`/api/assistant/sessions/${encodeURIComponent(sessionId)}/permission-requests`));
    if (!response.ok) {
      return [];
    }
    const payload = await response.json() as { requests?: AssistantPermissionRequest[] };
    return (payload.requests ?? []).filter((item) => item.status === "pending");
  } catch {
    return [];
  }
}
