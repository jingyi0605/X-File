import { useEffect, useId, useRef, useState } from "react";
import type { AgentIntegrationSettings as Settings, SaveAgentIntegrationSettingsInput } from "@x-file/shared";

import { t } from "../../i18n";
import { ApiClientError, resolveApiUrl, toApiErrorMessage } from "../../api/http";
import { InterfaceIcon } from "../../shared/InterfaceIcon";
import { DesktopModal, ModalActions, ModalEmptyState, ModalSection } from "../../shared/modal";
import { SettingsModule } from "./SettingsModule";
import {
  AGENT_SETTINGS_PATH,
  getAgentIntegrationSettings,
  saveAgentIntegrationSettings,
} from "../../api/agent-integration";
import { useRuntimeConfigSelector } from "../../runtime/runtime-config-store";

interface ApiKeyInputState {
  value: string;
  mode: "draft" | "generated" | "masked";
  copied?: boolean;
}

// 终端示例使用对应平台的字面量转义，路径不作为可执行脚本拼接。
function quote(value: string, windows: boolean): string {
  return `'${value.replaceAll("'", windows ? "''" : "'\\''")}'`;
}

export function buildAgentExamples(settings: Settings, readOnly: boolean) {
  const windows = settings.platform === "windows";
  const executable = quote(settings.executablePath, windows);
  const dataDir = quote(settings.dataDir, windows);
  const prefix = windows ? "& " : "";
  const args = ["mcp", "--data-dir", settings.dataDir, ...(readOnly ? ["--read-only"] : [])];
  return {
    mcp: JSON.stringify({
      mcpServers: {
        "x-file": {
          command: settings.executablePath,
          args,
          env: { X_FILE_AGENT_API_KEY: "<X_FILE_AGENT_API_KEY>" },
        },
      },
    }, null, 2),
    cli: [
      windows
        ? "$env:X_FILE_AGENT_API_KEY = '<X_FILE_AGENT_API_KEY>'"
        : "export X_FILE_AGENT_API_KEY='<X_FILE_AGENT_API_KEY>'",
      `${prefix}${executable} cli --data-dir ${dataDir}${readOnly ? " --read-only" : ""} call xfile_status`,
    ].join("\n"),
    skill: windows
      ? [
        '$skillDir = Join-Path $HOME ".agents/skills/x-file"',
        "New-Item -ItemType Directory -Force $skillDir | Out-Null",
        "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
        `$skillText = (${prefix}${executable} cli skill) -join "\`n"`,
        '[System.IO.File]::WriteAllText((Join-Path $skillDir "SKILL.md"), $skillText + "`n", [System.Text.UTF8Encoding]::new($false))',
      ].join("\n")
      : [
        'mkdir -p "$HOME/.agents/skills/x-file"',
        `${executable} cli skill > "$HOME/.agents/skills/x-file/SKILL.md"`,
      ].join("\n"),
  };
}

export function AgentIntegrationSettings() {
  const runtime = useRuntimeConfigSelector((state) => state.config);
  // 主机或模式变化时卸载表单，清除一次性密钥并丢弃旧主机的异步结果。
  return <AgentIntegrationForm key={`${runtime.mode}:${resolveApiUrl(AGENT_SETTINGS_PATH)}`}
    mirrorMode={runtime.mode === "mirror"} />;
}

function AgentIntegrationForm({ mirrorMode }: { mirrorMode: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [keyInput, setKeyInput] = useState<ApiKeyInputState>({ value: "", mode: "draft" });
  const keyInputRef = useRef<HTMLInputElement>(null);
  const keyInputId = useId();
  const [readOnly, setReadOnly] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const [configurationOpen, setConfigurationOpen] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSettings(null);
    setKeyInput({ value: "", mode: "draft" });
    setError("");
    setMessage("");
    void getAgentIntegrationSettings()
      .then((value) => { if (active) setSettings(value); })
      .catch((reason) => {
        if (active) setError(reason instanceof ApiClientError && reason.status === 404
          ? t("agentUnavailable") : toApiErrorMessage(reason));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retryKey]);

  useEffect(() => {
    if (keyInput.mode === "generated") {
      keyInputRef.current?.focus({ preventScroll: true });
      keyInputRef.current?.select();
    }
  }, [keyInput]);

  async function save(input: SaveAgentIntegrationSettingsInput) {
    setBusy(true);
    setError("");
    setMessage("");
    // 每次修改都移除上一次的一次性明文。
    setKeyInput((current) => current.mode === "draft" ? current : { value: "", mode: "draft" });
    try {
      const result = await saveAgentIntegrationSettings(input);
      setSettings(result.settings);
      setKeyInput({ value: result.apiKey ?? "", mode: result.apiKey ? "generated" : "draft" });
      setMessage(t(result.apiKey ? "agentKeyOnce" : "agentSaved"));
    } catch (reason) {
      setError(toApiErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string, onCopied?: () => void) {
    setError("");
    setMessage("");
    try {
      await navigator.clipboard.writeText(text);
      onCopied?.();
      setMessage(t("agentCopied"));
    } catch {
      setError(t("agentCopyFailed"));
    }
  }

  async function copyKey() {
    const value = keyInput.value;
    setKeyInput((current) => ({ ...current, copied: false }));
    await copy(value, () => setKeyInput((current) =>
      current.mode !== "draft" && current.value === value
        ? { ...current, copied: true }
        : current,
    ));
  }

  const examples = settings ? buildAgentExamples(settings, readOnly) : null;
  const canSaveKey = !busy && keyInput.mode === "draft" && keyInput.value.length >= 32;
  const canCopyKey = keyInput.mode !== "draft" && keyInput.value.length > 0;
  return (
    <SettingsModule
      title={t("agentTitle")}
      description={t("agentDescription")}
      listItem
      status={settings ? t(settings.enabled ? "settingsIntegrationEnabled" : "settingsIntegrationDisabled") : undefined}
      actions={settings ? (
        <button
          type="button"
          className="mac-switch"
          role="switch"
          aria-label={t("agentEnabled")}
          aria-checked={settings.enabled}
          data-checked={settings.enabled ? "true" : "false"}
          disabled={busy || (!settings.enabled && !settings.apiKeyConfigured)}
          onClick={() => void save({ enabled: !settings.enabled })}
        ><span aria-hidden="true" /></button>
      ) : null}
      feedback={error || message ? (
        <>
          {error ? <div className="inline-note" role="alert">{error}</div> : null}
          {message ? <p className="settings-helper-text" role="status">{message}</p> : null}
        </>
      ) : null}
    >
      {loading ? <p>{t("agentLoading")}</p> : null}
      {mirrorMode ? <p className="inline-note">{t("agentMirrorNotice")}</p> : null}
      {!loading && !settings ? (
        <div className="button-row">
          <button type="button" className="secondary-button" onClick={() => setRetryKey((current) => current + 1)}>
            {t("agentRetry")}
          </button>
        </div>
      ) : null}
      {settings && examples ? (
        <>
          <section className="settings-module-group" aria-label="API Key">
            <div className="settings-heading-row">
              <h4 className="settings-module-title">API Key</h4>
              <span className="settings-module-status">{t(settings.apiKeyConfigured ? "agentKeyConfigured" : "agentKeyMissing")}</span>
            </div>
            <form className="settings-agent-form" onSubmit={(event) => {
              event.preventDefault();
              if (canSaveKey) void save({ apiKey: keyInput.value });
            }}>
              <div className="modal-field">
                <div className="input-with-action" data-has-action={canCopyKey ? "true" : undefined}>
                  <input id={keyInputId} ref={keyInputRef} type={keyInput.mode === "generated" ? "text" : "password"}
                    aria-label={t("agentKeyInputLabel")}
                    value={keyInput.value} placeholder={settings.apiKeyConfigured ? "\u2022".repeat(12) : undefined}
                    autoComplete="new-password" minLength={32} maxLength={512}
                    onChange={(event) => setKeyInput({ value: event.target.value, mode: "draft" })}
                    onBlur={() => setKeyInput((current) => current.mode === "generated" ? { ...current, mode: "masked" } : current)}
                    disabled={busy} />
                  {canCopyKey ? (
                    <button type="button" className="secondary-button input-with-action-button"
                      aria-label={t(keyInput.copied ? "agentCopied" : "agentCopyKey")}
                      title={t(keyInput.copied ? "agentCopied" : "agentCopyKey")}
                      data-copied={keyInput.copied ? "true" : undefined} disabled={busy}
                      onClick={() => void copyKey()}>
                      <InterfaceIcon name={keyInput.copied ? "check" : "copy"} />
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="button-row">
                <button type="submit" className="primary-button" disabled={!canSaveKey}>{t("agentSaveKey")}</button>
                <button type="button" className="secondary-button" disabled={busy}
                  onClick={() => void save({ generateApiKey: true })}>{t(settings.apiKeyConfigured ? "agentRotateKey" : "agentGenerateKey")}</button>
                <button type="button" className="danger-button" disabled={busy || !settings.apiKeyConfigured}
                  onClick={() => void save({ clearApiKey: true })}>{t("agentRevokeKey")}</button>
              </div>
            </form>
            <p className="settings-helper-text">{t("agentKeyHint")}</p>
          </section>
          <section className="settings-module-group" aria-label={t("agentConfiguration")}>
            <div className="settings-heading-row">
              <div>
                <h4 className="settings-module-title">{t("agentConfiguration")}</h4>
                <p className="settings-helper-text">{t("agentConfigurationSummary")}</p>
              </div>
              <button type="button" className="secondary-button" onClick={() => setConfigurationOpen(true)}>
                {t("agentViewConfiguration")}
              </button>
            </div>
          </section>
        </>
      ) : null}
      {settings && examples ? (
        <AgentConfigurationModal
          open={configurationOpen}
          settings={settings}
          examples={examples}
          readOnly={readOnly}
          onReadOnlyChange={setReadOnly}
          onCopy={copy}
          onClose={() => setConfigurationOpen(false)}
        />
      ) : null}
    </SettingsModule>
  );
}

function AgentConfigurationModal({
  open,
  settings,
  examples,
  readOnly,
  onReadOnlyChange,
  onCopy,
  onClose,
}: {
  open: boolean;
  settings: Settings;
  examples: ReturnType<typeof buildAgentExamples>;
  readOnly: boolean;
  onReadOnlyChange: (value: boolean) => void;
  onCopy: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"configuration" | "capabilities">("configuration");
  const tabsId = useId();
  return (
    <DesktopModal
      open={open}
      title={t("agentConfiguration")}
      description={t("agentConfigurationModalDescription")}
      size="xwide"
      layout="form"
      className="settings-agent-configuration-modal"
      bodyClassName="settings-agent-configuration-modal-body"
      onClose={onClose}
      footer={(
        <ModalActions>
          <button type="button" className="secondary-button" onClick={onClose}>{t("actionClose")}</button>
        </ModalActions>
      )}
    >
      <div className="settings-agent-modal-tabs" role="tablist" aria-label={t("agentConfigurationTabs")}>
        <button
          type="button"
          role="tab"
          id={`${tabsId}-configuration-tab`}
          aria-controls={`${tabsId}-configuration-panel`}
          aria-selected={activeTab === "configuration"}
          className={`settings-agent-modal-tab${activeTab === "configuration" ? " active" : ""}`}
          onClick={() => setActiveTab("configuration")}
        >
          {t("agentConfigurationTab")}
        </button>
        <button
          type="button"
          role="tab"
          id={`${tabsId}-capabilities-tab`}
          aria-controls={`${tabsId}-capabilities-panel`}
          aria-selected={activeTab === "capabilities"}
          className={`settings-agent-modal-tab${activeTab === "capabilities" ? " active" : ""}`}
          onClick={() => setActiveTab("capabilities")}
        >
          {t("agentCapabilitiesTab")}
        </button>
      </div>
      {activeTab === "configuration" ? (
        <div id={`${tabsId}-configuration-panel`} className="settings-agent-tab-panel"
          role="tabpanel" aria-labelledby={`${tabsId}-configuration-tab`}>
          <ModalSection
            heading={t("agentConfigurationStepsTitle")}
            description={t("agentConfigurationStepsDescription")}
          >
            <ol className="settings-agent-steps">
              <li>{t("agentConfigurationStepKey")}</li>
              <li>{t("agentConfigurationStepClient")}</li>
              <li>{t("agentConfigurationStepRun")}</li>
            </ol>
          </ModalSection>
          <ModalSection
            heading={t("agentMcpExample")}
            description={t("agentMcpExampleDescription")}
            actions={(
              <button type="button" className="secondary-button" onClick={() => void onCopy(examples.mcp)}>
                {t("agentCopy")}
              </button>
            )}
          >
            <label className="settings-agent-access-field">
              <span>{t("agentAccessMode")}</span>
              <select value={readOnly ? "read" : "write"} onChange={(event) => onReadOnlyChange(event.target.value === "read")}>
                <option value="read">{t("agentReadOnly")}</option>
                <option value="write">{t("agentReadWrite")}</option>
              </select>
            </label>
            <pre className="settings-code-block" aria-label={t("agentMcpExample")}><code>{examples.mcp}</code></pre>
          </ModalSection>
          <ModalSection
            heading={t("agentCliExample")}
            description={t("agentCliExampleDescription")}
            actions={(
              <button type="button" className="secondary-button" onClick={() => void onCopy(examples.cli)}>
                {t("agentCopy")}
              </button>
            )}
          >
            <pre className="settings-code-block" aria-label={t("agentCliExample")}><code>{examples.cli}</code></pre>
          </ModalSection>
          <ModalSection
            heading={t("agentSkillTitle")}
            description={t("agentSkillHint")}
            actions={(
              <button type="button" className="secondary-button" onClick={() => void onCopy(examples.skill)}>
                {t("agentCopy")}
              </button>
            )}
          >
            <pre className="settings-code-block" aria-label={t("agentSkillCommands")}><code>{examples.skill}</code></pre>
            <p className="settings-helper-text">{t("agentSkillVerify")}</p>
          </ModalSection>
        </div>
      ) : (
        <div id={`${tabsId}-capabilities-panel`} className="settings-agent-tab-panel"
          role="tabpanel" aria-labelledby={`${tabsId}-capabilities-tab`}>
          <ModalSection
            heading={t("agentCapabilitiesTitle")}
            description={t("agentCapabilitiesDescription")}
          >
            {settings.capabilities?.length ? (
              <div className="settings-agent-capability-table-scroll">
                <table className="settings-agent-capability-table" aria-label={t("agentCapabilitiesTitle")}>
                  <thead>
                    <tr>
                      <th scope="col">{t("agentCapabilityNameHeader")}</th>
                      <th scope="col">{t("agentCapabilityPermissionHeader")}</th>
                      <th scope="col">{t("agentCapabilityDescriptionHeader")}</th>
                      <th scope="col">{t("agentCapabilityParametersHeader")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settings.capabilities.map((capability) => (
                      <tr key={capability.name}>
                        <th scope="row"><code>{capability.name}</code></th>
                        <td>
                          <span className="settings-agent-capability-tags">
                            <span className="settings-agent-capability-tag">{capability.readOnly ? t("agentCapabilityReadOnly") : t("agentCapabilityWrite")}</span>
                            {capability.requiresBinding ? <span className="settings-agent-capability-tag">{t("agentCapabilityRequiresLibrary")}</span> : null}
                            {capability.destructive ? <span className="settings-agent-capability-tag" data-tone="danger">{t("agentCapabilityDestructive")}</span> : null}
                          </span>
                        </td>
                        <td>{capability.description}</td>
                        <td>
                          {capability.parameters?.length ? (
                            <ul className="settings-agent-parameters">
                              {capability.parameters.map((parameter) => (
                                <li key={parameter.name}>
                                  <div className="settings-agent-parameter-heading">
                                    <code>{parameter.name}</code>
                                    <span className="settings-agent-parameter-type">{parameter.valueType}</span>
                                    {parameter.required ? <span className="settings-agent-parameter-required">{t("agentCapabilityRequiredParameter")}</span> : null}
                                  </div>
                                  {parameter.description ? <p>{parameter.description}</p> : null}
                                  {parameter.allowedValues.length ? (
                                    <span className="settings-agent-parameter-enum">
                                      {t("agentCapabilityAllowedValues", { values: parameter.allowedValues.join(", ") })}
                                    </span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          ) : <span className="settings-agent-no-parameters">{t("agentCapabilityNoParameters")}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <ModalEmptyState title={t("agentCapabilitiesUnavailable")} compact />
            )}
          </ModalSection>
        </div>
      )}
    </DesktopModal>
  );
}

function Example({ label, text, onCopy }: { label: string; text: string; onCopy: (text: string) => Promise<void> }) {
  return (
    <div className="settings-agent-form">
      <div className="settings-heading-row">
        <strong>{label}</strong>
        <button type="button" className="secondary-button" aria-label={`${t("agentCopy")} ${label}`}
          onClick={() => void onCopy(text)}>{t("agentCopy")}</button>
      </div>
      <pre className="settings-code-block" aria-label={label}><code>{text}</code></pre>
    </div>
  );
}
