import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type {
  HostDirectoryOption,
  HttpServerHostOption,
  HttpServerState,
  LibraryIndexStatus,
  LibraryBinding,
  LibraryConfig,
} from "@x-file/shared";

import {
  browseHostDirectories,
  getHttpServerState,
  getLibraryBinding,
  getLibraryConfig,
  getLibrarySnapshot,
  saveHttpServerState,
  saveLibraryBinding,
  saveLibraryConfig,
} from "../../api/library";
import { toApiErrorMessage } from "../../api/http";
import { t } from "../../i18n";
import { normalizeBaseUrl } from "../../runtime/runtime-config";
import { LanguageSwitcher } from "../../shared/i18n/LanguageSwitcher";
import { ThemeSwitcher } from "../../shared/theme/ThemeSwitcher";
import { formatDateTime } from "../../shared/format";
import { InterfaceIcon } from "../../shared/InterfaceIcon";
import { DesktopModal, ModalActions } from "../../shared/modal";
import { UpdatePanel } from "./UpdatePanel";
import { AgentIntegrationSettings } from "./AgentIntegrationSettings";
import { SettingsModule } from "./SettingsModule";
import { getRuntimeConfigSnapshot, updateRuntimeConfig } from "../../runtime/runtime-config-store";
import { clearNativeApplicationData, requestNativeAppRestart } from "../../runtime/native-library-bridge";

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
  hideDotFiles: boolean;
  hideSystemFolders: boolean;
  folderOpenBehavior: "single_click" | "double_click";
  manualExtension: string;
}

interface ServerFormState {
  enabled: boolean;
  persistent: boolean;
  host: string;
  port: string;
  authUsername: string;
  authPassword: string;
}

interface ResetApplicationModalState {
  open: boolean;
  step: 1 | 2 | 3;
  confirmationText: string;
  submitting: boolean;
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
}> = [
  {
    id: "appearance",
    titleKey: "settingsTabAppearance"
  },
  {
    id: "library",
    titleKey: "settingsTabLibrary"
  },
  {
    id: "integration",
    titleKey: "settingsTabIntegration"
  },
  {
    id: "network",
    titleKey: "settingsTabNetwork"
  },
  {
    id: "updates",
    titleKey: "settingsTabUpdates"
  }
];

export function SettingsPage({ onSaved, onClose }: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("appearance");
  const [binding, setBinding] = useState<LibraryBinding | null>(null);
  const [libraryConfig, setLibraryConfig] = useState<LibraryConfig | null>(null);
  const [libraryIndexStatus, setLibraryIndexStatus] = useState<LibraryIndexStatus | null>(null);
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
    hideDotFiles: true,
    hideSystemFolders: true,
    folderOpenBehavior: "double_click",
    manualExtension: "",
  });
  const [serverForm, setServerForm] = useState<ServerFormState>({
    enabled: false,
    persistent: false,
    host: "127.0.0.1",
    port: "17321",
    authUsername: "",
    authPassword: ""
  });
  const [copiedServerUrl, setCopiedServerUrl] = useState<string | null>(null);
  const [resetApplicationModal, setResetApplicationModal] = useState<ResetApplicationModalState>({
    open: false,
    step: 1,
    confirmationText: "",
    submitting: false,
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
  const isDesktopContext = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
        hideDotFiles: configForm.hideDotFiles,
        hideSystemFolders: configForm.hideSystemFolders,
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

  async function submitServer(event: FormEvent): Promise<void> {
    event.preventDefault();
    try {
      setError(null);
      const authUsername = serverForm.authUsername.trim();
      const hasAuthPassword = serverForm.authPassword.length > 0;
      const shouldSaveAuthUsername = authUsername.length > 0 && (
        hasAuthPassword
        || !serverState?.authConfigured
        || authUsername !== serverState.authUsername
      );
      const saved = await saveHttpServerState({
        enabled: serverForm.enabled,
        persistent: serverForm.persistent,
        host: serverForm.host,
        port: Number(serverForm.port),
        authEnabled: serverForm.host !== "127.0.0.1",
        ...(shouldSaveAuthUsername ? { authUsername } : {}),
        ...(hasAuthPassword ? { authPassword: serverForm.authPassword } : {})
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
      enabled: config.enabled,
      allowedExtensions: resolveEditableAllowedExtensions(config.allowedExtensions),
      includedHiddenPaths: sortIncludedHiddenPaths(config.includedHiddenPaths).join("\n"),
      hideDotFiles: config.hideDotFiles,
      hideSystemFolders: config.hideSystemFolders,
      folderOpenBehavior: config.folderOpenBehavior,
      manualExtension: "",
    });
  }

  function applyServerState(state: HttpServerState): void {
    setServerState(state);
    const host = !state.authConfigured && state.host !== "127.0.0.1"
      ? "127.0.0.1"
      : state.host;
    setServerForm({
      enabled: state.enabled,
      persistent: state.persistent,
      host,
      port: String(state.port),
      authUsername: state.authUsername ?? "",
      authPassword: ""
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

  function openResetApplicationModal(): void {
    setResetApplicationModal({
      open: true,
      step: 1,
      confirmationText: "",
      submitting: false,
    });
    setError(null);
    setMessage(null);
  }

  function closeResetApplicationModal(): void {
    setResetApplicationModal((current) => {
      if (current.submitting) {
        return current;
      }
      return {
        open: false,
        step: 1,
        confirmationText: "",
        submitting: false,
      };
    });
  }

  function advanceResetApplicationStep(): void {
    setResetApplicationModal((current) => ({
      ...current,
      step: current.step === 1 ? 2 : 3,
    }));
  }

  async function submitResetApplication(): Promise<void> {
    if (!isDesktopContext) {
      setError(t("settingsResetDesktopOnly"));
      return;
    }
    const confirmationPhrase = t("settingsResetConfirmPhrase");
    if (resetApplicationModal.confirmationText.trim() !== confirmationPhrase) {
      setError(t("settingsResetInputMismatch"));
      return;
    }
    setResetApplicationModal((current) => ({ ...current, submitting: true }));
    setError(null);
    setMessage(null);
    try {
      const cleared = await clearNativeApplicationData();
      if (!cleared) {
        throw new Error(t("settingsResetDesktopOnly"));
      }
      clearLocalStorageByPrefix("x-file.");
      setMessage(t("settingsResetRestarting"));
      const restarted = await requestNativeAppRestart();
      if (!restarted && typeof window !== "undefined") {
        window.location.reload();
      }
    } catch (err) {
      setError(toApiErrorMessage(err));
      setResetApplicationModal((current) => ({ ...current, submitting: false }));
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  const tabPanels: Record<SettingsTabId, ReactNode> = {
    appearance: (
      <section className="settings-module-stack">
        <SettingsModule title={t("settingsLanguageTitle")}>
          <LanguageSwitcher showLabel={false} />
        </SettingsModule>
        <SettingsModule title={t("settingsThemeTitle")}>
          <ThemeSwitcher showSummary={false} />
        </SettingsModule>
      </section>
    ),
    library: (
      <section className="settings-grid">
        <SettingsModule title={t("settingsBindingTitle")}
          description={isMirrorMode ? t("settingsMirrorBindingDescription") : undefined}>
          <form className="settings-module-form" onSubmit={(event) => void submitBinding(event)}>
            <div className="button-row settings-runtime-mode-switcher">
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
            <div className="button-row settings-action-row">
              <button type="submit" className="primary-button settings-save-button">{t("settingsSaveBinding")}</button>
            </div>
          </form>
        </SettingsModule>

        <SettingsModule title={t("settingsConfigTitle")}>
          <form className="settings-module-form" onSubmit={(event) => void submitConfig(event)}>
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
              <section className="affairs-library-config-section affairs-library-filter-switches">
                <div className="affairs-library-filter-switch-row">
                  <div className="affairs-library-filter-switch-copy">
                    <span>{t("settingsHideDotFiles")}</span>
                    <small>{t("settingsHideDotFilesHint")}</small>
                  </div>
                  <MacSwitch
                    checked={configForm.hideDotFiles}
                    label={t("settingsHideDotFiles")}
                    onChange={(checked) => setConfigForm((current) => ({ ...current, hideDotFiles: checked }))}
                  />
                </div>
                <div className="affairs-library-filter-switch-row">
                  <div className="affairs-library-filter-switch-copy">
                    <span>{t("settingsHideSystemFolders")}</span>
                    <small>{t("settingsHideSystemFoldersHint")}</small>
                  </div>
                  <MacSwitch
                    checked={configForm.hideSystemFolders}
                    label={t("settingsHideSystemFolders")}
                    onChange={(checked) => setConfigForm((current) => ({ ...current, hideSystemFolders: checked }))}
                  />
                </div>
              </section>
              <label>
                <span>{t("settingsIncludedHiddenPaths")}</span>
                <textarea
                  value={configForm.includedHiddenPaths}
                  placeholder={t("settingsIncludedHiddenPathsHint")}
                  rows={2}
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
            <div className="button-row settings-action-row">
              <button type="submit" className="primary-button settings-save-button" disabled={Boolean(configUnavailable)}>
                {t("settingsSaveConfig")}
              </button>
            </div>
          </form>
        </SettingsModule>
      </section>
    ),
    integration: (
      <section className="settings-integration-section">
        <div className="settings-integration-cards" role="list" aria-label={t("settingsIntegrationHubTitle")}>
          <AgentIntegrationSettings />
        </div>
      </section>
    ),
    network: (
      <SettingsModule title={t("settingsServerTitle")}
        description={t("settingsServerDescription")}
        status={t(serverState?.running ? "settingsServerRunning" : "settingsServerStopped")}>
        <form className="settings-module-form" onSubmit={(event) => void submitServer(event)}>
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
          <ServerHostField
            state={serverState}
            value={serverForm.host}
            onChange={(host) => setServerForm((current) => ({
              ...current,
              host
            }))}
          />
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
          <section className="server-auth-settings">
            <div className="server-auth-settings-heading">
              <div>
                <strong>{t("settingsServerAuthTitle")}</strong>
                <span>{t("settingsServerAuthDescription")}</span>
              </div>
              <span className="server-auth-settings-status" data-configured={serverState?.authConfigured ? "true" : "false"}>
                {serverState?.authConfigured ? t("settingsServerAuthConfigured") : t("settingsServerAuthNotConfigured")}
              </span>
            </div>
            <div className="server-auth-settings-fields">
              <label>
                <span>{t("settingsServerAuthUsername")}</span>
                <input
                  autoComplete="username"
                  value={serverForm.authUsername}
                  onChange={(event) => setServerForm((current) => ({ ...current, authUsername: event.target.value }))}
                />
              </label>
              <label>
                <span>{t("settingsServerAuthPassword")}</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={serverState?.authConfigured ? t("settingsServerAuthPasswordPlaceholder") : undefined}
                  value={serverForm.authPassword}
                  onChange={(event) => setServerForm((current) => ({ ...current, authPassword: event.target.value }))}
                />
              </label>
            </div>
            <p>{serverForm.host !== "127.0.0.1" ? t("settingsServerAuthRequiredHint") : t("settingsServerAuthHint")}</p>
          </section>
          <ServerAccessUrls
            state={serverState}
            copiedUrl={copiedServerUrl}
            onCopyUrl={(url) => void copyServerAccessUrl(url, setCopiedServerUrl)}
          />
          <div className="button-row settings-action-row">
            <button type="button" className="secondary-button" onClick={() => void getHttpServerState().then(applyServerState).catch((err) => setServerUnavailable(toApiErrorMessage(err)))}>
              {t("settingsServerRefresh")}
            </button>
            <button type="submit" className="primary-button settings-save-button" disabled={Boolean(serverUnavailable)}>
              {t("settingsServerSave")}
            </button>
          </div>
        </form>
      </SettingsModule>
    ),
    updates: (
      <div className="settings-module-stack">
        <UpdatePanel />
        <ResetApplicationSection
          binding={binding}
          isDesktopContext={isDesktopContext}
          onReset={openResetApplicationModal}
        />
      </div>
    )
  };

  const content = (
    <main className="settings-page">
      {!onClose ? <section className="page-heading">
        <div>
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
      </section> : null}

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
            <InterfaceIcon name={tab.id} className="settings-tab-icon" />
            <span className="settings-tab-copy">
              <span>{t(tab.titleKey)}</span>
            </span>
          </button>
        ))}
      </nav>

      <section
        key={activeTab}
        id={`settings-panel-${activeTab}`}
        className="settings-tab-panel"
        role="tabpanel"
        aria-labelledby={`settings-tab-${activeTab}`}
      >
        {message ? <div className="inline-success" role="status">{message}</div> : null}
        {error ? <div className="inline-alert" role="alert">{error}</div> : null}
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
        <ResetApplicationModal
          open={resetApplicationModal.open}
          binding={binding}
          isDesktopContext={isDesktopContext}
          step={resetApplicationModal.step}
          confirmationText={resetApplicationModal.confirmationText}
          submitting={resetApplicationModal.submitting}
          onConfirmationTextChange={(value) => setResetApplicationModal((current) => ({ ...current, confirmationText: value }))}
          onAdvance={advanceResetApplicationStep}
          onClose={closeResetApplicationModal}
          onSubmit={() => void submitResetApplication()}
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
      <ResetApplicationModal
        open={resetApplicationModal.open}
        binding={binding}
        isDesktopContext={isDesktopContext}
        step={resetApplicationModal.step}
        confirmationText={resetApplicationModal.confirmationText}
        submitting={resetApplicationModal.submitting}
        onConfirmationTextChange={(value) => setResetApplicationModal((current) => ({ ...current, confirmationText: value }))}
        onAdvance={advanceResetApplicationStep}
        onClose={closeResetApplicationModal}
        onSubmit={() => void submitResetApplication()}
      />
    </>
  );
}

function ResetApplicationSection({
  binding,
  isDesktopContext,
  onReset,
}: {
  binding: LibraryBinding | null;
  isDesktopContext: boolean;
  onReset: () => void;
}) {
  const libraryIndexDir = resolveLibraryIndexDir(binding);

  return (
    <SettingsModule title={t("settingsResetTitle")} description={t("settingsResetDescription")}>
      <div className="settings-remote-owner-note" data-tone="danger">
        <strong>{t("settingsResetModalTitle")}</strong>
        <span>{t("settingsResetWarning")}</span>
      </div>
      <ul className="settings-reset-target-list">
        <li>
          <strong>{t("settingsResetTargetAppData")}</strong>
        </li>
        <li>
          <strong>{t("settingsResetTargetBrowser")}</strong>
        </li>
        <li>
          <strong>{t("settingsResetTargetIndex")}</strong>
          <span className="settings-reset-target-path">
            {libraryIndexDir ?? t("settingsResetTargetIndexEmpty")}
          </span>
        </li>
      </ul>
      {!isDesktopContext ? (
        <div className="inline-note">{t("settingsResetDesktopOnly")}</div>
      ) : null}
      <div className="button-row settings-action-row">
        <button type="button" className="danger-button" disabled={!isDesktopContext} onClick={onReset}>
          {t("settingsResetAction")}
        </button>
      </div>
    </SettingsModule>
  );
}

function ResetApplicationModal({
  open,
  binding,
  isDesktopContext,
  step,
  confirmationText,
  submitting,
  onConfirmationTextChange,
  onAdvance,
  onClose,
  onSubmit,
}: {
  open: boolean;
  binding: LibraryBinding | null;
  isDesktopContext: boolean;
  step: 1 | 2 | 3;
  confirmationText: string;
  submitting: boolean;
  onConfirmationTextChange: (value: string) => void;
  onAdvance: () => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const confirmationPhrase = t("settingsResetConfirmPhrase");
  const libraryIndexDir = resolveLibraryIndexDir(binding);
  const canSubmit = confirmationText.trim() === confirmationPhrase && !submitting;

  return (
    <DesktopModal
      open={open}
      title={t("settingsResetModalTitle")}
      description={t("settingsResetModalDescription")}
      size="compact"
      layout="confirm"
      dismissible={!submitting}
      closeOnBackdrop={!submitting}
      closeOnEscape={!submitting}
      onClose={onClose}
      footer={(
        <ModalActions align="between">
          <button type="button" className="secondary-button" disabled={submitting} onClick={onClose}>
            {t("actionCancel")}
          </button>
          {step < 3 ? (
            <button type="button" className="primary-button" disabled={submitting || !isDesktopContext} onClick={onAdvance}>
              {step === 1 ? t("settingsResetFirstContinue") : t("settingsResetSecondContinue")}
            </button>
          ) : (
            <button type="button" className="danger-button" disabled={!canSubmit} onClick={onSubmit}>
              {submitting ? t("settingsResetRestarting") : t("settingsResetSubmit")}
            </button>
          )}
        </ModalActions>
      )}
    >
      <div className="settings-reset-modal-stack">
        <span className="settings-runtime-badge">{t("settingsResetStepLabel", { step })}</span>
        <div className="settings-remote-owner-note" data-tone="danger">
          <strong>{t("settingsResetModalTitle")}</strong>
          <span>{t("settingsResetWarning")}</span>
        </div>
        {step === 1 ? (
          <section className="modal-section">
            <div className="modal-section-copy">
              <h3 className="modal-section-title">{t("settingsResetFirstTitle")}</h3>
              <p className="modal-section-description">{t("settingsResetFirstDescription")}</p>
            </div>
          </section>
        ) : null}
        {step === 2 ? (
          <section className="modal-section">
            <div className="modal-section-copy">
              <h3 className="modal-section-title">{t("settingsResetSecondTitle")}</h3>
              <p className="modal-section-description">{t("settingsResetSecondDescription")}</p>
            </div>
            <ul className="settings-reset-target-list">
              <li>
                <strong>{t("settingsResetTargetAppData")}</strong>
              </li>
              <li>
                <strong>{t("settingsResetTargetBrowser")}</strong>
              </li>
              <li>
                <strong>{t("settingsResetTargetIndex")}</strong>
                <span className="settings-reset-target-path">
                  {libraryIndexDir ?? t("settingsResetTargetIndexEmpty")}
                </span>
              </li>
            </ul>
          </section>
        ) : null}
        {step === 3 ? (
          <section className="modal-section">
            <div className="modal-section-copy">
              <h3 className="modal-section-title">{t("settingsResetThirdTitle")}</h3>
              <p className="modal-section-description">
                {t("settingsResetThirdDescription", { phrase: confirmationPhrase })}
              </p>
            </div>
            <label className="settings-reset-confirm-input">
              <span>{t("settingsResetInputLabel")}</span>
              <input
                value={confirmationText}
                placeholder={t("settingsResetInputPlaceholder", { phrase: confirmationPhrase })}
                onChange={(event) => onConfirmationTextChange(event.target.value)}
              />
            </label>
          </section>
        ) : null}
      </div>
    </DesktopModal>
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
      <div className="settings-index-status-updated">
        <span>{t("settingsIndexUpdatedAt")}</span>
        <time dateTime={status?.lastCompletedAt ?? undefined}>{formatDateTime(status?.lastCompletedAt)}</time>
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

function resolveServerHostOptions(
  state: HttpServerState | null,
  selectedHost: string,
): HttpServerHostOption[] {
  const options = state?.hostOptions?.length
    ? state.hostOptions
    : [
      { value: "0.0.0.0", interfaceName: null },
      { value: "127.0.0.1", interfaceName: null }
    ];
  if (options.some((option) => option.value === selectedHost)) {
    return options;
  }
  return [{ value: selectedHost, interfaceName: null }, ...options];
}

function formatServerHostOption(option: HttpServerHostOption): string {
  if (option.value === "0.0.0.0") {
    return `${t("settingsServerHostAll")} (${option.value})`;
  }
  if (option.value === "127.0.0.1") {
    return `${t("settingsServerHostLocal")} (${option.value})`;
  }
  return `${option.interfaceName ?? t("settingsServerHostNetwork")} (${option.value})`;
}

function formatServerHostTitle(option: HttpServerHostOption): string {
  if (option.value === "0.0.0.0") {
    return t("settingsServerHostAll");
  }
  if (option.value === "127.0.0.1") {
    return t("settingsServerHostLocal");
  }
  return option.interfaceName ?? t("settingsServerHostNetwork");
}

function ServerHostField({
  state,
  value,
  onChange,
}: {
  state: HttpServerState | null;
  value: string;
  onChange: (host: string) => void;
}) {
  const options = resolveServerHostOptions(state, value);
  const selected = options.find((option) => option.value === value) ?? options[0];

  return (
    <label className="server-host-field">
      <span className="server-host-label">{t("settingsServerHost")}</span>
      <span className="server-host-picker">
        <span className="server-host-picker-leading" aria-hidden="true">
          <span className="server-host-picker-icon">
            <InterfaceIcon name="network" />
          </span>
          <span className="server-host-picker-copy">
            <strong>{formatServerHostTitle(selected)}</strong>
            <small>{selected.value}</small>
          </span>
        </span>
        <svg className="server-host-picker-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m7 10 5 5 5-5" />
        </svg>
        <select
          aria-label={t("settingsServerHost")}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  disabled={option.value !== "127.0.0.1" && !state?.authConfigured}
                >
              {formatServerHostOption(option)}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

async function copyServerAccessUrl(
  url: string,
  setCopiedUrl: (value: string | null) => void,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    setCopiedUrl(url);
    window.setTimeout(() => setCopiedUrl(null), 1600);
  } catch {
    setCopiedUrl(null);
  }
}

function ServerAccessUrls({
  state,
  copiedUrl,
  onCopyUrl,
}: {
  state: HttpServerState | null;
  copiedUrl: string | null;
  onCopyUrl: (url: string) => void;
}) {
  return (
    <>
      {state?.running && state.accessUrls?.length ? (
        <div className="server-access">
          <div className="server-access-heading">
            <span>{t("settingsServerAccessUrls")}</span>
            <small>{t("settingsServerAccessUrlsDescription")}</small>
          </div>
          <div className="server-access-list">
            {state.accessUrls.map((url) => (
              <div className="server-access-row" key={url}>
                <input aria-label={t("settingsServerAccessUrlLabel", { url })} readOnly value={url} />
                <button type="button" className="secondary-button" onClick={() => onCopyUrl(url)}>
                  {copiedUrl === url ? t("settingsServerCopied") : t("settingsServerCopy")}
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
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

function clearLocalStorageByPrefix(prefix: string): void {
  if (typeof window === "undefined") {
    return;
  }
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key) {
      keys.push(key);
    }
  }
  for (const key of keys) {
    if (key.startsWith(prefix)) {
      window.localStorage.removeItem(key);
    }
  }
}

function resolveLibraryIndexDir(binding: LibraryBinding | null): string | null {
  const rootDir = binding?.rootDir?.trim();
  return rootDir ? `${rootDir.replace(/\/+$/g, "")}/.ai-index` : null;
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
