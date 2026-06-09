import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  HostDirectoryOption,
  HttpServerState,
  LibraryIndexStatus,
  LibraryBinding,
  LibraryConfig,
  OnlyOfficeSettings,
  OnlyOfficeStatus
} from "@x-file/shared";

import {
  browseHostDirectories,
  getHttpServerState,
  getLibraryBinding,
  getLibraryConfig,
  getLibrarySnapshot,
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
import { formatDateTime } from "../../shared/format";
import { DesktopModal, ModalActions } from "../../shared/modal";

interface SettingsPageProps {
  onSaved?: () => void;
  onClose?: () => void;
}

interface BindingFormState {
  rootDir: string;
}

interface ConfigFormState {
  allowedExtensions: string[];
  includedHiddenPaths: string;
  folderOpenBehavior: "single_click" | "double_click";
  manualExtension: string;
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

type SettingsTabId = "appearance" | "library" | "integration" | "network" | "updates";

const LIBRARY_PRESET_EXTENSIONS = [
  ".md",
  ".markdown",
  ".txt",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".csv",
  ".json",
  ".html",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp"
] as const;

const SETTINGS_TABS: Array<{
  id: SettingsTabId;
  titleKey: string;
  descriptionKey: string;
}> = [
  {
    id: "appearance",
    titleKey: "settingsTabAppearance",
    descriptionKey: "settingsTabAppearanceDescription"
  },
  {
    id: "library",
    titleKey: "settingsTabLibrary",
    descriptionKey: "settingsTabLibraryDescription"
  },
  {
    id: "integration",
    titleKey: "settingsTabIntegration",
    descriptionKey: "settingsTabIntegrationDescription"
  },
  {
    id: "network",
    titleKey: "settingsTabNetwork",
    descriptionKey: "settingsTabNetworkDescription"
  },
  {
    id: "updates",
    titleKey: "settingsTabUpdates",
    descriptionKey: "settingsTabUpdatesDescription"
  }
];

export function SettingsPage({ onSaved, onClose }: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("appearance");
  const [binding, setBinding] = useState<LibraryBinding | null>(null);
  const [libraryConfig, setLibraryConfig] = useState<LibraryConfig | null>(null);
  const [libraryIndexStatus, setLibraryIndexStatus] = useState<LibraryIndexStatus | null>(null);
  const [onlyOffice, setOnlyOffice] = useState<OnlyOfficeSettings | null>(null);
  const [onlyOfficeStatus, setOnlyOfficeStatus] = useState<OnlyOfficeStatus | null>(null);
  const [serverState, setServerState] = useState<HttpServerState | null>(null);
  const [bindingForm, setBindingForm] = useState<BindingFormState>({ rootDir: "" });
  const [configForm, setConfigForm] = useState<ConfigFormState>({
    allowedExtensions: [...LIBRARY_PRESET_EXTENSIONS],
    includedHiddenPaths: "",
    folderOpenBehavior: "double_click",
    manualExtension: ""
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
  const [directoryBrowserOpen, setDirectoryBrowserOpen] = useState(false);
  const [directoryBrowserLoading, setDirectoryBrowserLoading] = useState(false);
  const [directoryBrowserError, setDirectoryBrowserError] = useState<string | null>(null);
  const [directoryBrowserCurrentPath, setDirectoryBrowserCurrentPath] = useState("");
  const [directoryBrowserInputPath, setDirectoryBrowserInputPath] = useState("");
  const [directoryBrowserParentPath, setDirectoryBrowserParentPath] = useState<string | null>(null);
  const [directoryBrowserRoots, setDirectoryBrowserRoots] = useState<HostDirectoryOption[]>([]);
  const [directoryBrowserItems, setDirectoryBrowserItems] = useState<HostDirectoryOption[]>([]);

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
      const snapshot = await getLibrarySnapshot();
      setLibraryIndexStatus(snapshot.status);
    } catch (err) {
      setError((current) => current ?? toApiErrorMessage(err));
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
      const snapshot = await getLibrarySnapshot();
      setLibraryIndexStatus(snapshot.status);
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
        allowedExtensions: shouldPersistImplicitAllowedExtensions(
          libraryConfig?.allowedExtensions ?? [],
          configForm.allowedExtensions
        )
          ? []
          : sortAllowedExtensions(configForm.allowedExtensions),
        includedHiddenPaths: parseIncludedHiddenPaths(configForm.includedHiddenPaths),
        folderOpenBehavior: configForm.folderOpenBehavior
      });
      applyConfig(saved);
      setLibraryIndexStatus(saved.applyConfigStatus ?? libraryIndexStatus);
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
      allowedExtensions: resolveEditableAllowedExtensions(config.allowedExtensions),
      includedHiddenPaths: sortIncludedHiddenPaths(config.includedHiddenPaths).join("\n"),
      folderOpenBehavior: config.folderOpenBehavior,
      manualExtension: ""
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

  async function loadHostDirectory(targetPath?: string | null): Promise<void> {
    setDirectoryBrowserLoading(true);
    setDirectoryBrowserError(null);

    try {
      const snapshot = await browseHostDirectories(targetPath);
      setDirectoryBrowserCurrentPath(snapshot.currentPath);
      setDirectoryBrowserInputPath(snapshot.currentPath);
      setDirectoryBrowserParentPath(snapshot.parentPath);
      setDirectoryBrowserRoots(snapshot.roots);
      setDirectoryBrowserItems(snapshot.items);
    } catch (err) {
      setDirectoryBrowserCurrentPath("");
      setDirectoryBrowserParentPath(null);
      setDirectoryBrowserItems([]);
      setDirectoryBrowserError(toApiErrorMessage(err));
    } finally {
      setDirectoryBrowserLoading(false);
    }
  }

  function openDirectoryBrowser(): void {
    setDirectoryBrowserOpen(true);
    void loadHostDirectory(bindingForm.rootDir.trim() || undefined);
  }

  function closeDirectoryBrowser(): void {
    if (directoryBrowserLoading) {
      return;
    }

    setDirectoryBrowserOpen(false);
    setDirectoryBrowserError(null);
  }

  function applyDirectoryBrowserCurrentPath(): void {
    if (!directoryBrowserCurrentPath) {
      return;
    }

    setBindingForm({ rootDir: directoryBrowserCurrentPath });
    setDirectoryBrowserOpen(false);
    setDirectoryBrowserError(null);
  }

  function toggleAllowedExtension(extension: string): void {
    setConfigForm((current) => {
      const normalizedExtension = normalizeExtensionToken(extension);
      if (!normalizedExtension) {
        return current;
      }
      const selected = current.allowedExtensions.includes(normalizedExtension);
      return {
        ...current,
        allowedExtensions: selected
          ? current.allowedExtensions.filter((item) => item !== normalizedExtension)
          : sortAllowedExtensions([...current.allowedExtensions, normalizedExtension])
      };
    });
  }

  function addManualExtension(): void {
    const extension = normalizeExtensionToken(configForm.manualExtension);
    if (!extension) {
      setError(t("settingsAllowedExtensionsCustomInvalid"));
      return;
    }
    setConfigForm((current) => ({
      ...current,
      manualExtension: "",
      allowedExtensions: current.allowedExtensions.includes(extension)
        ? current.allowedExtensions
        : sortAllowedExtensions([...current.allowedExtensions, extension])
    }));
    setError(null);
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  const tabPanels: Record<SettingsTabId, ReactNode> = {
    appearance: (
      <section className="settings-section settings-appearance-section">
        <h2>{t("settingsAppearanceTitle")}</h2>
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
    ),
    library: (
      <section className="settings-grid">
        <form className="settings-section" onSubmit={(event) => void submitBinding(event)}>
          <h2>{t("settingsBindingTitle")}</h2>
          <label>
            <span>{t("settingsRootDir")}</span>
            <div className="library-init-path-row">
              <input
                value={bindingForm.rootDir || t("settingsRootDirNotSelected")}
                readOnly
                aria-readonly="true"
              />
              <button type="button" className="secondary-button" onClick={openDirectoryBrowser}>
                {t("hostDirectoryBrowseAction")}
              </button>
            </div>
          </label>
          <LibraryIndexStatusCard binding={binding} status={libraryIndexStatus} />
          <button type="submit" className="primary-button">{t("settingsSaveBinding")}</button>
        </form>

        <form className="settings-section" onSubmit={(event) => void submitConfig(event)}>
          <h2>{t("settingsConfigTitle")}</h2>
          {configUnavailable ? <div className="inline-note">{t("settingsConfigUnavailable")} {configUnavailable}</div> : null}
          <div className="affairs-library-settings-form">
            <section className="affairs-library-config-section">
              <div className="affairs-library-behavior-switch-row">
                <span className="affairs-library-behavior-switch-title">{t("settingsFolderOpenBehavior")}</span>
                <MacSwitch
                  checked={configForm.folderOpenBehavior === "single_click"}
                  label={t("settingsFolderOpenBehavior")}
                  onChange={(checked) => setConfigForm((current) => ({ ...current, folderOpenBehavior: checked ? "single_click" : "double_click" }))}
                />
              </div>
              <span className="settings-helper-text">
                {configForm.folderOpenBehavior === "single_click" ? t("settingsSingleClick") : t("settingsDoubleClick")}
              </span>
            </section>
            <label>
              <span>{t("settingsIncludedHiddenPaths")}</span>
              <textarea
                value={configForm.includedHiddenPaths}
                placeholder={t("settingsIncludedHiddenPathsHint")}
                rows={4}
                onChange={(event) => setConfigForm((current) => ({ ...current, includedHiddenPaths: event.target.value }))}
              />
            </label>
            <label>
              <span>{t("settingsAllowedExtensions")}</span>
              <div className="affairs-extension-chip-list">
                {buildAllowedExtensionOptions(configForm.allowedExtensions).map((extension) => {
                  const selected = configForm.allowedExtensions.includes(extension);
                  const preset = LIBRARY_PRESET_EXTENSIONS.includes(extension as typeof LIBRARY_PRESET_EXTENSIONS[number]);
                  return (
                    <button
                      key={extension}
                      type="button"
                      className={selected ? "affairs-extension-chip active" : "affairs-extension-chip"}
                      aria-pressed={selected}
                      data-selected={selected ? "true" : "false"}
                      onClick={() => toggleAllowedExtension(extension)}
                    >
                      <span>{extension}</span>
                      {!preset ? <span className="affairs-extension-chip-badge">{t("settingsAllowedExtensionsCustomBadge")}</span> : null}
                    </button>
                  );
                })}
              </div>
            </label>
            <div className="affairs-extension-manual-row">
              <input
                value={configForm.manualExtension}
                placeholder={t("settingsAllowedExtensionsCustomPlaceholder")}
                onChange={(event) => setConfigForm((current) => ({ ...current, manualExtension: event.target.value }))}
              />
              <button type="button" className="secondary-button" onClick={addManualExtension}>
                {t("settingsAllowedExtensionsCustomAdd")}
              </button>
            </div>
          </div>
          <button type="submit" className="primary-button" disabled={Boolean(configUnavailable)}>
            {t("settingsSaveConfig")}
          </button>
        </form>
      </section>
    ),
    integration: (
      <form className="settings-section" onSubmit={(event) => void submitOnlyOffice(event)}>
          <h2>{t("settingsOnlyOfficeTitle")}</h2>
          <div className="settings-instance-card">
            <span>{t("settingsOnlyOfficeInstance")}</span>
            <strong>{onlyOfficeForm.serverUrl || t("commonNotSet")}</strong>
          </div>
          <label className="switch-row">
            <span>{t("settingsOnlyOfficeEnabled")}</span>
            <MacSwitch
              checked={onlyOfficeForm.enabled}
              label={t("settingsOnlyOfficeEnabled")}
              onChange={(checked) => setOnlyOfficeForm((current) => ({ ...current, enabled: checked }))}
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
            <MacSwitch
              checked={onlyOfficeForm.clearJwtSecret}
              label={t("settingsOnlyOfficeClearJwt")}
              onChange={(checked) => setOnlyOfficeForm((current) => ({ ...current, clearJwtSecret: checked }))}
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
    ),
    network: (
      <form className="settings-section" onSubmit={(event) => void submitServer(event)}>
          <h2>{t("settingsServerTitle")}</h2>
          {serverUnavailable ? <div className="inline-note">{t("settingsServerUnavailable")} {serverUnavailable}</div> : null}
          <label className="switch-row">
            <span>{t("settingsServerEnabled")}</span>
            <MacSwitch
              checked={serverForm.enabled}
              label={t("settingsServerEnabled")}
              onChange={(checked) => setServerForm((current) => ({ ...current, enabled: checked }))}
            />
          </label>
          <label className="switch-row">
            <span>{t("settingsServerPersistent")}</span>
            <MacSwitch
              checked={serverForm.persistent}
              label={t("settingsServerPersistent")}
              onChange={(checked) => setServerForm((current) => ({ ...current, persistent: checked }))}
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
    ),
    updates: (
      <section className="settings-section">
        <h2>{t("settingsUpdatesTitle")}</h2>
        <div className="modal-empty-state" data-compact="true">
          <strong className="modal-empty-state-title">{t("settingsUpdatesPendingTitle")}</strong>
          <p className="modal-empty-state-description">{t("settingsUpdatesPendingDescription")}</p>
        </div>
      </section>
    )
  };

  const content = (
    <main className="settings-page">
      <section className="page-heading">
        <div>
          <p className="eyebrow">{t("navSettings")}</p>
          <h1>{t("settingsTitle")}</h1>
        </div>
        <button type="button" className="secondary-button" onClick={() => void loadSettings()}>
          {loading ? t("healthChecking") : t("libraryReload")}
        </button>
      </section>

      <nav className="settings-tabbar" role="tablist" aria-label={t("settingsTitle")}>
        {SETTINGS_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            id={`settings-tab-${tab.id}`}
            className={activeTab === tab.id ? "settings-tab active" : "settings-tab"}
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`settings-panel-${tab.id}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{t(tab.titleKey)}</span>
            <small>{t(tab.descriptionKey)}</small>
          </button>
        ))}
      </nav>

      {message ? <section className="inline-success">{message}</section> : null}
      {error ? <section className="inline-alert">{error}</section> : null}

      <section
        id={`settings-panel-${activeTab}`}
        className="settings-tab-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeTab}`}
      >
        {tabPanels[activeTab]}
      </section>
    </main>
  );

  if (!onClose) {
    return (
      <>
        {content}
        <DirectoryBrowserModal
          open={directoryBrowserOpen}
          loading={directoryBrowserLoading}
          error={directoryBrowserError}
          currentPath={directoryBrowserCurrentPath}
          inputPath={directoryBrowserInputPath}
          parentPath={directoryBrowserParentPath}
          roots={directoryBrowserRoots}
          items={directoryBrowserItems}
          onInputPathChange={setDirectoryBrowserInputPath}
          onLoad={loadHostDirectory}
          onClose={closeDirectoryBrowser}
          onUseCurrent={applyDirectoryBrowserCurrentPath}
        />
      </>
    );
  }

  return (
    <>
      <DesktopModal
        open
        title={t("settingsTitle")}
        size="xwide"
        layout="form"
        className="settings-modal-card"
        bodyClassName="settings-modal-body"
        onClose={onClose}
      >
        {content}
      </DesktopModal>
      <DirectoryBrowserModal
        open={directoryBrowserOpen}
        loading={directoryBrowserLoading}
        error={directoryBrowserError}
        currentPath={directoryBrowserCurrentPath}
        inputPath={directoryBrowserInputPath}
        parentPath={directoryBrowserParentPath}
        roots={directoryBrowserRoots}
        items={directoryBrowserItems}
        onInputPathChange={setDirectoryBrowserInputPath}
        onLoad={loadHostDirectory}
        onClose={closeDirectoryBrowser}
        onUseCurrent={applyDirectoryBrowserCurrentPath}
      />
    </>
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

function MacSwitch({
  checked,
  label,
  onChange
}: {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="mac-switch"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      data-checked={checked ? "true" : "false"}
      onClick={() => onChange(!checked)}
    >
      <span aria-hidden="true" />
    </button>
  );
}

function LibraryIndexStatusCard({
  binding,
  status
}: {
  binding: LibraryBinding | null;
  status?: LibraryIndexStatus | null;
}) {
  const progress = status?.progress ?? null;
  return (
    <section className="settings-index-status-card" data-state={status?.state ?? "unknown"}>
      <div className="settings-index-status-main">
        <span className={`affairs-stage-status-dot state-${resolveIndexStatusDotState(status?.state)}`} />
        <div>
          <strong>{resolveIndexStatusLabel(status?.state, binding)}</strong>
          <span>{binding?.rootDir ?? t("commonNotSet")}</span>
        </div>
      </div>
      <div className="settings-index-status-grid">
        <StatusMetric label={t("settingsIndexScanned")} value={formatNullableNumber(progress?.scannedCount)} />
        <StatusMetric label={t("settingsIndexIndexed")} value={formatNullableNumber(progress?.indexedCount)} />
        <StatusMetric label={t("settingsIndexFailed")} value={formatNullableNumber(progress?.failedCount)} tone={(progress?.failedCount ?? 0) > 0 ? "danger" : undefined} />
        <StatusMetric label={t("settingsIndexUpdatedAt")} value={formatDateTime(status?.lastCompletedAt)} />
      </div>
      {status?.errorSummary ? <div className="inline-alert compact">{status.errorSummary}</div> : null}
    </section>
  );
}

function StatusMetric({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone?: "danger";
}) {
  return (
    <div className="settings-index-status-metric" data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DirectoryBrowserModal({
  open,
  loading,
  error,
  currentPath,
  inputPath,
  parentPath,
  roots,
  items,
  onInputPathChange,
  onLoad,
  onClose,
  onUseCurrent
}: {
  open: boolean;
  loading: boolean;
  error: string | null;
  currentPath: string;
  inputPath: string;
  parentPath: string | null;
  roots: HostDirectoryOption[];
  items: HostDirectoryOption[];
  onInputPathChange: (value: string) => void;
  onLoad: (path?: string | null) => Promise<void>;
  onClose: () => void;
  onUseCurrent: () => void;
}) {
  return (
    <DesktopModal
      open={open}
      title={t("hostDirectoryBrowserTitle")}
      description={t("hostDirectoryBrowserDescription")}
      size="wide"
      layout="list"
      dismissible={!loading}
      onClose={onClose}
      footer={
        <ModalActions align="between">
          <button type="button" className="secondary-button" disabled={loading} onClick={onClose}>
            {t("actionCancel")}
          </button>
          <button type="button" className="primary-button" disabled={loading || !currentPath} onClick={onUseCurrent}>
            {t("hostDirectoryUseCurrent")}
          </button>
        </ModalActions>
      }
    >
      <div className="host-directory-browser" aria-label={t("hostDirectoryBrowserTitle")}>
        <form
          className="host-directory-browser-form"
          onSubmit={(event) => {
            event.preventDefault();
            void onLoad(inputPath);
          }}
        >
          <label>
            <span>{t("hostDirectoryCurrentPath")}</span>
            <input value={inputPath} placeholder={t("settingsRootDirPlaceholder")} onChange={(event) => onInputPathChange(event.target.value)} />
          </label>
          <div className="host-directory-browser-toolbar">
            <button type="button" className="secondary-button" disabled={loading || !parentPath} onClick={() => void onLoad(parentPath)}>
              {t("hostDirectoryOpenParent")}
            </button>
            <button type="submit" className="secondary-button" disabled={loading}>
              {t("hostDirectoryOpenPath")}
            </button>
          </div>
        </form>

        <section className="host-directory-browser-panel">
          <div className="host-directory-browser-roots">
            <span>{t("hostDirectoryRoots")}</span>
            <div>
              {roots.map((item) => (
                <button key={item.path} type="button" className="host-directory-browser-chip" disabled={loading} onClick={() => void onLoad(item.path)}>
                  {item.name}
                </button>
              ))}
            </div>
          </div>

          <div className="host-directory-browser-current" title={currentPath}>
            {currentPath || t("hostDirectoryNotLoaded")}
          </div>

          {error ? <div className="inline-alert compact">{error}</div> : null}

          {loading ? (
            <p className="host-directory-browser-status">{t("hostDirectoryLoading")}</p>
          ) : items.length > 0 ? (
            <div className="host-directory-browser-list">
              {items.map((item) => (
                <button key={item.path} type="button" className="host-directory-browser-item" disabled={loading} onClick={() => void onLoad(item.path)}>
                  <span className="host-directory-browser-item-name">{item.name}</span>
                  <span className="host-directory-browser-item-path">{item.path}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="host-directory-browser-status">{t("hostDirectoryEmpty")}</p>
          )}
        </section>
      </div>
    </DesktopModal>
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

function normalizeExtensionToken(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  const withDot = normalized.startsWith(".") ? normalized : `.${normalized}`;
  return /^\.[a-z0-9]+(?:[._-][a-z0-9]+)*$/i.test(withDot) ? withDot : "";
}

function sortAllowedExtensions(input: readonly string[]): string[] {
  return Array.from(new Set(input.map((item) => normalizeExtensionToken(item)).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

function resolveEditableAllowedExtensions(input: readonly string[]): string[] {
  const normalized = sortAllowedExtensions(input);
  return normalized.length > 0 ? normalized : [...LIBRARY_PRESET_EXTENSIONS];
}

function buildAllowedExtensionOptions(selectedExtensions: readonly string[]): string[] {
  return sortAllowedExtensions([...LIBRARY_PRESET_EXTENSIONS, ...selectedExtensions]);
}

function shouldPersistImplicitAllowedExtensions(
  configuredExtensions: readonly string[],
  selectedExtensions: readonly string[]
): boolean {
  const normalizedConfigured = sortAllowedExtensions(configuredExtensions);
  if (normalizedConfigured.length > 0) {
    return false;
  }
  const preset = sortAllowedExtensions(LIBRARY_PRESET_EXTENSIONS);
  const selected = sortAllowedExtensions(selectedExtensions);
  return preset.length === selected.length && preset.every((item, index) => item === selected[index]);
}

function sortIncludedHiddenPaths(input: readonly string[]): string[] {
  return [...new Set(
    input
      .map((item) => String(item ?? "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, ""))
      .filter(Boolean)
  )].sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
}

function parseIncludedHiddenPaths(input: string): string[] {
  return sortIncludedHiddenPaths(input.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean));
}

function formatNullableNumber(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "—";
}

function resolveIndexStatusLabel(state: LibraryIndexStatus["state"] | undefined, binding: LibraryBinding | null): string {
  if (!binding) {
    return t("commonNotSet");
  }
  switch (state) {
    case "fresh":
      return t("libraryStatusFresh");
    case "running":
      return t("libraryStatusRunning");
    case "queued":
      return t("libraryStatusQueued");
    case "queue_timeout":
      return t("libraryStatusQueueTimeout");
    case "cooldown":
      return t("libraryStatusCooldown");
    case "failed":
      return t("libraryStatusFailed");
    case "stale":
      return t("libraryStatusStale");
    default:
      return binding.enabled ? t("libraryStatusFresh") : t("commonNotSet");
  }
}

function resolveIndexStatusDotState(state: LibraryIndexStatus["state"] | undefined): string {
  if (state === "fresh") {
    return "fresh";
  }
  if (state === "running" || state === "queued") {
    return "running";
  }
  if (state === "cooldown") {
    return "cooldown";
  }
  if (state === "failed" || state === "queue_timeout") {
    return "failed";
  }
  return "stale";
}
