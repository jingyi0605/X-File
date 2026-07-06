import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  HostDirectoryOption,
  HttpServerState,
  LibraryIndexStatus,
  LibraryBinding,
  LibraryConfig,
  OnlyOfficeSettings,
  OnlyOfficeStatus,
  OnlyOfficeStatusState,
  PluginListItem,
  PluginListResult
} from "@x-file/shared";

import {
  browseHostDirectories,
  disablePlugin,
  enablePlugin,
  getHttpServerState,
  getLibraryBinding,
  getLibraryConfig,
  getLibrarySnapshot,
  getOnlyOfficeSettings,
  getOnlyOfficeStatus,
  listPlugins,
  saveHttpServerState,
  saveLibraryBinding,
  saveLibraryConfig,
  saveOnlyOfficeSettings,
} from "../../api/library";
import { toApiErrorMessage } from "../../api/http";
import { t } from "../../i18n";
import { normalizeBaseUrl } from "../../runtime/runtime-config";
import { LanguageSwitcher } from "../../shared/i18n/LanguageSwitcher";
import { ThemeSwitcher } from "../../shared/theme/ThemeSwitcher";
import { formatDateTime } from "../../shared/format";
import { DesktopModal, ModalActions } from "../../shared/modal";
import { UpdatePanel } from "./UpdatePanel";
import { getRuntimeConfigSnapshot, updateRuntimeConfig } from "../../runtime/runtime-config-store";

interface SettingsPageProps {
  onSaved?: () => void;
  onClose?: () => void;
}

interface BindingFormState {
  rootDir: string;
}

interface RuntimeFormState {
  mode: "local" | "mirror";
  remoteApiBaseUrl: string;
  localRootDir: string;
}

interface ConfigFormState {
  enabled: boolean;
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

interface OnlyOfficeModalState {
  open: boolean;
  refreshing: boolean;
}

interface PublicBaseUrlOptions {
  currentValue: string | null;
  existingValue: string;
  serverState: HttpServerState | null;
}

interface OnlyOfficeStatusCard {
  key: string;
  label: string;
  value: string;
  detail: string;
  tone: "default" | "success" | "warning" | "danger";
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
  const [pluginList, setPluginList] = useState<PluginListResult | null>(null);
  const [serverState, setServerState] = useState<HttpServerState | null>(null);
  const [runtimeForm, setRuntimeForm] = useState<RuntimeFormState>(() => {
    const config = getRuntimeConfigSnapshot().config;
    return {
      mode: config.mode,
      remoteApiBaseUrl: config.remoteApiBaseUrl,
      localRootDir: config.localRootDir
    };
  });
  const [bindingForm, setBindingForm] = useState<BindingFormState>({ rootDir: "" });
  const [configForm, setConfigForm] = useState<ConfigFormState>({
    enabled: true,
    allowedExtensions: [...LIBRARY_PRESET_EXTENSIONS],
    includedHiddenPaths: "",
    folderOpenBehavior: "double_click",
    manualExtension: "",
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
  const [onlyOfficeModal, setOnlyOfficeModal] = useState<OnlyOfficeModalState>({
    open: false,
    refreshing: false
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
  const isMirrorMode = runtimeForm.mode === "mirror";
  const runtimeModeLabel = isMirrorMode ? t("runtimeModeMirror") : t("runtimeModeLocal");

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

    const runtimeConfig = getRuntimeConfigSnapshot().config;
    setRuntimeForm({
      mode: runtimeConfig.mode,
      remoteApiBaseUrl: runtimeConfig.remoteApiBaseUrl,
      localRootDir: runtimeConfig.localRootDir
    });

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
      setPluginList(await listPlugins());
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
    try {
      setError(null);
      if (isMirrorMode) {
        const normalizedRemoteApiBaseUrl = normalizeBaseUrl(runtimeForm.remoteApiBaseUrl);
        if (!normalizedRemoteApiBaseUrl) {
          setError(t("runtimeMirrorApiRequired"));
          return;
        }
        const nextConfig = await updateRuntimeConfig({
          mode: "mirror",
          remoteApiBaseUrl: normalizedRemoteApiBaseUrl,
          localRootDir: runtimeForm.localRootDir
        });
        setRuntimeForm({
          mode: nextConfig.mode,
          remoteApiBaseUrl: nextConfig.remoteApiBaseUrl,
          localRootDir: nextConfig.localRootDir
        });
      } else {
        await updateRuntimeConfig({
          mode: "local",
          remoteApiBaseUrl: runtimeForm.remoteApiBaseUrl,
          localRootDir: runtimeForm.localRootDir
        });
        const rootDir = bindingForm.rootDir.trim();
        if (!rootDir) {
          setError(t("settingsRequiredRootDir"));
          return;
        }
        const saved = await saveLibraryBinding({ rootDir });
        setBinding(saved);
        const snapshot = await getLibrarySnapshot();
        setLibraryIndexStatus(snapshot.status);
      }
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
        enabled: true,
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

  async function refreshOnlyOfficeStatus(): Promise<void> {
    try {
      setOnlyOfficeModal((current) => ({ ...current, refreshing: true }));
      setError(null);
      setOnlyOfficeStatus(await getOnlyOfficeStatus());
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setOnlyOfficeModal((current) => ({ ...current, refreshing: false }));
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

  async function handlePluginToggle(plugin: PluginListItem): Promise<void> {
    try {
      setError(null);
      const result = plugin.registry.enabled
        ? await disablePlugin(plugin.registry.pluginId)
        : await enablePlugin(plugin.registry.pluginId);
      setPluginList((current) => ({
        pluginRootDir: result.pluginRootDir,
        plugins: mergePluginItem(current?.plugins ?? [], result.plugin),
      }));
      setMessage(plugin.registry.enabled ? t("settingsPluginDisableSuccess") : t("settingsPluginEnableSuccess"));
    } catch (err) {
      setError(toApiErrorMessage(err));
    }
  }

  function applyConfig(config: LibraryConfig): void {
    setLibraryConfig(config);
    setConfigForm({
      enabled: config.enabled,
      allowedExtensions: resolveEditableAllowedExtensions(config.allowedExtensions),
      includedHiddenPaths: sortIncludedHiddenPaths(config.includedHiddenPaths).join("\n"),
      folderOpenBehavior: config.folderOpenBehavior,
      manualExtension: "",
    });
  }

  function applyOnlyOffice(settings: OnlyOfficeSettings): void {
    setOnlyOffice(settings);
    setOnlyOfficeForm({
      enabled: settings.enabled,
      serverUrl: settings.serverUrl ?? "",
      publicBaseUrl: resolveSuggestedPublicBaseUrl({
        currentValue: settings.publicBaseUrl,
        existingValue: onlyOfficeForm.publicBaseUrl,
        serverState
      }),
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
    setOnlyOfficeForm((current) => ({
      ...current,
      publicBaseUrl: resolveSuggestedPublicBaseUrl({
        currentValue: current.publicBaseUrl,
        existingValue: current.publicBaseUrl,
        serverState: state
      })
    }));
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
    void loadHostDirectory(
      runtimeForm.mode === "mirror"
        ? runtimeForm.localRootDir.trim() || undefined
        : bindingForm.rootDir.trim() || undefined
    );
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

    if (runtimeForm.mode === "mirror") {
      setRuntimeForm((current) => ({ ...current, localRootDir: directoryBrowserCurrentPath }));
    } else {
      setBindingForm({ rootDir: directoryBrowserCurrentPath });
    }
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
          <p className="settings-helper-text">
            {isMirrorMode ? t("settingsMirrorBindingDescription") : t("settingsLocalBindingDescription")}
          </p>
          <div className="settings-runtime-mode-switcher">
            <button type="button" className={runtimeForm.mode === "local" ? "primary-button" : "secondary-button"} onClick={() => setRuntimeForm((current) => ({ ...current, mode: "local" }))}>
              {t("runtimeModeLocal")}
            </button>
            <button type="button" className={runtimeForm.mode === "mirror" ? "primary-button" : "secondary-button"} onClick={() => setRuntimeForm((current) => ({ ...current, mode: "mirror" }))}>
              {t("runtimeModeMirror")}
            </button>
          </div>
          {isMirrorMode ? (
            <>
              <label>
                <span>{t("runtimeRemoteApiBaseUrl")}</span>
                <input value={runtimeForm.remoteApiBaseUrl} placeholder={t("runtimeRemoteApiBaseUrlPlaceholder")} onChange={(event) => setRuntimeForm((current) => ({ ...current, remoteApiBaseUrl: event.target.value }))} />
                <small>{t("settingsMirrorSourceApiDescription")}</small>
              </label>
              <label>
                <span>{t("runtimeMirrorRootDir")}</span>
                <div className="library-init-path-row">
                  <input value={runtimeForm.localRootDir} placeholder={t("runtimeMirrorRootDirPlaceholder")} onChange={(event) => setRuntimeForm((current) => ({ ...current, localRootDir: event.target.value }))} />
                  <button type="button" className="secondary-button" onClick={openDirectoryBrowser}>
                    {t("hostDirectoryBrowseAction")}
                  </button>
                </div>
                <small>{t("settingsMirrorLocalDirDescription")}</small>
              </label>
            </>
          ) : (
            <>
              <label>
                <span>{t("settingsRootDir")}</span>
                <div className="library-init-path-row">
                  <input value={bindingForm.rootDir} onChange={(event) => setBindingForm({ rootDir: event.target.value })} placeholder={t("settingsRootDirPlaceholder")} />
                  <button type="button" className="secondary-button" onClick={openDirectoryBrowser}>
                    {t("hostDirectoryBrowseAction")}
                  </button>
                </div>
              </label>
              <LibraryIndexStatusCard binding={binding} status={libraryIndexStatus} />
            </>
          )}
          <button type="submit" className="primary-button">{t("settingsSaveBinding")}</button>
        </form>

        <form className="settings-section" onSubmit={(event) => void submitConfig(event)}>
          <h2>{t("settingsConfigTitle")}</h2>
          {isMirrorMode ? (
            <div className="settings-remote-owner-note" data-tone="danger">
              <strong>{t("settingsRemoteOwnerTitle")}</strong>
              <span>{t("settingsMirrorConfigRemoteNotice")}</span>
            </div>
          ) : null}
          {configUnavailable ? <div className="inline-note">{t("settingsConfigUnavailable")} {configUnavailable}</div> : null}
          <div className="affairs-library-settings-form">
            <section className="affairs-library-config-section">
              <div className="affairs-library-behavior-switch-header">
                <span className="affairs-library-behavior-switch-title">{t("settingsFolderOpenBehavior")}</span>
                <div className="affairs-library-behavior-segmented" role="group" aria-label={t("settingsFolderOpenBehavior")}>
                  <button
                    type="button"
                    className={configForm.folderOpenBehavior === "single_click" ? "active" : ""}
                    aria-pressed={configForm.folderOpenBehavior === "single_click"}
                    onClick={() => setConfigForm((current) => ({ ...current, folderOpenBehavior: "single_click" }))}
                  >
                    {t("settingsSingleClick")}
                  </button>
                  <button
                    type="button"
                    className={configForm.folderOpenBehavior === "double_click" ? "active" : ""}
                    aria-pressed={configForm.folderOpenBehavior === "double_click"}
                    onClick={() => setConfigForm((current) => ({ ...current, folderOpenBehavior: "double_click" }))}
                  >
                    {t("settingsDoubleClick")}
                  </button>
                </div>
              </div>
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
      <section className="settings-section settings-integration-section">
        <div className="settings-integration-header">
          <div>
            <h2>{t("settingsIntegrationHubTitle")}</h2>
          </div>
          {isMirrorMode ? (
            <div className="settings-remote-owner-note" data-tone="danger">
              <strong>{t("settingsRemoteOwnerTitle")}</strong>
              <span>{t("settingsMirrorOnlyOfficeRemoteNotice")}</span>
            </div>
          ) : null}
        </div>

        <div className="settings-integration-cards" role="list" aria-label={t("settingsIntegrationHubTitle")}>
          <article className="settings-section settings-plugin-card settings-plugin-card-featured" role="listitem">
            <div className="settings-heading-row">
              <div>
                <h3>{t("settingsPluginsTitle")}</h3>
                <p className="settings-helper-text">{t("settingsPluginsDescription")}</p>
              </div>
            </div>
            <div className="settings-current">
              <span>{t("settingsBundledPluginListLabel")}</span>
              <strong>{pluginList?.plugins.length ?? 0}</strong>
            </div>
            <p className="settings-helper-text">{t("settingsBundledPluginDescription")}</p>
          </article>

          <article className="settings-section settings-plugin-card settings-onlyoffice-card" role="listitem" data-health={onlyOfficeStatus?.state ?? "unknown"}>
            <div className="settings-heading-row">
              <div>
                <h3>{t("settingsOnlyOfficeTitle")}</h3>
              </div>
            </div>
            <div className="settings-current">
              <span>{t("settingsOnlyOfficeEnabled")}</span>
              <strong>{onlyOfficeForm.enabled ? t("settingsPluginEnabled") : t("settingsPluginDisabled")}</strong>
            </div>
            <div className="settings-current">
              <span>{t("settingsOnlyOfficeInstance")}</span>
              <strong>{onlyOfficeForm.serverUrl || t("commonNotSet")}</strong>
            </div>
            <p className="settings-helper-text">{onlyOfficeStatus?.summary ?? t("settingsOnlyOfficeStatusUnknown")}</p>
            <div className="settings-onlyoffice-metrics settings-onlyoffice-metrics-compact" role="list" aria-label={t("settingsOnlyOfficeStatusPanelTitle")}>
              {buildOnlyOfficeStatusCards(onlyOfficeStatus).slice(0, 4).map((card) => (
                <div
                  key={card.key}
                  className="settings-onlyoffice-metric-card"
                  data-tone={card.tone}
                  role="listitem"
                  tabIndex={0}
                >
                  <span className="settings-onlyoffice-metric-label">{card.label}</span>
                  <strong className="settings-onlyoffice-metric-value">{card.value}</strong>
                  <div className="settings-onlyoffice-metric-tooltip" role="note">
                    {card.detail}
                  </div>
                </div>
              ))}
            </div>
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setOnlyOfficeModal({ open: true, refreshing: false })}
              >
                {t("settingsOnlyOfficeConfigureAction")}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void refreshOnlyOfficeStatus()}
              >
                {onlyOfficeModal.refreshing ? t("healthChecking") : t("settingsOnlyOfficeRefreshStatus")}
              </button>
            </div>
          </article>

          {pluginList && pluginList.plugins.length > 0 ? pluginList.plugins.map((plugin) => (
            <article
              key={plugin.registry.pluginId}
              className="settings-section settings-plugin-card settings-plugin-list-item"
              role="listitem"
              data-health={plugin.health.status}
            >
              <div className="settings-plugin-list-main">
                <div className="settings-plugin-list-title">
                  <h3>{plugin.manifest.name}</h3>
                </div>
                <div className="settings-plugin-list-meta" aria-label={plugin.manifest.name}>
                  <span className="settings-runtime-badge">{renderPluginHealthLabel(plugin)}</span>
                  <span className="settings-plugin-version">{plugin.registry.version}</span>
                </div>
              </div>
              <div className="settings-plugin-list-toggle">
                <span className="settings-plugin-toggle-state">
                  {plugin.registry.enabled ? t("settingsPluginEnabled") : t("settingsPluginDisabled")}
                </span>
                <MacSwitch
                  checked={plugin.registry.enabled}
                  label={plugin.manifest.name}
                  onChange={() => void handlePluginToggle(plugin)}
                />
              </div>
            </article>
          )) : null}
        </div>
      </section>
    ),
    network: (
      <form className="settings-section" onSubmit={(event) => void submitServer(event)}>
        <h2>{t("settingsServerTitle")}</h2>
        {isMirrorMode ? (
          <div className="settings-remote-owner-note" data-tone="danger">
            <strong>{t("settingsRemoteOwnerTitle")}</strong>
            <span>{t("settingsMirrorServerRemoteNotice")}</span>
          </div>
        ) : null}
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
    updates: <UpdatePanel />
  };

  const content = (
    <main className="settings-page">
      <section className="page-heading">
        <div>
          <p className="eyebrow">{t("navSettings")}</p>
          <div className="settings-heading-row">
            <h1>{t("settingsTitle")}</h1>
            <span className="settings-runtime-badge" data-mode={runtimeForm.mode}>
              {runtimeModeLabel}
            </span>
          </div>
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
        <OnlyOfficeSettingsModal
          open={onlyOfficeModal.open}
          isMirrorMode={isMirrorMode}
          refreshing={onlyOfficeModal.refreshing}
          onlyOffice={onlyOffice}
          onlyOfficeForm={onlyOfficeForm}
          onlyOfficeStatus={onlyOfficeStatus}
          onClose={() => setOnlyOfficeModal({ open: false, refreshing: false })}
          onRefresh={() => void refreshOnlyOfficeStatus()}
          onSubmit={submitOnlyOffice}
          onChange={(updater) => setOnlyOfficeForm((current) => updater(current))}
        />
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
        headerActions={(
          <span className="settings-runtime-badge settings-runtime-badge-modal" data-mode={runtimeForm.mode}>
            {runtimeModeLabel}
          </span>
        )}
        size="xwide"
        layout="form"
        className="settings-modal-card"
        bodyClassName="settings-modal-body"
        onClose={onClose}
      >
        {content}
      </DesktopModal>
      <OnlyOfficeSettingsModal
        open={onlyOfficeModal.open}
        isMirrorMode={isMirrorMode}
        refreshing={onlyOfficeModal.refreshing}
        onlyOffice={onlyOffice}
        onlyOfficeForm={onlyOfficeForm}
        onlyOfficeStatus={onlyOfficeStatus}
        onClose={() => setOnlyOfficeModal({ open: false, refreshing: false })}
        onRefresh={() => void refreshOnlyOfficeStatus()}
        onSubmit={submitOnlyOffice}
        onChange={(updater) => setOnlyOfficeForm((current) => updater(current))}
      />
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

function OnlyOfficeSettingsModal({
  open,
  isMirrorMode,
  refreshing,
  onlyOffice,
  onlyOfficeForm,
  onlyOfficeStatus,
  onClose,
  onRefresh,
  onSubmit,
  onChange,
}: {
  open: boolean;
  isMirrorMode: boolean;
  refreshing: boolean;
  onlyOffice: OnlyOfficeSettings | null;
  onlyOfficeForm: OnlyOfficeFormState;
  onlyOfficeStatus: OnlyOfficeStatus | null;
  onClose: () => void;
  onRefresh: () => void;
  onSubmit: (event: FormEvent) => Promise<void>;
  onChange: (updater: (current: OnlyOfficeFormState) => OnlyOfficeFormState) => void;
}) {
  return (
    <DesktopModal
      open={open}
      title={t("settingsOnlyOfficeTitle")}
      description={t("settingsOnlyOfficeModalDescription")}
      size="wide"
      layout="form"
      className="settings-onlyoffice-modal"
      bodyClassName="settings-onlyoffice-modal-body"
      onClose={onClose}
    >
      <form className="settings-onlyoffice-panel" onSubmit={(event) => void onSubmit(event)}>
        <div className="settings-onlyoffice-status-summary">
          <div className="settings-onlyoffice-status-copy">
            <h2 className="settings-onlyoffice-status-title">{t("settingsOnlyOfficeStatus")}</h2>
            <p className="settings-onlyoffice-status-description">{onlyOfficeStatus?.summary ?? t("settingsOnlyOfficeStatusUnknown")}</p>
            {isMirrorMode ? (
              <div className="settings-remote-owner-note" data-tone="danger">
                <strong>{t("settingsRemoteOwnerTitle")}</strong>
                <span>{t("settingsMirrorOnlyOfficeRemoteNotice")}</span>
              </div>
            ) : null}
          </div>
          <div className="settings-instance-card settings-onlyoffice-instance-card">
            <span>{t("settingsOnlyOfficeInstance")}</span>
            <strong>{onlyOfficeForm.serverUrl || t("commonNotSet")}</strong>
          </div>
        </div>

        <div className="settings-onlyoffice-metrics" role="list" aria-label={t("settingsOnlyOfficeStatusPanelTitle")}>
          {buildOnlyOfficeStatusCards(onlyOfficeStatus).map((card) => (
            <div
              key={card.key}
              className="settings-onlyoffice-metric-card"
              data-tone={card.tone}
              role="listitem"
              tabIndex={0}
            >
              <span className="settings-onlyoffice-metric-label">{card.label}</span>
              <strong className="settings-onlyoffice-metric-value">{card.value}</strong>
              <div className="settings-onlyoffice-metric-tooltip" role="note">
                {card.detail}
              </div>
            </div>
          ))}
        </div>

        <section className="settings-onlyoffice-form-section">
          <label className="switch-row settings-onlyoffice-switch-row">
            <div className="settings-onlyoffice-switch-copy">
              <span>{t("settingsOnlyOfficeEnabled")}</span>
              <small>{onlyOfficeForm.enabled ? t("settingsOnlyOfficeEnabledDescriptionOn") : t("settingsOnlyOfficeEnabledDescriptionOff")}</small>
            </div>
            <MacSwitch
              checked={onlyOfficeForm.enabled}
              label={t("settingsOnlyOfficeEnabled")}
              onChange={(checked) => onChange((current) => ({ ...current, enabled: checked }))}
            />
          </label>

          <TextInput
            label={t("settingsOnlyOfficeServerUrl")}
            description={t("settingsOnlyOfficeServerUrlDescription")}
            value={onlyOfficeForm.serverUrl}
            placeholder={t("settingsOnlyOfficeServerUrlPlaceholder")}
            onChange={(value) => onChange((current) => ({ ...current, serverUrl: value }))}
          />
          <TextInput
            label={t("settingsOnlyOfficePublicBaseUrl")}
            description={t("settingsOnlyOfficePublicBaseUrlDescription")}
            value={onlyOfficeForm.publicBaseUrl}
            placeholder={t("settingsOnlyOfficePublicBaseUrlPlaceholder")}
            onChange={(value) => onChange((current) => ({ ...current, publicBaseUrl: value }))}
          />
          <TextInput
            label={t("settingsOnlyOfficeCallbackBaseUrl")}
            description={t("settingsOnlyOfficeCallbackBaseUrlDescription")}
            value={onlyOfficeForm.callbackBaseUrl}
            placeholder={t("settingsOnlyOfficeCallbackBaseUrlPlaceholder")}
            onChange={(value) => onChange((current) => ({ ...current, callbackBaseUrl: value }))}
          />
        </section>

        <section className="settings-onlyoffice-form-section">
          <div className="settings-section-title">
            <strong>{t("settingsOnlyOfficeIdentitySection")}</strong>
            <span className="settings-row-description">{t("settingsOnlyOfficeIdentitySectionDescription")}</span>
          </div>

          <TextInput
            label={t("settingsOnlyOfficeUserName")}
            description={t("settingsOnlyOfficeUserNameDescription")}
            value={onlyOfficeForm.userDisplayName}
            placeholder={t("settingsOnlyOfficeUserNamePlaceholder")}
            onChange={(value) => onChange((current) => ({ ...current, userDisplayName: value }))}
          />
          <TextInput
            label={t("settingsOnlyOfficeAvatar")}
            description={t("settingsOnlyOfficeAvatarDescription")}
            value={onlyOfficeForm.userAvatarUrl}
            placeholder={t("settingsOnlyOfficeAvatarPlaceholder")}
            onChange={(value) => onChange((current) => ({ ...current, userAvatarUrl: value }))}
          />
        </section>

        <section className="settings-onlyoffice-form-section">
          <div className="settings-section-title">
            <strong>{t("settingsOnlyOfficeSecuritySection")}</strong>
            <span className="settings-row-description">{t("settingsOnlyOfficeSecuritySectionDescription")}</span>
          </div>

          <TextInput
            label={t("settingsOnlyOfficeJwtSecret")}
            description={t("settingsOnlyOfficeJwtSecretDescription")}
            value={onlyOfficeForm.jwtSecret}
            placeholder={onlyOffice?.jwtSecretConfigured
              ? t("settingsOnlyOfficeJwtKeepPlaceholder")
              : t("settingsOnlyOfficeJwtPlaceholder")}
            onChange={(value) => onChange((current) => ({ ...current, jwtSecret: value, clearJwtSecret: false }))}
          />
          <label className="switch-row settings-onlyoffice-switch-row">
            <div className="settings-onlyoffice-switch-copy">
              <span>{t("settingsOnlyOfficeClearJwt")}</span>
              <small>{t("settingsOnlyOfficeClearJwtDescription")}</small>
            </div>
            <MacSwitch
              checked={onlyOfficeForm.clearJwtSecret}
              label={t("settingsOnlyOfficeClearJwt")}
              onChange={(checked) => onChange((current) => ({ ...current, clearJwtSecret: checked }))}
            />
          </label>
        </section>

        <div className="settings-current settings-onlyoffice-summary-row">
          <span>{t("settingsOnlyOfficeJwtSecret")}</span>
          <strong>{onlyOffice?.jwtSecretConfigured ? t("settingsOnlyOfficeJwtConfigured") : t("settingsOnlyOfficeJwtNotConfigured")}</strong>
        </div>

        <ModalActions align="between" className="settings-onlyoffice-modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            {t("actionCancel")}
          </button>
          <div className="settings-onlyoffice-modal-actions-group">
            <button type="button" className="secondary-button" onClick={onRefresh}>
              {refreshing ? t("healthChecking") : t("settingsOnlyOfficeRefreshStatus")}
            </button>
            <button type="submit" className="primary-button">{t("settingsOnlyOfficeSave")}</button>
          </div>
        </ModalActions>
      </form>
    </DesktopModal>
  );
}

function resolveSuggestedPublicBaseUrl(input: PublicBaseUrlOptions): string {
  const normalizedCurrent = input.currentValue?.trim() ?? "";
  if (normalizedCurrent && !looksLikeDevWebAddress(normalizedCurrent)) {
    return normalizedCurrent;
  }

  const runtimeBaseUrl = buildRuntimePublicBaseUrl(input.serverState);
  if (runtimeBaseUrl) {
    return runtimeBaseUrl;
  }

  return input.existingValue;
}

function buildRuntimePublicBaseUrl(serverState: HttpServerState | null): string {
  if (!serverState) {
    return "";
  }

  if (typeof window !== "undefined" && /^https?:$/i.test(window.location.protocol)) {
    return window.location.origin;
  }

  const port = serverState.actualPort ?? serverState.port;
  return `http://127.0.0.1:${port}`;
}

function looksLikeDevWebAddress(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "10.255.0.83")
      && url.port === "17320"
    );
  } catch {
    return false;
  }
}

function TextInput({
  label,
  description,
  value,
  placeholder,
  onChange
}: {
  label: string;
  description?: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="settings-onlyoffice-field">
      <span>{label}</span>
      {description ? <small>{description}</small> : null}
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
  const progressPercent =
    progress?.totalCount && progress.totalCount > 0
      ? Math.max(0, Math.min(100, Math.round((progress.indexedCount / progress.totalCount) * 100)))
      : 0;
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
        <StatusMetric label={t("settingsIndexTotal")} value={formatNullableNumber(progress?.totalCount ?? null)} />
        <StatusMetric label={t("settingsIndexScanned")} value={formatNullableNumber(progress?.scannedCount)} />
        <StatusMetric label={t("settingsIndexIndexed")} value={formatNullableNumber(progress?.indexedCount)} />
        <StatusMetric label={t("settingsIndexFailed")} value={formatNullableNumber(progress?.failedCount)} tone={(progress?.failedCount ?? 0) > 0 ? "danger" : undefined} />
      </div>
      {status?.state === "running" ? (
        <div className="settings-index-progress">
          <div className="settings-index-progress-copy">
            <strong>{t("settingsIndexProgressLabel", { percent: progressPercent })}</strong>
            <span>
              {progress?.totalCount && progress.totalCount > 0
                ? t("settingsIndexProgressDetail", {
                    indexed: progress.indexedCount,
                    total: progress.totalCount,
                  })
                : t("settingsIndexProgressPending", {
                    indexed: progress?.indexedCount ?? 0,
                  })}
            </span>
          </div>
          <div className="library-tag-task-progress-track" aria-hidden="true">
            <span
              className="library-tag-task-progress-fill library-index-progress-fill"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      ) : null}
      <div className="settings-index-status-grid">
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
      <div><span>{t("settingsServerConfiguredHost")}</span><strong>{state?.host ?? t("commonUnknown")}</strong></div>
      <div><span>{t("settingsServerConfiguredPort")}</span><strong>{state?.port ?? t("commonUnknown")}</strong></div>
      <div><span>{t("settingsServerRunning")}</span><strong>{state?.running ? t("settingsServerRunning") : t("settingsServerStopped")}</strong></div>
      <div><span>{t("settingsServerActualHost")}</span><strong>{state?.actualHost ?? t("commonUnknown")}</strong></div>
      <div><span>{t("settingsServerActualPort")}</span><strong>{state?.actualPort ?? t("commonUnknown")}</strong></div>
      <div><span>{t("settingsServerLifecycle")}</span><strong>{state?.lifecycleState ?? t("commonUnknown")}</strong></div>
      <div><span>{t("settingsServerStartedAt")}</span><strong>{formatDateTime(state?.startedAt)}</strong></div>
      <div><span>{t("settingsServerLastError")}</span><strong>{state?.lastError ?? t("commonNone")}</strong></div>
    </div>
  );
}

function normalizeOptionalUrl(value: string): string | null {
  return normalizeOptionalText(value);
}

function resolveOnlyOfficeStatusLabel(state: OnlyOfficeStatusState | undefined): string {
  switch (state) {
    case "ready":
      return t("settingsOnlyOfficeStatusReady");
    case "warning":
      return t("settingsOnlyOfficeStatusWarning");
    case "error":
      return t("settingsOnlyOfficeStatusError");
    case "misconfigured":
      return t("settingsOnlyOfficeStatusMisconfigured");
    case "disabled":
      return t("settingsOnlyOfficeStatusDisabled");
    default:
      return t("settingsOnlyOfficeStatusUnknown");
  }
}

function resolveOnlyOfficeStatusTone(
  state: OnlyOfficeStatusState | undefined
): "default" | "success" | "warning" | "danger" {
  switch (state) {
    case "ready":
      return "success";
    case "warning":
    case "misconfigured":
      return "warning";
    case "error":
      return "danger";
    case "disabled":
    default:
      return "default";
  }
}

function resolveOnlyOfficeCheckStatusLabel(status: "pass" | "warn" | "fail" | "skip"): string {
  switch (status) {
    case "pass":
      return t("settingsOnlyOfficeCheckPass");
    case "warn":
      return t("settingsOnlyOfficeCheckWarn");
    case "fail":
      return t("settingsOnlyOfficeCheckFail");
    case "skip":
    default:
      return t("settingsOnlyOfficeCheckSkip");
  }
}

function resolveOnlyOfficeCheckTone(
  status: "pass" | "warn" | "fail" | "skip"
): "default" | "success" | "warning" | "danger" {
  switch (status) {
    case "pass":
      return "success";
    case "warn":
      return "warning";
    case "fail":
      return "danger";
    case "skip":
    default:
      return "default";
  }
}

function buildOnlyOfficeStatusCards(status: OnlyOfficeStatus | null): OnlyOfficeStatusCard[] {
  const cards: OnlyOfficeStatusCard[] = [
    {
      key: "summary",
      label: t("settingsOnlyOfficeStatusLabel"),
      value: resolveOnlyOfficeStatusLabel(status?.state),
      detail: status?.summary ?? t("settingsOnlyOfficeStatusUnknown"),
      tone: resolveOnlyOfficeStatusTone(status?.state)
    }
  ];

  for (const check of status?.checks ?? []) {
    cards.push({
      key: check.key,
      label: check.label,
      value: resolveOnlyOfficeCheckStatusLabel(check.status),
      detail: check.detail,
      tone: resolveOnlyOfficeCheckTone(check.status)
    });
  }

  return cards;
}

function renderPluginHealthLabel(plugin: PluginListItem): string {
  switch (plugin.health.status) {
    case "healthy":
      return t("settingsPluginHealthHealthy");
    case "degraded":
      return t("settingsPluginHealthDegraded");
    case "failed":
      return t("settingsPluginHealthFailed");
    default:
      return t("settingsPluginHealthUnknown");
  }
}

function mergePluginItem(items: PluginListItem[], nextItem: PluginListItem): PluginListItem[] {
  const nextItems = items.filter((item) => item.registry.pluginId !== nextItem.registry.pluginId);
  nextItems.push(nextItem);
  nextItems.sort((left, right) => left.manifest.name.localeCompare(right.manifest.name, "en"));
  return nextItems;
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
