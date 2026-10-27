import { useEffect, useId, useRef, useState } from "react";
import type { AgentIntegrationSettings as Settings, SaveAgentIntegrationSettingsInput } from "@x-file/shared";

import { t } from "../../i18n";
import { ApiClientError, resolveApiUrl, toApiErrorMessage } from "../../api/http";
import { InterfaceIcon } from "../../shared/InterfaceIcon";
import { SettingsModule } from "./SettingsModule";
import {
  AGENT_SETTINGS_PATH,
  getAgentIntegrationSettings,
  saveAgentIntegrationSettings,
  usesNativeAgentSettings,
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
  const native = usesNativeAgentSettings();
  const target = native ? "native" : new URL(resolveApiUrl(AGENT_SETTINGS_PATH), window.location.href).href;
  // 主机或模式变化时卸载表单，防止旧主机的令牌、密钥和异步结果流入新主机。
  return <AgentIntegrationForm key={`${runtime.mode}:${target}`} native={native}
    target={native ? t("agentLocalHost") : new URL(target).origin} mirrorMode={runtime.mode === "mirror"} />;
}

function AgentIntegrationForm({ native, target, mirrorMode }: { native: boolean; target: string; mirrorMode: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [keyInput, setKeyInput] = useState<ApiKeyInputState>({ value: "", mode: "draft" });
  const keyInputRef = useRef<HTMLInputElement>(null);
  const keyInputId = useId();
  const [readOnly, setReadOnly] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [connection, setConnection] = useState({ token: "", revision: 0 });
  const tokenInputId = useId();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSettings(null);
    setKeyInput({ value: "", mode: "draft" });
    setError("");
    setMessage("");
    void getAgentIntegrationSettings(connection.token)
      .then((value) => { if (active) setSettings(value); })
      .catch((reason) => {
        if (active) setError(reason instanceof ApiClientError && reason.status === 404
          ? t("agentUnavailable") : toApiErrorMessage(reason));
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [connection]);

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
      const result = await saveAgentIntegrationSettings(input, connection.token);
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
      <p className="settings-helper-text">{t("agentTargetHost", { host: target })}</p>
      {!native ? (
        <form className="settings-agent-form" onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !loading) setConnection((current) => ({ token: tokenDraft.trim(), revision: current.revision + 1 }));
        }}>
          <div className="modal-field">
            <label htmlFor={tokenInputId}>{t("agentManagementToken")}</label>
            <input id={tokenInputId} type="password" value={tokenDraft} autoComplete="off" maxLength={512}
              onChange={(event) => setTokenDraft(event.target.value)} disabled={busy || loading} />
          </div>
          <p className="settings-helper-text">{t("agentManagementHint")}</p>
          <div className="button-row">
            <button type="submit" className="secondary-button" disabled={busy || loading}>{t("agentConnect")}</button>
          </div>
        </form>
      ) : null}
      {loading ? <p>{t("agentLoading")}</p> : null}
      {mirrorMode ? <p className="inline-note">{t("agentMirrorNotice")}</p> : null}
      {settings && examples ? (
        <>
          <section className="settings-module-group" aria-label="API Key">
            <div className="settings-heading-row">
              <h4 className="settings-module-title">API Key</h4>
              <span className="settings-module-status">{t(settings.apiKeyConfigured ? "agentKeyConfigured" : "agentKeyMissing")}</span>
            </div>
            <p className="settings-helper-text">{t("agentGateHint")}</p>
            <form className="settings-agent-form" onSubmit={(event) => {
              event.preventDefault();
              if (canSaveKey) void save({ apiKey: keyInput.value });
            }}>
              <div className="modal-field">
                <label htmlFor={keyInputId}>{t("agentKeyLabel")}</label>
                <div className="input-with-action" data-has-action={canCopyKey ? "true" : undefined}>
                  <input id={keyInputId} ref={keyInputRef} type={keyInput.mode === "generated" ? "text" : "password"}
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
            <h4 className="settings-module-title">{t("agentConfiguration")}</h4>
            <p className="settings-helper-text">{t("agentConfigHint")}</p>
            <label>
              <span>{t("agentAccessMode")}</span>
              <select value={readOnly ? "read" : "write"} onChange={(event) => setReadOnly(event.target.value === "read")}>
                <option value="read">{t("agentReadOnly")}</option>
                <option value="write">{t("agentReadWrite")}</option>
              </select>
            </label>
            <Example label={t("agentMcpExample")} text={examples.mcp} onCopy={copy} />
            <Example label={t("agentCliExample")} text={examples.cli} onCopy={copy} />
          </section>
          <section className="settings-module-group" aria-label={t("agentSkillTitle")}>
            <h4 className="settings-module-title">{t("agentSkillTitle")}</h4>
            <p className="settings-helper-text">{t("agentSkillHint")}</p>
            <Example label={t("agentSkillCommands")} text={examples.skill} onCopy={copy} />
            <p className="settings-helper-text">{t("agentSkillVerify")}</p>
          </section>
        </>
      ) : null}
    </SettingsModule>
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
