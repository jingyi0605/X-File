import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  AssistantAttachment,
  AssistantProviderId,
  AssistantProviderInfo,
  AssistantReasoningLevel
} from "@x-file/shared";
import type { CSSProperties } from "react";

import { t } from "../../../i18n";

interface AssistantComposerProps {
  providers: AssistantProviderInfo[];
  provider: AssistantProviderId | null;
  sending: boolean;
  activeRun: boolean;
  onSend: (input: {
    content: string;
    model?: string | null;
    reasoningLevel?: string | null;
    attachments?: Array<AssistantAttachment & { dataUrl: string }>;
  }) => void;
  onInterrupt: () => void;
}

interface PendingImageAttachment extends AssistantAttachment {
  dataUrl: string;
}

const DEFAULT_REASONING_LEVEL: AssistantReasoningLevel = "medium";

export function AssistantComposer({
  providers,
  provider,
  sending,
  activeRun,
  onSend,
  onInterrupt
}: AssistantComposerProps) {
  const [value, setValue] = useState("");
  const [selectedModel, setSelectedModel] = useState<string>("provider-default");
  const [selectedReasoningLevel, setSelectedReasoningLevel] = useState<AssistantReasoningLevel>(DEFAULT_REASONING_LEVEL);
  const [attachments, setAttachments] = useState<PendingImageAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composerInputId = useId();

  const activeProvider = providers.find((item) => item.id === provider) ?? null;
  const canSend = Boolean(activeProvider?.available);
  const modelOptions = activeProvider?.modelOptions ?? [];
  const supportsAttachments = activeProvider?.supportsAttachments ?? false;
  const reasoningOptions = useMemo(
    () => resolveReasoningOptions(activeProvider),
    [activeProvider]
  );
  const canShowReasoningSelect = provider === "codex" && reasoningOptions.length > 0;
  const currentModelLabel = modelOptions.find((item) => item.id === selectedModel)?.name ?? t("assistantModeDefaultOption");
  const modelSelectStyle = {
    "--assistant-model-select-width": resolveCompactSelectWidth(currentModelLabel)
  } as CSSProperties;

  useEffect(() => {
    const defaultModel = modelOptions.find((item) => item.usesProviderDefault)?.id ?? modelOptions[0]?.id ?? "provider-default";
    setSelectedModel(defaultModel);
  }, [provider, modelOptions]);

  useEffect(() => {
    const fallback = activeProvider?.defaultReasoningLevel ?? DEFAULT_REASONING_LEVEL;
    setSelectedReasoningLevel(isAssistantReasoningLevel(fallback) ? fallback : DEFAULT_REASONING_LEVEL);
  }, [activeProvider?.defaultReasoningLevel, provider]);

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) {
      return;
    }
    node.style.height = "0px";
    node.style.height = `${Math.max(90, Math.min(node.scrollHeight, 140))}px`;
  }, [value]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || sending || !canSend) {
      return;
    }
    const nextAttachments = [...attachments];
    setValue("");
    setAttachments([]);
    onSend({
      content: trimmed,
      model: selectedModel === "provider-default" ? null : selectedModel,
      reasoningLevel: canShowReasoningSelect ? selectedReasoningLevel : null,
      attachments: nextAttachments
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!supportsAttachments) {
      return;
    }
    const files = Array.from(event.clipboardData.files ?? []);
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) {
      return;
    }
    event.preventDefault();
    const next = await Promise.all(imageFiles.map((file) => toPendingImageAttachment(file)));
    setAttachments((current) => [...current, ...next]);
  };

  return (
    <section className="composer-panel assistant-composer">
      <div className="assistant-composer-shell">
        <div className="assistant-composer-stage">
          {attachments.length > 0 ? (
            <div className="assistant-composer-attachment-strip" role="list" aria-label={t("assistantAttachmentPreviewLabel")}>
              {attachments.map((attachment) => (
                <div key={attachment.id} role="listitem" className="assistant-composer-attachment-chip">
                  <img src={attachment.dataUrl} alt={attachment.fileName} />
                  <div className="assistant-composer-attachment-chip-copy">
                    <strong>{attachment.fileName}</strong>
                    <span>{formatAttachmentSize(attachment.fileSize)}</span>
                  </div>
                  <button
                    type="button"
                    className="assistant-composer-attachment-remove"
                    aria-label={t("assistantAttachmentRemove")}
                    onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="assistant-composer-input-area">
            <textarea
              id={composerInputId}
              ref={textareaRef}
              className="composer-input assistant-composer-textarea"
              placeholder={t("assistantComposerPlaceholder")}
              aria-label={t("assistantComposerPlaceholder")}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              rows={3}
              disabled={!canSend}
            />
            <button
              type="button"
              className="composer-send assistant-send-button"
              onClick={submit}
              disabled={sending || !value.trim() || !canSend}
              aria-label={sending ? t("assistantSending") : t("assistantSend")}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4.8 18.2 19.2 4.8l-4 14.4-4.2-5.1-6.2 4.1Z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>
        <div className="assistant-composer-controls">
          <select
            className="composer-deployment-select assistant-composer-select"
            value={selectedModel}
            aria-label={t("assistantModeSelect")}
            onChange={(event) => setSelectedModel(event.target.value)}
            disabled={!canSend || modelOptions.length === 0}
            style={modelSelectStyle}
          >
            {modelOptions.length === 0 ? (
              <option value="provider-default">{t("assistantModeDefaultOption")}</option>
            ) : (
              modelOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))
            )}
          </select>
          {canShowReasoningSelect ? (
            <select
              className="composer-deployment-select assistant-composer-select assistant-composer-select-compact"
              value={selectedReasoningLevel}
              aria-label={t("assistantReasoningLevelSelect")}
              onChange={(event) => {
                const next = event.target.value;
                if (isAssistantReasoningLevel(next)) {
                  setSelectedReasoningLevel(next);
                }
              }}
              disabled={!canSend}
            >
              {reasoningOptions.map((option) => (
                <option key={option} value={option}>
                  {resolveReasoningLabel(option)}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            className="assistant-composer-icon-button"
            aria-label={t("assistantAttachmentHint")}
            title={supportsAttachments ? t("assistantAttachmentHint") : t("assistantAttachmentUnsupported")}
            disabled={!supportsAttachments}
            onClick={() => textareaRef.current?.focus()}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M9 7h6M12 4v6M7 12h10v6H7z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {activeRun ? (
            <button type="button" className="assistant-composer-icon-button assistant-composer-stop-button" onClick={onInterrupt}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6h12v12H6z" fill="currentColor" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function resolveReasoningOptions(provider: AssistantProviderInfo | null): AssistantReasoningLevel[] {
  const source = provider?.supportedReasoningLevels ?? [];
  const normalized = source.filter(isAssistantReasoningLevel);
  if (normalized.length > 0) {
    return normalized;
  }
  return provider?.id === "codex" ? ["minimal", "low", "medium", "high", "maximum"] : [];
}

function isAssistantReasoningLevel(value: string | null | undefined): value is AssistantReasoningLevel {
  return value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "maximum";
}

function resolveReasoningLabel(value: AssistantReasoningLevel): string {
  if (value === "minimal") return t("assistantReasoningMinimal");
  if (value === "low") return t("assistantReasoningLow");
  if (value === "medium") return t("assistantReasoningMedium");
  if (value === "high") return t("assistantReasoningHigh");
  return t("assistantReasoningMaximum");
}

function resolveCompactSelectWidth(label: string): string {
  const trimmed = label.trim();
  if (!trimmed) {
    return "88px";
  }
  const width = 44 + [...trimmed].reduce((total, char) => total + (char.charCodeAt(0) > 255 ? 16 : 9), 0);
  return `${Math.min(Math.max(width, 88), 148)}px`;
}

async function toPendingImageAttachment(file: File): Promise<PendingImageAttachment> {
  const dataUrl = await readFileAsDataUrl(file);
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: "image",
    fileName: file.name || `image-${Date.now()}.png`,
    mimeType: file.type || "image/png",
    fileSize: file.size,
    contentUrl: dataUrl,
    dataUrl
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });
}

function formatAttachmentSize(fileSize: number): string {
  if (fileSize < 1024) {
    return `${fileSize} B`;
  }
  if (fileSize < 1024 * 1024) {
    return `${(fileSize / 1024).toFixed(1)} KB`;
  }
  return `${(fileSize / (1024 * 1024)).toFixed(1)} MB`;
}
