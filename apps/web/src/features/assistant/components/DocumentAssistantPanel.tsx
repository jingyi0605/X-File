// 文件助手面板：直接复用事务助手骨架，文件页只做数据适配。
import { t } from "../../../i18n";
import { getPathName } from "../../../shared/format";
import { ModalEmptyState } from "../../../shared/modal";
import type { LibraryState } from "../../library/useLibraryState";
import type { DocumentAssistantState } from "../useDocumentAssistant";
import { AssistantComposer } from "./AssistantComposer";
import { AssistantMessageTimeline } from "./AssistantMessageTimeline";
import { AssistantPermissionList } from "./AssistantPermissionList";

type AssistantSelectionBridge = Pick<
  LibraryState,
  "selectedDocuments" | "selectedFolderEntries"
>;

interface DocumentAssistantPanelProps {
  library: AssistantSelectionBridge;
  assistant: DocumentAssistantState;
}

export function DocumentAssistantPanel({ library, assistant }: DocumentAssistantPanelProps) {
  const selectedDocuments = library.selectedDocuments;
  const selectedFolders = library.selectedFolderEntries;
  const contextTargets = buildAssistantContextTargets(selectedDocuments, selectedFolders);

  return (
    <section className="affairs-assistant-panel">
      <div className="affairs-assistant-scroll-shell">
        {contextTargets.length > 0 ? (
          <section className="workbench-section-block affairs-detail-block affairs-assistant-context-block">
            {contextTargets.length === 1 ? (
              <div
                className="affairs-assistant-context-card compact"
                data-object-type={contextTargets[0]?.kind}
              >
                <div
                  className="affairs-assistant-context-icon"
                  data-tone={contextTargets[0]?.kind === "folder" ? "amber" : "indigo"}
                  aria-hidden="true"
                >
                  {contextTargets[0]?.kind === "folder" ? <FolderContextIcon /> : <span>FILE</span>}
                </div>
                <div className="affairs-assistant-context-copy">
                  <h3 title={contextTargets[0]?.path}>{contextTargets[0]?.path}</h3>
                </div>
              </div>
            ) : (
              <div className="affairs-assistant-context-stack" role="list" aria-label={t("assistantContextDocument")}>
                {contextTargets.map((target) => (
                  <div
                    key={`${target.kind}:${target.path}`}
                    className="affairs-assistant-context-chip"
                    data-object-type={target.kind}
                    role="listitem"
                    title={target.path}
                  >
                    <span
                      className="affairs-assistant-context-chip-icon"
                      data-tone={target.kind === "folder" ? "amber" : "indigo"}
                      aria-hidden="true"
                    >
                      {target.kind === "folder" ? <FolderContextIcon compact /> : <span>FILE</span>}
                    </span>
                    <span className="affairs-assistant-context-chip-label">{target.label}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        ) : null}
        <div className="affairs-assistant-main">
          {assistant.error ? (
            <div className="assistant-error-banner" role="alert">
              {assistant.error}
            </div>
          ) : null}
          {!assistant.ready ? (
            <div className="assistant-timeline-empty">
              <p>{t("assistantLoading")}</p>
            </div>
          ) : assistant.sessions.length === 0 && !assistant.currentSessionId ? (
            <div className="assistant-timeline-empty affairs-assistant-empty-state">
              <ModalEmptyState
                compact
                title={t("assistantNoSessionTitle")}
                description={t("assistantNoSessionDescription")}
              />
            </div>
          ) : (
            <>
              <AssistantPermissionList requests={assistant.permissionRequests} onReply={assistant.replyPermission} />
              <div className="affairs-assistant-timeline">
                <AssistantMessageTimeline
                  messages={assistant.messages}
                  loading={assistant.activeRun}
                  showEmptyHint={false}
                />
              </div>
            </>
          )}
        </div>
      </div>
      <div className="affairs-assistant-composer">
        <AssistantComposer
          providers={assistant.providers}
          provider={assistant.provider}
          sending={assistant.sending}
          activeRun={assistant.activeRun}
          onSend={assistant.sendMessage}
          onInterrupt={assistant.interrupt}
        />
      </div>
    </section>
  );
}

function buildAssistantContextTargets(
  selectedDocuments: AssistantSelectionBridge["selectedDocuments"],
  selectedFolders: AssistantSelectionBridge["selectedFolderEntries"]
): Array<{ kind: "file" | "folder"; path: string; label: string }> {
  return [
    ...selectedDocuments.map((item) => ({
      kind: "file" as const,
      path: item.path,
      label: getPathName(item.path) || item.title || item.path,
    })),
    ...selectedFolders.map((item) => ({
      kind: "folder" as const,
      path: item.path,
      label: getPathName(item.path) || item.name || item.path,
    })),
  ];
}

function FolderContextIcon({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={compact ? "affairs-assistant-context-folder-icon compact" : "affairs-assistant-context-folder-icon"}
    >
      <path
        d="M3.5 7.5a2 2 0 0 1 2-2h4l1.7 1.8h7.3a2 2 0 0 1 2 2v7.2a2.3 2.3 0 0 1-2.3 2.3H5.8a2.3 2.3 0 0 1-2.3-2.3z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}
