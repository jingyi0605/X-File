// 文件助手消息时间线：迁移父仓库 Message Timeline 的核心消息行、工具卡片与能力回执卡片语义。
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { t } from "../../../i18n";
import { resolveApiUrl } from "../../../api/http";
import { getLibraryPreview } from "../../../api/library";
import { DesktopModal } from "../../../shared/modal/DesktopModal";
import {
  buildAssistantTimelineItems,
  isAssistantToolGroupItem,
  type AssistantToolGroupItem,
} from "../assistant-message-view";
import type { AssistantMessage, AssistantToolCall } from "@x-file/shared";
import {
  extractApplyPatchPathsFromToolOutput,
  getApplyPatchDisplayName,
  normalizeApplyPatchPreviewInput,
  parseApplyPatchPreview,
  type ApplyPatchFileChange,
  type ApplyPatchPreview,
} from "../apply-patch-preview";

interface AssistantMessageTimelineProps {
  messages: AssistantMessage[];
  loading: boolean;
  showEmptyHint?: boolean;
}

interface AssistantCapabilityReceiptRecord {
  ok: true;
  capability: string;
  auditId: string;
  timestamp: string;
  targetRef: {
    kind: string;
    id: string | null;
  };
  payload: Record<string, unknown>;
}

interface AssistantCapabilitySnapshot {
  kind: "session" | "automation" | "terminal" | "workspace" | "debug" | "query";
  badge: string;
  title: string;
  summary: string;
  rows: Array<{
    label: string;
    value: string;
  }>;
}

export function AssistantMessageTimeline({
  messages,
  loading,
  showEmptyHint = true,
}: AssistantMessageTimelineProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const items = useMemo(() => buildAssistantTimelineItems(messages), [messages]);

  useEffect(() => {
    const node = shellRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [items, loading]);

  if (items.length === 0 && !loading) {
    if (!showEmptyHint) {
      return <div className="message-timeline assistant-timeline-empty" />;
    }
    return (
      <div className="message-timeline assistant-timeline-empty">
        <p className="assistant-empty-hint">{t("assistantEmptyHint")}</p>
      </div>
    );
  }

  return (
    <div className="message-timeline">
      <div ref={shellRef} className="message-list">
        {items.map((item) =>
          isAssistantToolGroupItem(item) ? (
            <AssistantToolGroupRow key={item.key} item={item} />
          ) : (
            <AssistantMessageRow key={item.key} message={item.message} />
          )
        )}
        {loading ? (
          <article className="message-item assistant-message thinking-message-row" aria-live="polite">
            <div className="message-avatar" aria-hidden="true">
              <DefaultAssistantAvatar />
            </div>
            <div className="message-content-wrapper thinking-message-content">
              <div className="thinking-message-label">{t("assistantThinking")}</div>
              <div className="assistant-typing">
                <span className="assistant-typing-dot" />
                <span className="assistant-typing-dot" />
                <span className="assistant-typing-dot" />
              </div>
            </div>
          </article>
        ) : null}
      </div>
    </div>
  );
}

function AssistantMessageRow({ message }: { message: AssistantMessage }) {
  const timestamp = formatMessageTime(message.timestamp);

  if (message.role === "user") {
    return (
      <article className="message-item user-message" data-message-id={message.messageId}>
        <div className="message-content-wrapper">
          {message.attachments?.length ? <AssistantMessageAttachments attachments={message.attachments} /> : null}
          {message.content ? (
            <MessageMarkdownBody content={message.content} className="message-text message-content markdown-content" />
          ) : null}
          <div className="message-footer">
            <div className="message-time">{timestamp}</div>
            <MessageMetadataBar text={message.content} />
          </div>
        </div>
      </article>
    );
  }

  if (message.kind === "thinking") {
    return (
      <article className="message-item assistant-message thinking-message-row" data-message-id={message.messageId}>
        <div className="message-avatar" aria-hidden="true">
          <DefaultAssistantAvatar />
        </div>
        <div className="message-content-wrapper thinking-message-content">
          <div className="thinking-message-label">{t("assistantThinking")}</div>
          {message.attachments?.length ? <AssistantMessageAttachments attachments={message.attachments} /> : null}
          {message.content ? (
            <MessageMarkdownBody
              content={message.content}
              className="message-text message-content markdown-content thinking-message-text"
            />
          ) : null}
          <div className="message-footer">
            <div className="message-time">{resolveRoleLabel(message.role)} · {timestamp}</div>
            <MessageMetadataBar text={message.content} compact />
          </div>
        </div>
      </article>
    );
  }

  if (message.role === "assistant") {
    return (
      <article className="message-item assistant-message" data-message-id={message.messageId}>
        <div className="message-avatar" aria-hidden="true">
          <DefaultAssistantAvatar />
        </div>
        <div className="message-content-wrapper">
          {message.attachments?.length ? <AssistantMessageAttachments attachments={message.attachments} /> : null}
          {message.content ? (
            <MessageMarkdownBody content={message.content} className="message-text message-content markdown-content" />
          ) : null}
          <div className="message-footer">
            <div className="message-time">{resolveRoleLabel(message.role)} · {timestamp}</div>
            <MessageMetadataBar text={message.content} />
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="message-item system-message" data-message-id={message.messageId}>
      <div className="message-content-wrapper">
        {message.content ? (
          <MessageMarkdownBody content={message.content} className="message-text message-content markdown-content" />
        ) : null}
        <div className="message-footer">
          <div className="message-time">{resolveRoleLabel(message.role)} · {timestamp}</div>
          <MessageMetadataBar text={message.content} compact />
        </div>
      </div>
    </article>
  );
}

function AssistantToolGroupRow({ item }: { item: AssistantToolGroupItem }) {
  const [expanded, setExpanded] = useState(false);
  const tool = item.toolCall;
  const hasDetails = Boolean((item.hasRequest && tool.input) || tool.output || tool.error);
  const capabilitySnapshot = buildAssistantCapabilitySnapshot(tool);
  const toolCategory = resolveToolCategory(tool);
  const applyPatchPreview = useMemo(() => buildEditableToolPreview(tool), [tool]);
  const webSearchResult = useMemo(() => parseWebSearchToolResult(tool), [tool]);
  const viewImageSnapshot = useMemo(() => resolveViewImageToolSnapshot(tool), [tool]);

  if (viewImageSnapshot) {
    return (
      <article className="message-item tool-message-row" data-message-id={item.key}>
        <ViewImageToolItem tool={tool} snapshot={viewImageSnapshot} />
      </article>
    );
  }

  if (applyPatchPreview) {
    return (
      <article className="message-item tool-message-row" data-message-id={item.key}>
        <ApplyPatchToolItem tool={tool} preview={applyPatchPreview} />
      </article>
    );
  }

  if (capabilitySnapshot) {
    return (
      <article className="message-item tool-message-row" data-message-id={item.key}>
        <AssistantCapabilityToolItem
          tool={tool}
          snapshot={capabilitySnapshot}
          expanded={expanded}
          hasRequest={item.hasRequest}
          hasResult={item.hasResult}
          onToggleExpanded={() => setExpanded((current) => !current)}
        />
      </article>
    );
  }

  const preview = resolveToolPreview(tool.output || tool.input);
  const statusLabel = resolveToolStatusLabel(tool.status);
  const displayName = getToolDisplayName(tool.name || t("assistantToolCall"));
  const rawLabel = expanded ? t("assistantToolRawCollapse") : t("assistantToolRawExpand");

  return (
    <article className="message-item tool-message-row" data-message-id={item.key}>
      <div className={`tool-call-item tool-call-item-${toolCategory} ${item.hasResult ? "tool-result" : ""}`}>
        <button
          type="button"
          className="tool-call-header"
          onClick={() => {
            if (hasDetails) {
              setExpanded((current) => !current);
            }
          }}
          aria-expanded={hasDetails ? expanded : undefined}
        >
          <div className="tool-call-info">
            <span className={`tool-call-name-badge tool-call-name-badge-${toolCategory}`}>{displayName}</span>
            <span className="tool-call-input-preview" title={preview}>{preview}</span>
          </div>
          <div className="tool-call-meta">
            {statusLabel ? <span className={`tool-call-status-pill status-${tool.status}`}>{statusLabel}</span> : null}
            {hasDetails ? (
              <>
                <span className="task-tool-raw-toggle">{rawLabel}</span>
                <span className={`tool-call-toggle ${expanded ? "expanded" : ""}`} aria-hidden="true">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </span>
              </>
            ) : null}
          </div>
        </button>

        {expanded && hasDetails ? (
          <div className="tool-call-output">
            {item.hasRequest && tool.input ? (
              <div className="tool-call-section">
                <div className="tool-call-section-label">{t("assistantToolInput")}</div>
                <pre>{tool.input}</pre>
              </div>
            ) : null}
            {tool.output || tool.error || item.hasResult ? (
              <div className="tool-call-section">
                <div className="tool-call-section-label">{tool.error ? t("assistantToolError") : t("assistantToolResult")}</div>
                {webSearchResult && !tool.error ? (
                  <div className="tool-web-search-result">
                    <p className="tool-web-search-detail">{webSearchResult.detail}</p>
                    {webSearchResult.query ? (
                      <div className="tool-web-search-meta">
                        <span className="tool-web-search-meta-label">{t("assistantToolWebSearchQueryLabel")}</span>
                        <span className="tool-web-search-meta-value">{webSearchResult.query}</span>
                      </div>
                    ) : null}
                    {webSearchResult.sources.length > 0 ? (
                      <div className="tool-web-search-sources">
                        <div className="tool-web-search-sources-label">{t("assistantToolWebSearchSourcesLabel")}</div>
                        <ul className="tool-web-search-source-list">
                          {webSearchResult.sources.map((source, index) => {
                            const key = `${source.url || source.title || "source"}-${index}`;
                            const title = source.title || source.url || t("assistantToolWebSearchUntitledSource");
                            return (
                              <li key={key} className="tool-web-search-source-item">
                                {source.url ? (
                                  <a className="tool-web-search-source-link" href={source.url} target="_blank" rel="noreferrer">
                                    {title}
                                  </a>
                                ) : (
                                  <span className="tool-web-search-source-title">{title}</span>
                                )}
                                {source.url ? <span className="tool-web-search-source-url">{source.url}</span> : null}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <pre className={tool.error ? "tool-call-error" : undefined}>
                    {tool.error || tool.output || t("assistantToolResultEmpty")}
                  </pre>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function AssistantCapabilityToolItem({
  tool,
  snapshot,
  expanded,
  hasRequest,
  hasResult,
  onToggleExpanded,
}: {
  tool: AssistantToolCall;
  snapshot: AssistantCapabilitySnapshot;
  expanded: boolean;
  hasRequest: boolean;
  hasResult: boolean;
  onToggleExpanded: () => void;
}) {
  const rawLabel = expanded ? t("assistantToolRawCollapse") : t("assistantToolRawExpand");

  return (
    <div className="tool-call-item assistant-capability-item" data-kind={snapshot.kind}>
      <div className="assistant-capability-header">
        <div className="assistant-capability-heading">
          <span className="assistant-capability-icon">
            <AssistantCapabilityIcon kind={snapshot.kind} />
          </span>
          <div className="assistant-capability-heading-main">
            <span className="assistant-capability-badge">{snapshot.badge}</span>
            <strong>{snapshot.title}</strong>
            <span className="assistant-capability-summary">{snapshot.summary}</span>
          </div>
        </div>
        <button type="button" className="task-tool-raw-toggle" onClick={onToggleExpanded}>
          {rawLabel}
        </button>
      </div>

      {snapshot.rows.length > 0 ? (
        <div className="assistant-capability-list">
          {snapshot.rows.map((row) => (
            <div key={`${row.label}-${row.value}`} className="assistant-capability-row">
              <span className="assistant-capability-row-label">{row.label}</span>
              <span className="assistant-capability-row-value">{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}

      {expanded ? (
        <div className="tool-call-output">
          {hasRequest && tool.input ? (
            <div className="tool-call-section">
              <div className="tool-call-section-label">{t("assistantToolInput")}</div>
              <pre>{tool.input}</pre>
            </div>
          ) : null}
          {(hasResult || tool.error || tool.output) ? (
            <div className="tool-call-section">
              <div className="tool-call-section-label">{tool.error ? t("assistantToolError") : t("assistantToolResult")}</div>
              <pre className={tool.error ? "tool-call-error" : undefined}>
                {tool.error || tool.output || t("assistantToolResultEmpty")}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function AssistantMessageAttachments({
  attachments,
}: {
  attachments: NonNullable<AssistantMessage["attachments"]>;
}) {
  const images = attachments.filter((item) => item.kind === "image" && item.contentUrl);
  if (images.length === 0) {
    return null;
  }
  return (
    <div className="assistant-message-attachment-grid">
      {images.map((attachment) => (
        <a
          key={attachment.id}
          className="assistant-message-attachment-card"
          href={attachment.contentUrl ?? "#"}
          target="_blank"
          rel="noreferrer"
        >
          <img src={attachment.contentUrl ?? ""} alt={attachment.fileName} />
          <span>{attachment.fileName}</span>
        </a>
      ))}
    </div>
  );
}

function MessageMarkdownBody({ content, className }: { content: string; className: string }) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}

function MessageMetadataBar({ text, compact = false }: { text: string; compact?: boolean }) {
  const [copying, setCopying] = useState(false);
  const hasText = text.trim().length > 0;

  if (!hasText) {
    return null;
  }

  async function handleCopy() {
    if (!navigator.clipboard?.writeText || copying) {
      return;
    }
    setCopying(true);
    try {
      await navigator.clipboard.writeText(text);
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className={compact ? "message-metadata-bar compact" : "message-metadata-bar"}>
      <button
        type="button"
        className="message-metadata-action"
        aria-label={t("assistantCopyAction")}
        title={t("assistantCopyAction")}
        onClick={() => {
          void handleCopy();
        }}
        disabled={copying}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="9" width="10" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M7 15H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v1" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </button>
    </div>
  );
}

function resolveToolPreview(input: string): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return t("assistantToolCall");
  }
  return normalized.length > 72 ? `${normalized.slice(0, 72)}…` : normalized;
}

function parseWebSearchToolResult(tool: AssistantToolCall): {
  detail: string;
  query: string | null;
  sources: Array<{ title: string | null; url: string | null }>;
} | null {
  const output = tool.output?.trim();
  if (!output) {
    return null;
  }

  try {
    const parsed = JSON.parse(output) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    const query = readText(parsed, "query");
    const detail = readText(parsed, "result")
      ?? readText(parsed, "summary")
      ?? readText(parsed, "answer")
      ?? readText(readRecord(parsed, "data"), "summary")
      ?? "";
    const sourceItems = readArray(parsed, "sources")
      ?? readArray(readRecord(parsed, "data"), "sources")
      ?? [];
    const sources = sourceItems
      .map((item) => {
        if (!isRecord(item)) {
          return null;
        }
        return {
          title: readText(item, "title"),
          url: readText(item, "url") ?? readText(item, "link"),
        };
      })
      .filter((item): item is { title: string | null; url: string | null } => Boolean(item));

    if (!detail && sources.length === 0 && !query) {
      return null;
    }

    return {
      detail: detail || t("assistantToolResultEmpty"),
      query,
      sources,
    };
  } catch {
    return null;
  }
}

interface ViewImageToolSnapshot {
  src: string | null;
  displayPath: string;
  fileName: string;
}

function resolveViewImageToolSnapshot(tool: AssistantToolCall): ViewImageToolSnapshot | null {
  if (tool.name.trim() !== "view_image") {
    return null;
  }

  const input = parseToolInputRecord(tool.input);
  const imagePath = readText(input, "path");
  const sessionAttachment = resolveSessionAttachmentUrl(imagePath);
  const inlineImageUrl = resolveViewImageToolInlineImageUrl(tool);
  const src = inlineImageUrl ?? sessionAttachment;

  return {
    src,
    displayPath: imagePath ?? t("assistantToolViewImage"),
    fileName: getFileNameFromPath(imagePath ?? t("assistantToolViewImage")),
  };
}

function resolveSessionAttachmentUrl(imagePath: string | null): string | null {
  const normalizedPath = imagePath?.trim() ?? "";
  if (!normalizedPath) {
    return null;
  }

  const matched = normalizedPath.match(
    /session-attachments\/([^/]+)\/[^/]+\/([0-9a-f-]+)-[^/]+$/i
  );

  if (!matched?.[1] || !matched?.[2]) {
    return null;
  }

  return resolveApiUrl(
    `/api/assistant/sessions/${encodeURIComponent(matched[1])}/attachments/${encodeURIComponent(matched[2])}`
  );
}

function resolveViewImageToolInlineImageUrl(tool: AssistantToolCall): string | null {
  for (const candidate of [tool.output, tool.input]) {
    const normalized = candidate?.trim() ?? "";
    if (!normalized) {
      continue;
    }
    if (/^data:image\//i.test(normalized)) {
      return normalized;
    }
    try {
      const parsed = JSON.parse(normalized) as unknown;
      const found = collectInlineImageUrl(parsed);
      if (found) {
        return found;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

function collectInlineImageUrl(value: unknown): string | null {
  if (typeof value === "string") {
    return /^data:image\//i.test(value.trim()) ? value.trim() : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = collectInlineImageUrl(item);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (!isRecord(value)) {
    return null;
  }
  for (const item of Object.values(value)) {
    const found = collectInlineImageUrl(item);
    if (found) {
      return found;
    }
  }
  return null;
}

function getFileNameFromPath(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}

function buildEditableToolPreview(tool: AssistantToolCall): ApplyPatchPreview | null {
  if (tool.name === "apply_patch") {
    const directPreview = parseApplyPatchPreview(tool.input);
    if (directPreview) {
      return directPreview;
    }

    const fallbackPaths = extractApplyPatchPathsFromToolOutput(tool.output || tool.error || "");
    const normalizedInput = normalizeApplyPatchPreviewInput(tool.input, fallbackPaths);
    return normalizedInput ? parseApplyPatchPreview(normalizedInput) : null;
  }

  const normalizedName = tool.name.trim().toLowerCase();
  const editableKind = resolveEditableToolKind(normalizedName);
  if (!editableKind) {
    return null;
  }

  const input = parseToolInputRecord(tool.input);
  if (!input) {
    return null;
  }

  const filePath = readFirstToolInputText(input, ["file_path", "filePath", "path"]);
  if (!filePath) {
    return null;
  }

  if (editableKind === "write") {
    const content = readFirstToolInputText(input, ["content", "new_content", "newContent"]);
    const contentLines = content.length > 0 ? content.split(/\r?\n/) : [];
    return {
      files: [
        {
          path: filePath,
          nextPath: null,
          action: "add",
          additions: contentLines.length,
          deletions: 0,
          statsKnown: true,
          lines: contentLines.map((line, index) => ({
            kind: "add",
            text: `+${line}`,
            oldLineNumber: null,
            newLineNumber: index + 1,
          })),
        },
      ],
      totalAdditions: contentLines.length,
      totalDeletions: 0,
    };
  }

  const oldText = readFirstToolInputText(input, ["old_string", "oldString", "old_text", "oldText", "search", "searchText"]);
  const newText = readFirstToolInputText(input, ["new_string", "newString", "new_text", "newText", "replacement", "replacementText", "replace"]);
  return {
    files: [
      {
        path: filePath,
        nextPath: null,
        action: "update",
        additions: newText ? newText.split(/\r?\n/).length : 0,
        deletions: oldText ? oldText.split(/\r?\n/).length : 0,
        statsKnown: true,
        lines: [
          ...oldText.split(/\r?\n/).filter(Boolean).map((line, index) => ({
            kind: "remove" as const,
            text: `-${line}`,
            oldLineNumber: index + 1,
            newLineNumber: null,
          })),
          ...newText.split(/\r?\n/).filter(Boolean).map((line, index) => ({
            kind: "add" as const,
            text: `+${line}`,
            oldLineNumber: null,
            newLineNumber: index + 1,
          })),
        ],
      },
    ],
    totalAdditions: newText ? newText.split(/\r?\n/).filter(Boolean).length : 0,
    totalDeletions: oldText ? oldText.split(/\r?\n/).filter(Boolean).length : 0,
  };
}

function resolveEditableToolKind(name: string): "write" | "edit" | null {
  if (name === "write" || name === "create_file") {
    return "write";
  }
  if (name === "edit" || name === "replace" || name === "str_replace_editor") {
    return "edit";
  }
  return null;
}

function ApplyPatchToolItem({ tool, preview }: { tool: AssistantToolCall; preview: ApplyPatchPreview }) {
  const [selectedFileIndex, setSelectedFileIndex] = useState<number | null>(null);
  const selectedFile = selectedFileIndex === null ? null : preview.files[selectedFileIndex] ?? null;

  useEffect(() => {
    if (selectedFileIndex === null) {
      return undefined;
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedFileIndex(null);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedFileIndex]);

  return (
    <>
      <div className="tool-call-item apply-patch-item">
        {preview.files.map((file, index) => (
          <button
            key={buildApplyPatchFileRenderKey(file, index)}
            type="button"
            className="apply-patch-summary-row"
            onClick={() => setSelectedFileIndex(index)}
          >
            <span className="apply-patch-summary-label">{getApplyPatchActionLabel(file.action)}</span>
            <span className="apply-patch-summary-file" title={buildApplyPatchFullPathLabel(file)}>
              {getApplyPatchDisplayName(file.nextPath ?? file.path)}
            </span>
            {renderApplyPatchSummaryStats(file)}
          </button>
        ))}
      </div>

      <DesktopModal
        open={selectedFile !== null}
        title={t("assistantApplyPatchDialogTitle")}
        description={t("assistantApplyPatchDialogDescription")}
        size="full"
        layout="viewer"
        className="apply-patch-modal"
        bodyClassName="apply-patch-modal-body"
        onClose={() => setSelectedFileIndex(null)}
      >
        {selectedFile ? (
          <>
            <div className="apply-patch-modal-totals">
              {renderApplyPatchModalStats(selectedFile)}
            </div>
            <section className="apply-patch-file-panel">
              <div className="apply-patch-file-panel-header">
                <div className="apply-patch-file-panel-title">
                  <span className="apply-patch-summary-label">{getApplyPatchActionLabel(selectedFile.action)}</span>
                  <strong>{buildApplyPatchFullPathLabel(selectedFile)}</strong>
                </div>
                {renderApplyPatchSummaryStats(selectedFile)}
              </div>
              <div className="apply-patch-diff-view">
                <div className="apply-patch-diff-scroll">
                  {selectedFile.lines.map((line, index) => (
                    <div
                      key={`${buildApplyPatchFullPathLabel(selectedFile)}:${index}`}
                      className={`apply-patch-diff-line ${resolveApplyPatchLineClassName(line.kind)}`}
                    >
                      <span className="apply-patch-line-number">{formatApplyPatchLineNumber(line.oldLineNumber)}</span>
                      <span className="apply-patch-line-number">{formatApplyPatchLineNumber(line.newLineNumber)}</span>
                      <span className="apply-patch-line-content">{line.text || " "}</span>
                    </div>
                  ))}
                </div>
              </div>
            </section>
            {tool.error ? (
              <section className="apply-patch-error-panel">
                <div className="tool-call-section-label">{t("assistantToolResult")}</div>
                <pre className="tool-call-error">{tool.error}</pre>
              </section>
            ) : null}
          </>
        ) : null}
      </DesktopModal>
    </>
  );
}

function ViewImageToolItem({ tool, snapshot }: { tool: AssistantToolCall; snapshot: ViewImageToolSnapshot }) {
  const [src, setSrc] = useState<string | null>(snapshot.src);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (snapshot.src || !snapshot.displayPath) {
      setSrc(snapshot.src);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void getLibraryPreview(snapshot.displayPath)
      .then((preview) => {
        if (cancelled) {
          return;
        }
        setSrc(preview.previewUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setSrc(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [snapshot.displayPath, snapshot.src]);

  return (
    <div className={`tool-call-item view-image-tool-item ${tool.status === "completed" ? "tool-result" : ""}`}>
      <div className="tool-call-header view-image-tool-header">
        <div className="tool-call-info">
          <span className="tool-call-name-badge tool-call-name-badge-image">{t("assistantToolViewImage")}</span>
          <span className="tool-call-input-preview">{snapshot.displayPath}</span>
        </div>
      </div>
      <div className="view-image-tool-preview">
        {src ? (
          <img src={src} alt={snapshot.fileName} />
        ) : (
          <div className="view-image-tool-placeholder">
            {loading ? t("assistantAttachmentPreviewLoading") : t("assistantAttachmentPreviewUnavailable")}
          </div>
        )}
      </div>
    </div>
  );
}

function getApplyPatchActionLabel(action: ApplyPatchFileChange["action"]) {
  if (action === "add") {
    return t("assistantApplyPatchActionAdd");
  }
  if (action === "delete") {
    return t("assistantApplyPatchActionDelete");
  }
  return t("assistantApplyPatchActionUpdate");
}

function buildApplyPatchFullPathLabel(file: ApplyPatchFileChange): string {
  return file.nextPath ? `${file.path} -> ${file.nextPath}` : file.path;
}

function buildApplyPatchFileRenderKey(file: ApplyPatchFileChange, index: number): string {
  return `${file.path}:${file.nextPath ?? "same"}:${index}`;
}

function renderApplyPatchSummaryStats(file: ApplyPatchFileChange) {
  return (
    <span className="apply-patch-summary-stats">
      <span className="apply-patch-summary-added">+{file.additions}</span>
      <span className="apply-patch-summary-removed">-{file.deletions}</span>
    </span>
  );
}

function renderApplyPatchModalStats(file: ApplyPatchFileChange) {
  return (
    <>
      <span className="apply-patch-stat-pill positive">+{file.additions}</span>
      <span className="apply-patch-stat-pill negative">-{file.deletions}</span>
      <span className="apply-patch-stat-pill neutral">{getApplyPatchActionLabel(file.action)}</span>
    </>
  );
}

function resolveApplyPatchLineClassName(kind: "add" | "remove" | "context"): string {
  if (kind === "add") {
    return "added";
  }
  if (kind === "remove") {
    return "removed";
  }
  return "context";
}

function formatApplyPatchLineNumber(value: number | null): string {
  return typeof value === "number" ? String(value) : "";
}

function getToolDisplayName(name: string): string {
  if (name === "shell_command" || name === "tool") {
    return t("assistantRoleTool");
  }
  if (name === "web_search" || name === "web_search_20250305") {
    return t("assistantToolWebSearch");
  }
  if (name === "apply_patch") {
    return t("assistantToolApplyPatch");
  }
  if (name === "view_image") {
    return t("assistantToolViewImage");
  }
  return name;
}

function resolveToolCategory(tool: AssistantToolCall): "command" | "search" | "patch" | "image" | "agent" | "generic" {
  const normalized = tool.name.trim().toLowerCase();
  if (normalized === "shell_command" || normalized === "tool") {
    return "command";
  }
  if (normalized === "web_search" || normalized === "web_search_20250305") {
    return "search";
  }
  if (normalized === "apply_patch") {
    return "patch";
  }
  if (normalized === "view_image") {
    return "image";
  }
  if (normalized === "agent" || normalized.endsWith("agent") || normalized.includes("spawn_agent")) {
    return "agent";
  }
  return "generic";
}

function buildAssistantCapabilitySnapshot(tool: AssistantToolCall): AssistantCapabilitySnapshot | null {
  const receipt = parseAssistantCapabilityReceipt(tool);

  if (receipt) {
    const meta = resolveAssistantCapabilityMeta(receipt.capability);
    const rows = buildAssistantCapabilityRows(receipt, tool.status);
    return {
      ...meta,
      rows,
    };
  }

  return buildAgentToolSnapshot(tool);
}

function parseAssistantCapabilityReceipt(tool: AssistantToolCall): AssistantCapabilityReceiptRecord | null {
  const candidates = [tool.output, tool.input];

  for (const candidate of candidates) {
    const parsed = parseAssistantCapabilityReceiptCandidate(candidate, 0);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function parseAssistantCapabilityReceiptCandidate(
  raw: string | null | undefined,
  depth: number
): AssistantCapabilityReceiptRecord | null {
  if (!raw?.trim() || depth > 2) {
    return null;
  }

  try {
    return unwrapAssistantCapabilityReceipt(JSON.parse(raw) as unknown, depth);
  } catch {
    return null;
  }
}

function unwrapAssistantCapabilityReceipt(
  value: unknown,
  depth: number
): AssistantCapabilityReceiptRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  if (looksLikeAssistantCapabilityReceipt(value)) {
    return {
      ok: true,
      capability: readText(value, "capability") ?? "",
      auditId: readText(value, "auditId") ?? "",
      timestamp: readText(value, "timestamp") ?? "",
      targetRef: {
        kind: readText(readRecord(value, "targetRef"), "kind") ?? "none",
        id: readText(readRecord(value, "targetRef"), "id"),
      },
      payload: readRecord(value, "payload") ?? {},
    };
  }

  for (const key of ["output", "result", "data", "payload"]) {
    const nested = value[key];

    if (typeof nested === "string") {
      const parsed = parseAssistantCapabilityReceiptCandidate(nested, depth + 1);
      if (parsed) {
        return parsed;
      }
    }

    if (isRecord(nested)) {
      const parsed = unwrapAssistantCapabilityReceipt(nested, depth + 1);
      if (parsed) {
        return parsed;
      }
    }
  }

  return null;
}

function looksLikeAssistantCapabilityReceipt(value: Record<string, unknown>): boolean {
  return value.ok === true
    && typeof value.capability === "string"
    && typeof value.auditId === "string"
    && typeof value.timestamp === "string"
    && isRecord(value.targetRef)
    && isRecord(value.payload);
}

function resolveAssistantCapabilityMeta(capability: string): Omit<AssistantCapabilitySnapshot, "rows"> {
  switch (capability) {
    case "session":
      return {
        kind: "session",
        badge: t("assistantCapabilityBadgeSession"),
        title: t("assistantCapabilityTitleSession"),
        summary: t("assistantCapabilitySummarySession"),
      };
    case "automation":
      return {
        kind: "automation",
        badge: t("assistantCapabilityBadgeAutomation"),
        title: t("assistantCapabilityTitleAutomation"),
        summary: t("assistantCapabilitySummaryAutomation"),
      };
    case "terminal":
      return {
        kind: "terminal",
        badge: t("assistantCapabilityBadgeTerminal"),
        title: t("assistantCapabilityTitleTerminal"),
        summary: t("assistantCapabilitySummaryTerminal"),
      };
    case "workspace":
    case "worktree":
      return {
        kind: "workspace",
        badge: t("assistantCapabilityBadgeWorkspace"),
        title: t("assistantCapabilityTitleWorkspace"),
        summary: t("assistantCapabilitySummaryWorkspace"),
      };
    case "debug":
      return {
        kind: "debug",
        badge: t("assistantCapabilityBadgeDebug"),
        title: t("assistantCapabilityTitleDebug"),
        summary: t("assistantCapabilitySummaryDebug"),
      };
    default:
      return {
        kind: "query",
        badge: t("assistantCapabilityBadgeQuery"),
        title: capability || t("assistantCapabilityTitleQuery"),
        summary: t("assistantCapabilitySummaryQuery"),
      };
  }
}

function buildAssistantCapabilityRows(
  receipt: AssistantCapabilityReceiptRecord,
  status: AssistantToolCall["status"]
): AssistantCapabilitySnapshot["rows"] {
  const rows: AssistantCapabilitySnapshot["rows"] = [];
  pushCapabilityRow(rows, t("assistantCapabilityLabelTarget"), receipt.targetRef.id ?? receipt.targetRef.kind);
  pushCapabilityRow(rows, t("assistantCapabilityLabelStatus"), resolveToolStatusLabel(status));
  pushCapabilityRow(rows, t("assistantCapabilityLabelAuditId"), receipt.auditId);
  pushCapabilityRow(rows, t("assistantCapabilityLabelTime"), formatMessageTime(receipt.timestamp));

  const payloadCount = extractPayloadCount(receipt.payload);
  if (payloadCount) {
    pushCapabilityRow(rows, t("assistantCapabilityLabelCount"), payloadCount);
  }

  return rows.slice(0, 5);
}

function buildAgentToolSnapshot(tool: AssistantToolCall): AssistantCapabilitySnapshot | null {
  const normalized = tool.name.trim();
  const input = parseToolInputRecord(tool.input);

  if (normalized === "Agent") {
    const subagentType = readText(input, "subagent_type");
    const description = readText(input, "description");
    const rows: AssistantCapabilitySnapshot["rows"] = [];
    pushCapabilityRow(rows, t("assistantCapabilityLabelAgentType"), subagentType);
    pushCapabilityRow(rows, t("assistantCapabilityLabelStatus"), resolveToolStatusLabel(tool.status));
    pushCapabilityRow(rows, t("assistantCapabilityLabelDescription"), description);
    return {
      kind: "session",
      badge: t("assistantCapabilityBadgeSubAgent"),
      title: t("assistantCapabilityTitleSubAgent"),
      summary: description || subagentType || t("assistantCapabilitySummarySubAgent"),
      rows,
    };
  }

  const action = resolveCodexAgentToolAction(normalized, input);
  if (!action) {
    return null;
  }

  const output = parseToolLooseRecord(tool.output);
  const rows: AssistantCapabilitySnapshot["rows"] = [];
  pushCapabilityRow(rows, t("assistantCapabilityLabelAgent"), resolveCodexAgentId(input, output));
  pushCapabilityRow(rows, t("assistantCapabilityLabelNickname"), readText(output, "nickname"));
  pushCapabilityRow(rows, t("assistantCapabilityLabelStatus"), resolveToolStatusLabel(tool.status));
  pushCapabilityRow(rows, t("assistantCapabilityLabelModel"), readText(input, "model"));
  pushCapabilityRow(rows, t("assistantCapabilityLabelAction"), action);

  return {
    kind: "session",
    badge: t("assistantCapabilityBadgeSubAgent"),
    title: t("assistantCapabilityTitleSubAgent"),
    summary: t("assistantCapabilitySummarySubAgent"),
    rows,
  };
}

function resolveCodexAgentToolAction(name: string, input: Record<string, unknown> | null): string | null {
  switch (name) {
    case "spawn_agent":
      return "create";
    case "wait_agent":
      return "read";
    case "resume_agent":
      return "update";
    case "send_input":
      return input?.interrupt === true ? "update" : "reply";
    case "close_agent":
      return "close";
    default:
      return null;
  }
}

function resolveCodexAgentId(
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null
): string | null {
  return readText(input, "target")
    ?? readFirstTextFromArray(input, "targets")
    ?? readText(output, "id")
    ?? readText(output, "agent_id")
    ?? readText(output, "target");
}

function parseToolInputRecord(input: string): Record<string, unknown> | null {
  if (!input.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(input) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readArray(record: Record<string, unknown> | null | undefined, key: string): unknown[] | null {
  if (!record) {
    return null;
  }
  const value = record[key];
  return Array.isArray(value) ? value : null;
}

function readFirstToolInputText(record: Record<string, unknown>, fields: string[]): string {
  for (const field of fields) {
    const value = readText(record, field);
    if (value) {
      return value;
    }
  }
  return "";
}

function parseToolLooseRecord(raw: string | null | undefined): Record<string, unknown> | null {
  if (!raw?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractPayloadCount(payload: Record<string, unknown>): string | null {
  for (const key of ["count", "total", "matched", "size"]) {
    const value = payload[key];
    if (typeof value === "number" || typeof value === "string") {
      return String(value);
    }
  }
  return null;
}

function pushCapabilityRow(
  rows: AssistantCapabilitySnapshot["rows"],
  label: string,
  value: string | null | undefined
) {
  const normalized = value?.trim();
  if (!normalized) {
    return;
  }
  rows.push({ label, value: normalized });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRecord(record: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  if (!record) {
    return null;
  }
  const value = record[key];
  return isRecord(value) ? value : null;
}

function readText(record: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!record) {
    return null;
  }
  const value = record[key];
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function readFirstTextFromArray(record: Record<string, unknown> | null, key: string): string | null {
  const array = record?.[key];
  if (!Array.isArray(array)) {
    return null;
  }
  const value = array.find((item) => typeof item === "string" && item.trim());
  return typeof value === "string" ? value.trim() : null;
}

function DefaultAssistantAvatar() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3.5 14 9l5.5 2-5.5 2L12 18.5 10 13 4.5 11 10 9 12 3.5Z" />
    </svg>
  );
}

function AssistantCapabilityIcon({
  kind,
}: {
  kind: AssistantCapabilitySnapshot["kind"];
}) {
  if (kind === "terminal") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="m6 7 4 5-4 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M13 17h5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  if (kind === "workspace") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 7.5h16v10H4z" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="M8 5h8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  if (kind === "debug") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 4h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M8 8h8v8a4 4 0 0 1-8 0z" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    );
  }

  if (kind === "automation") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 6v6l4 2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
      </svg>
    );
  }

  if (kind === "query") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="11" cy="11" r="6" fill="none" stroke="currentColor" strokeWidth="1.8" />
        <path d="m20 20-4.2-4.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v16M4 12h16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function resolveRoleLabel(role: AssistantMessage["role"]): string {
  if (role === "user") {
    return t("assistantRoleUser");
  }
  if (role === "assistant") {
    return t("assistantRoleAssistant");
  }
  if (role === "system") {
    return t("assistantRoleSystem");
  }
  return t("assistantRoleTool");
}

function resolveToolStatusLabel(status: "running" | "completed" | "failed" | undefined): string {
  if (status === "running") {
    return t("assistantToolRunning");
  }
  if (status === "failed") {
    return t("assistantToolFailed");
  }
  return t("assistantToolCompleted");
}

function formatMessageTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
