// 文档助手会话列表：新建会话、切换历史会话、删除。展示在面板顶部。
import type { AssistantProviderId, AssistantSessionSummary } from "@x-file/shared";

import { t } from "../../../i18n";

interface AssistantSessionListProps {
  sessions: AssistantSessionSummary[];
  currentSessionId: string | null;
  provider: AssistantProviderId | null;
  onNew: () => void;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}

export function AssistantSessionList({
  sessions,
  currentSessionId,
  provider,
  onNew,
  onSelect,
  onDelete
}: AssistantSessionListProps) {
  return (
    <div className="assistant-session-bar">
      <button type="button" className="secondary-button assistant-new-session" onClick={onNew}>
        {t("assistantNewSession")}
      </button>
      {sessions.length > 0 ? (
        <select
          className="composer-deployment-select assistant-session-select"
          value={currentSessionId ?? ""}
          aria-label={t("assistantSessionSelect")}
          onChange={(event) => {
            const value = event.target.value;
            if (value) {
              onSelect(value);
            }
          }}
        >
          <option value="">{t("assistantSessionEmpty")}</option>
          {sessions.map((session) => (
            <option key={session.sessionId} value={session.sessionId}>
              {resolveSessionLabel(session, provider)}
            </option>
          ))}
        </select>
      ) : null}
      {currentSessionId ? (
        <button
          type="button"
          className="secondary-button assistant-delete-session"
          onClick={() => onDelete(currentSessionId)}
          title={t("assistantDeleteSession")}
        >
          {t("assistantDeleteSession")}
        </button>
      ) : null}
    </div>
  );
}

function resolveSessionLabel(
  session: AssistantSessionSummary,
  currentProvider: AssistantProviderId | null
): string {
  const providerLabel = session.provider === "claude-code" ? "Claude Code" : "Codex";
  const active = currentProvider && session.provider !== currentProvider ? ` [${providerLabel}]` : "";
  const title = session.title?.trim() || t("assistantSessionUntitled");
  return `${title} · ${session.messageCount} 条${active}`;
}
