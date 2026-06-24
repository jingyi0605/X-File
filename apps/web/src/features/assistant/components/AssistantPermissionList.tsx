// 文档助手权限请求列表：展示插件提交的结构化权限请求，支持批准/拒绝。
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
          <div className="assistant-permission-meta">
            {renderPermissionMetadata(request)}
          </div>
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

function renderPermissionMetadata(request: AssistantPermissionRequest) {
  const metadata = request.metadata;
  if (!metadata) {
    return null;
  }

  if (metadata.kind === "command") {
    return (
      <>
        <div>{t("assistantPermissionCommandLabel")}：<code>{metadata.command}</code></div>
        {metadata.reason ? <div>{t("assistantPermissionReasonLabel")}：{metadata.reason}</div> : null}
        {metadata.cwd ? <div>{t("assistantPermissionCwdLabel")}：<code>{metadata.cwd}</code></div> : null}
      </>
    );
  }

  if (metadata.kind === "file_change") {
    return (
      <>
        {metadata.primaryPath ? <div>{t("assistantPermissionTargetPathLabel")}：<code>{metadata.primaryPath}</code></div> : null}
        {metadata.changes.length > 0 ? (
          <div>
            <div>{t("assistantPermissionChangesLabel")}：</div>
            <ul className="assistant-permission-change-list">
              {metadata.changes.map((change, index) => (
                <li key={`${change.path}:${index}`}>
                  <span>{renderFileChangeActionLabel(change.action)}</span>
                  <code>{change.path}</code>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {metadata.diffSummary ? <pre className="assistant-permission-detail">{metadata.diffSummary}</pre> : null}
      </>
    );
  }

  return (
    <>
      {metadata.method ? <div>{t("assistantPermissionMethodLabel")}：<code>{metadata.method}</code></div> : null}
      {metadata.payloadText ? <pre className="assistant-permission-detail">{metadata.payloadText}</pre> : null}
    </>
  );
}

function renderFileChangeActionLabel(action: "add" | "update" | "delete" | "unknown") {
  if (action === "add") {
    return t("assistantPermissionChangeActionAdd");
  }
  if (action === "delete") {
    return t("assistantPermissionChangeActionDelete");
  }
  if (action === "update") {
    return t("assistantPermissionChangeActionUpdate");
  }
  return t("assistantPermissionChangeActionUnknown");
}
