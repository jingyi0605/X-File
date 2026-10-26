import { useEffect, useState } from "react";
import type { AgentIntegrationSettings as Settings, SaveAgentIntegrationSettingsInput } from "@x-file/shared";

import { t } from "../../i18n";
import { toApiErrorMessage } from "../../api/http";
import { SettingsModule } from "./SettingsModule";
import {
  getNativeAgentIntegrationSettings,
  saveNativeAgentIntegrationSettings,
} from "../../runtime/native-library-bridge";

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

export function AgentIntegrationSettings({ mirrorMode }: { mirrorMode: boolean }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState("");
  const [generatedKey, setGeneratedKey] = useState("");
  const [readOnly, setReadOnly] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setSettings(null);
    setGeneratedKey("");
    setKey("");
    setError("");
    if (mirrorMode) {
      setLoading(false);
      return;
    }
    void getNativeAgentIntegrationSettings()
      .then((value) => { if (active) setSettings(value); })
      .catch((reason) => { if (active) setError(toApiErrorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mirrorMode]);

  async function save(input: SaveAgentIntegrationSettingsInput) {
    setBusy(true);
    setError("");
    setMessage("");
    // 每次修改都移除上一次的一次性明文。
    setGeneratedKey("");
    try {
      const result = await saveNativeAgentIntegrationSettings(input);
      if (!result) throw new Error(t("agentUnavailable"));
      setSettings(result.settings);
      setKey("");
      setGeneratedKey(result.apiKey ?? "");
      setMessage(t("agentSaved"));
    } catch (reason) {
      setError(toApiErrorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage(t("agentCopied"));
    } catch {
      setError(t("agentCopyFailed"));
    }
  }

  const examples = settings ? buildAgentExamples(settings, readOnly) : null;
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
      {!loading && !mirrorMode && !settings ? <p className="inline-note">{t("agentUnavailable")}</p> : null}
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
              void save({ apiKey: key });
            }}>
              <label>
                <span>{t("agentKeyLabel")}</span>
                <input type="password" value={key} autoComplete="new-password" minLength={32} maxLength={512}
                  onChange={(event) => setKey(event.target.value)} disabled={busy} />
              </label>
              <div className="button-row">
                <button type="submit" className="primary-button" disabled={busy || key.length < 32}>{t("agentSaveKey")}</button>
                <button type="button" className="secondary-button" disabled={busy}
                  onClick={() => void save({ generateApiKey: true })}>{t(settings.apiKeyConfigured ? "agentRotateKey" : "agentGenerateKey")}</button>
                <button type="button" className="danger-button" disabled={busy || !settings.apiKeyConfigured}
                  onClick={() => void save({ clearApiKey: true })}>{t("agentRevokeKey")}</button>
              </div>
            </form>
            <p className="settings-helper-text">{t("agentKeyHint")}</p>
            {generatedKey ? (
              <div className="settings-agent-form">
                <label><span>{t("agentKeyOnce")}</span><input type="password" readOnly value={generatedKey} /></label>
                <div className="button-row">
                  <button type="button" className="secondary-button" onClick={() => void copy(generatedKey)}>{t("agentCopyKey")}</button>
                  <button type="button" className="secondary-button" onClick={() => setGeneratedKey("")}>{t("agentDismissKey")}</button>
                </div>
              </div>
            ) : null}
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
