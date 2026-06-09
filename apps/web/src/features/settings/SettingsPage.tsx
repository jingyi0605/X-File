import { useEffect, useState, type FormEvent } from "react";
import type {
  HttpServerState,
  LibraryBinding,
  LibraryConfig,
  OnlyOfficeSettings,
  OnlyOfficeStatus
} from "@x-file/shared";

import {
  getHttpServerState,
  getLibraryBinding,
  getLibraryConfig,
  getOnlyOfficeSettings,
  getOnlyOfficeStatus,
  saveHttpServerState,
  saveLibraryBinding,
  saveLibraryConfig,
  saveOnlyOfficeSettings
} from "../../api/library";
import { toApiErrorMessage } from "../../api/http";
import { t } from "../../i18n";
import { LanguageSwitcher } from "../../shared/i18n/LanguageSwitcher";
import { ThemeSwitcher } from "../../shared/theme/ThemeSwitcher";
import { formatDateTime, joinCommaList, splitCommaList } from "../../shared/format";

interface SettingsPageProps {
  onSaved?: () => void;
  onClose?: () => void;
}

interface BindingFormState {
  rootDir: string;
}

interface ConfigFormState {
  allowedExtensions: string;
  includedHiddenPaths: string;
  folderOpenBehavior: "single_click" | "double_click";
}

interface OnlyOfficeFormState {
  enabled: boolean;
  serverUrl: string;
  publicBaseUrl: string;
  callbackBaseUrl: string;
  userDisplayName: string;
  userAvatarUrl: string;
  jwtSecret: string;
  clearJwtSecret: boolean;
}

interface ServerFormState {
  enabled: boolean;
  persistent: boolean;
  port: string;
}

export function SettingsPage({ onSaved, onClose }: SettingsPageProps) {
  const [binding, setBinding] = useState<LibraryBinding | null>(null);
  const [libraryConfig, setLibraryConfig] = useState<LibraryConfig | null>(null);
  const [onlyOffice, setOnlyOffice] = useState<OnlyOfficeSettings | null>(null);
  const [onlyOfficeStatus, setOnlyOfficeStatus] = useState<OnlyOfficeStatus | null>(null);
  const [serverState, setServerState] = useState<HttpServerState | null>(null);
  const [bindingForm, setBindingForm] = useState<BindingFormState>({ rootDir: "" });
  const [configForm, setConfigForm] = useState<ConfigFormState>({
    allowedExtensions: "",
    includedHiddenPaths: "",
    folderOpenBehavior: "double_click"
  });
  const [onlyOfficeForm, setOnlyOfficeForm] = useState<OnlyOfficeFormState>({
    enabled: false,
    serverUrl: "",
    publicBaseUrl: "",
    callbackBaseUrl: "",
    userDisplayName: "",
    userAvatarUrl: "",
    jwtSecret: "",
    clearJwtSecret: false
  });
  const [serverForm, setServerForm] = useState<ServerFormState>({
    enabled: false,
    persistent: false,
    port: "17321"
  });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [configUnavailable, setConfigUnavailable] = useState<string | null>(null);
  const [serverUnavailable, setServerUnavailable] = useState<string | null>(null);

  async function loadSettings(): Promise<void> {
    setLoading(true);
    setError(null);
    setConfigUnavailable(null);
    setServerUnavailable(null);

    try {
      const nextBinding = await getLibraryBinding();
      setBinding(nextBinding);
      setBindingForm({ rootDir: nextBinding?.rootDir ?? "" });
    } catch (err) {
      setError(toApiErrorMessage(err));
    }

    try {
      const config = await getLibraryConfig();
      applyConfig(config);
    } catch (err) {
      setConfigUnavailable(toApiErrorMessage(err));
    }

    try {
      const settings = await getOnlyOfficeSettings();
      applyOnlyOffice(settings);
      setOnlyOfficeStatus(await getOnlyOfficeStatus());
    } catch (err) {
      setError((current) => current ?? toApiErrorMessage(err));
    }

    try {
      const state = await getHttpServerState();
      applyServerState(state);
    } catch (err) {
      setServerUnavailable(toApiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  async function submitBinding(event: FormEvent): Promise<void> {
    event.preventDefault();
    const rootDir = bindingForm.rootDir.trim();
    if (!rootDir) {
      setError(t("settingsRequiredRootDir"));
      return;
    }

    try {
      setError(null);
      const saved = await saveLibraryBinding({ rootDir });
      setBinding(saved);
      setMessage(t("settingsSaveSuccess"));
      onSaved?.();
    } catch (err) {
      setError(toApiErrorMessage(err));
    }
  }

  async function submitConfig(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      setError(null);
      const saved = await saveLibraryConfig({
        allowedExtensions: splitCommaList(configForm.allowedExtensions),
        includedHiddenPaths: splitCommaList(configForm.includedHiddenPaths),
        folderOpenBehavior: configForm.folderOpenBehavior
      });
      applyConfig(saved);
      setMessage(t("settingsSaveSuccess"));
      onSaved?.();
    } catch (err) {
      setError(toApiErrorMessage(err));
    }
  }

  async function submitOnlyOffice(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      setError(null);
      const saved = await saveOnlyOfficeSettings({
        enabled: onlyOfficeForm.enabled,
        serverUrl: normalizeOptionalUrl(onlyOfficeForm.serverUrl),
        publicBaseUrl: normalizeOptionalUrl(onlyOfficeForm.publicBaseUrl),
        callbackBaseUrl: normalizeOptionalUrl(onlyOfficeForm.callbackBaseUrl),
        userDisplayName: normalizeOptionalText(onlyOfficeForm.userDisplayName),
        userAvatarUrl: normalizeOptionalUrl(onlyOfficeForm.userAvatarUrl),
        jwtSecret: onlyOfficeForm.jwtSecret.trim() || null,
        clearJwtSecret: onlyOfficeForm.clearJwtSecret
      });
      applyOnlyOffice(saved);
      setOnlyOfficeStatus(await getOnlyOfficeStatus());
      setMessage(t("settingsSaveSuccess"));
    } catch (err) {
      setError(toApiErrorMessage(err));
    }
  }

  async function submitServer(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      setError(null);
      const saved = await saveHttpServerState({
        enabled: serverForm.enabled,
        persistent: serverForm.persistent,
        port: Number(serverForm.port)
      });
      applyServerState(saved);
      setMessage(t("settingsSaveSuccess"));
    } catch (err) {
      setError(toApiErrorMessage(err));
    }
  }

  function applyConfig(config: LibraryConfig): void {
    setLibraryConfig(config);
    setConfigForm({
      allowedExtensions: joinCommaList(config.allowedExtensions),
      includedHiddenPaths: joinCommaList(config.includedHiddenPaths),
      folderOpenBehavior: config.folderOpenBehavior
    });
  }

  function applyOnlyOffice(settings: OnlyOfficeSettings): void {
    setOnlyOffice(settings);
    setOnlyOfficeForm({
      enabled: settings.enabled,
      serverUrl: settings.serverUrl ?? "",
      publicBaseUrl: settings.publicBaseUrl ?? "",
      callbackBaseUrl: settings.callbackBaseUrl ?? "",
      userDisplayName: settings.userDisplayName ?? "",
      userAvatarUrl: settings.userAvatarUrl ?? "",
      jwtSecret: "",
      clearJwtSecret: false
    });
  }

  function applyServerState(state: HttpServerState): void {
    setServerState(state);
    setServerForm({
      enabled: state.enabled,
      persistent: state.persistent,
      port: String(state.port)
    });
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  const content = (
    <main className="settings-page">
      <section className="page-heading">
        <div>
          <p className="eyebrow">{t("navSettings")}</p>
          <h1>{t("settingsTitle")}</h1>
          <p className="page-subtitle">{t("settingsSubtitle")}</p>
        </div>
        <button type="button" className="secondary-button" onClick={() => void loadSettings()}>
          {loading ? t("healthChecking") : t("libraryReload")}
        </button>
      </section>

      {message ? <section className="inline-success">{message}</section> : null}
      {error ? <section className="inline-alert">{error}</section> : null}

      <section className="settings-section settings-appearance-section">
        <h2>{t("settingsAppearanceTitle")}</h2>
        <p>{t("settingsAppearanceDescription")}</p>
        <div className="settings-appearance-grid">
          <div className="settings-appearance-card">
            <h3>{t("settingsLanguageTitle")}</h3>
            <p>{t("settingsLanguageDescription")}</p>
            <LanguageSwitcher />
          </div>
          <div className="settings-appearance-card">
            <h3>{t("settingsThemeTitle")}</h3>
            <p>{t("settingsThemeDescription")}</p>
            <ThemeSwitcher />
          </div>
        </div>
      </section>

      <section className="settings-grid">
        <form className="settings-section" onSubmit={(event) => void submitBinding(event)}>
          <h2>{t("settingsBindingTitle")}</h2>
          <p>{t("settingsBindingDescription")}</p>
          <label>
            <span>{t("settingsRootDir")}</span>
            <input
              value={bindingForm.rootDir}
              placeholder={t("settingsRootDirPlaceholder")}
              onChange={(event) => setBindingForm({ rootDir: event.target.value })}
            />
          </label>
          <div className="settings-current">
            <span>{t("libraryStatusTitle")}</span>
            <strong>{binding?.enabled ? t("libraryStatusFresh") : t("commonNotSet")}</strong>
          </div>
          <button type="submit" className="primary-button">{t("settingsSaveBinding")}</button>
        </form>

        <form className="settings-section" onSubmit={(event) => void submitConfig(event)}>
          <h2>{t("settingsConfigTitle")}</h2>
          <p>{t("settingsConfigDescription")}</p>
          {configUnavailable ? <div className="inline-note">{t("settingsConfigUnavailable")} {configUnavailable}</div> : null}
          <label>
            <span>{t("settingsAllowedExtensions")}</span>
            <textarea
              value={configForm.allowedExtensions}
              placeholder={t("settingsAllowedExtensionsHint")}
              onChange={(event) => setConfigForm((current) => ({ ...current, allowedExtensions: event.target.value }))}
            />
          </label>
          <label>
            <span>{t("settingsIncludedHiddenPaths")}</span>
            <textarea
              value={configForm.includedHiddenPaths}
              placeholder={t("settingsIncludedHiddenPathsHint")}
              onChange={(event) => setConfigForm((current) => ({ ...current, includedHiddenPaths: event.target.value }))}
            />
          </label>
          <label>
            <span>{t("settingsFolderOpenBehavior")}</span>
            <select
              value={configForm.folderOpenBehavior}
              onChange={(event) => setConfigForm((current) => ({ ...current, folderOpenBehavior: event.target.value as ConfigFormState["folderOpenBehavior"] }))}
            >
              <option value="double_click">{t("settingsDoubleClick")}</option>
              <option value="single_click">{t("settingsSingleClick")}</option>
            </select>
          </label>
          <div className="settings-current">
            <span>{t("libraryMetaPath")}</span>
            <strong>{libraryConfig?.configRelativePath ?? t("commonNotSet")}</strong>
          </div>
          <button type="submit" className="primary-button" disabled={Boolean(configUnavailable)}>
            {t("settingsSaveConfig")}
          </button>
        </form>

        <form className="settings-section" onSubmit={(event) => void submitOnlyOffice(event)}>
          <h2>{t("settingsOnlyOfficeTitle")}</h2>
          <p>{t("settingsOnlyOfficeDescription")}</p>
          <label className="switch-row">
            <span>{t("settingsOnlyOfficeEnabled")}</span>
            <input
              type="checkbox"
              checked={onlyOfficeForm.enabled}
              onChange={(event) => setOnlyOfficeForm((current) => ({ ...current, enabled: event.target.checked }))}
            />
          </label>
          <TextInput label={t("settingsOnlyOfficeServerUrl")} value={onlyOfficeForm.serverUrl} onChange={(value) => setOnlyOfficeForm((current) => ({ ...current, serverUrl: value }))} />
          <TextInput label={t("settingsOnlyOfficePublicBaseUrl")} value={onlyOfficeForm.publicBaseUrl} onChange={(value) => setOnlyOfficeForm((current) => ({ ...current, publicBaseUrl: value }))} />
          <TextInput label={t("settingsOnlyOfficeCallbackBaseUrl")} value={onlyOfficeForm.callbackBaseUrl} onChange={(value) => setOnlyOfficeForm((current) => ({ ...current, callbackBaseUrl: value }))} />
          <TextInput label={t("settingsOnlyOfficeUserName")} value={onlyOfficeForm.userDisplayName} onChange={(value) => setOnlyOfficeForm((current) => ({ ...current, userDisplayName: value }))} />
          <TextInput label={t("settingsOnlyOfficeAvatar")} value={onlyOfficeForm.userAvatarUrl} onChange={(value) => setOnlyOfficeForm((current) => ({ ...current, userAvatarUrl: value }))} />
          <TextInput label={t("settingsOnlyOfficeJwtSecret")} value={onlyOfficeForm.jwtSecret} placeholder={t("settingsOnlyOfficeJwtPlaceholder")} onChange={(value) => setOnlyOfficeForm((current) => ({ ...current, jwtSecret: value }))} />
          <label className="switch-row">
            <span>{t("settingsOnlyOfficeClearJwt")}</span>
            <input
              type="checkbox"
              checked={onlyOfficeForm.clearJwtSecret}
              onChange={(event) => setOnlyOfficeForm((current) => ({ ...current, clearJwtSecret: event.target.checked }))}
            />
          </label>
          <div className="settings-current">
            <span>{t("settingsOnlyOfficeStatus")}</span>
            <strong>{onlyOfficeStatus?.summary ?? t("commonUnknown")}</strong>
          </div>
          <div className="settings-current">
            <span>{t("settingsOnlyOfficeJwtSecret")}</span>
            <strong>{onlyOffice?.jwtSecretConfigured ? t("settingsOnlyOfficeJwtConfigured") : t("settingsOnlyOfficeJwtNotConfigured")}</strong>
          </div>
          <div className="button-row">
            <button type="submit" className="primary-button">{t("settingsOnlyOfficeSave")}</button>
            <button type="button" className="secondary-button" onClick={() => void getOnlyOfficeStatus().then(setOnlyOfficeStatus).catch((err) => setError(toApiErrorMessage(err)))}>
              {t("settingsOnlyOfficeRefreshStatus")}
            </button>
          </div>
        </form>

        <form className="settings-section" onSubmit={(event) => void submitServer(event)}>
          <h2>{t("settingsServerTitle")}</h2>
          <p>{t("settingsServerDescription")}</p>
          {serverUnavailable ? <div className="inline-note">{t("settingsServerUnavailable")} {serverUnavailable}</div> : null}
          <label className="switch-row">
            <span>{t("settingsServerEnabled")}</span>
            <input
              type="checkbox"
              checked={serverForm.enabled}
              onChange={(event) => setServerForm((current) => ({ ...current, enabled: event.target.checked }))}
            />
          </label>
          <label className="switch-row">
            <span>{t("settingsServerPersistent")}</span>
            <input
              type="checkbox"
              checked={serverForm.persistent}
              onChange={(event) => setServerForm((current) => ({ ...current, persistent: event.target.checked }))}
            />
          </label>
          <label>
            <span>{t("settingsServerPort")}</span>
            <input
              type="number"
              min="1"
              max="65535"
              value={serverForm.port}
              onChange={(event) => setServerForm((current) => ({ ...current, port: event.target.value }))}
            />
          </label>
          <ServerStatus state={serverState} />
          <div className="button-row">
            <button type="submit" className="primary-button" disabled={Boolean(serverUnavailable)}>
              {t("settingsServerSave")}
            </button>
            <button type="button" className="secondary-button" onClick={() => void getHttpServerState().then(applyServerState).catch((err) => setServerUnavailable(toApiErrorMessage(err)))}>
              {t("settingsServerRefresh")}
            </button>
          </div>
        </form>
      </section>
    </main>
  );

  if (!onClose) {
    return content;
  }

  return (
    <div className="desktop-modal-layer settings-modal-layer" role="presentation" onPointerDown={onClose}>
      <section className="desktop-modal-card settings-modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title" onPointerDown={(event) => event.stopPropagation()}>
        <header className="desktop-modal-header">
          <div>
            <h2 id="settings-modal-title">{t("settingsTitle")}</h2>
            <p>{t("settingsSubtitle")}</p>
          </div>
          <button type="button" className="desktop-modal-close" aria-label={t("actionClose")} onClick={onClose}>×</button>
        </header>
        <div className="desktop-modal-body settings-modal-body">{content}</div>
      </section>
    </div>
  );
}

function TextInput({
  label,
  value,
  placeholder,
  onChange
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ServerStatus({ state }: { state: HttpServerState | null }) {
  return (
    <div className="server-status">
      <div><span>{t("settingsServerHost")}</span><strong>{state?.host ?? t("commonUnknown")}</strong></div>
      <div><span>{t("settingsServerPort")}</span><strong>{state?.port ?? t("commonUnknown")}</strong></div>
      <div><span>{t("settingsServerRunning")}</span><strong>{state?.running ? t("settingsServerRunning") : t("settingsServerStopped")}</strong></div>
      <div><span>{t("settingsServerLifecycle")}</span><strong>{state?.lifecycleState ?? t("commonUnknown")}</strong></div>
      <div><span>{t("settingsServerStartedAt")}</span><strong>{formatDateTime(state?.startedAt)}</strong></div>
      <div><span>{t("settingsServerLastError")}</span><strong>{state?.lastError ?? t("commonNone")}</strong></div>
    </div>
  );
}

function normalizeOptionalUrl(value: string): string | null {
  return normalizeOptionalText(value);
}

function normalizeOptionalText(value: string): string | null {
  const normalized = value.trim();
  return normalized ? normalized : null;
}
