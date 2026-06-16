// 文档助手权限请求列表：展示 codex 的命令/文件改动审批请求，支持批准/拒绝。
import type { AssistantPermissionRequest } from "@x-file/shared";

import { t } from "../../../i18n";

interface AssistantPermissionListProps {
  requests: AssistantPermissionRequest[];
  onReply: (requestId: string, action: "accept" | "decline") => void;
}

export function AssistantPermissionList({
  requests,
  onReply
}: AssistantPermissionListProps) {
  const pending = requests.filter((item) => item.status === "pending");
  if (pending.length === 0) {
    return null;
  }

  return (
    <div className="assistant-permission-list">
      {pending.map((request) => (
        <div key={request.requestId} className="assistant-permission-card">
          <div className="assistant-permission-head">
            <span className="assistant-permission-title">{request.title}</span>
          </div>
          <div className="assistant-permission-summary">{request.summary}</div>
          {request.detail ? (
            <pre className="assistant-permission-detail">{request.detail}</pre>
          ) : null}
          <div className="button-row assistant-permission-actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => onReply(request.requestId, "accept")}
            >
              {t("assistantPermissionAccept")}
            </button>
            <button
              type="button"
              className="danger-button"
              onClick={() => onReply(request.requestId, "decline")}
            >
              {t("assistantPermissionDecline")}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
