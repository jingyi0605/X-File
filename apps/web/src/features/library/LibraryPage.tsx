import { useEffect, useState, type FormEvent } from "react";
import type {
  LibraryDirectorySource,
  LibraryDirectoryState,
  LibraryFavoriteKind,
  LibraryFavoriteRecord,
  LibraryIndexState,
  LibraryPreview
} from "@x-file/shared";

import { getFolderTagDetails, saveDocumentTags, saveFolderTags } from "../../api/library";
import { toApiErrorMessage } from "../../api/http";
import { t } from "../../i18n";
import { formatBytes, formatDateTime, getPathName } from "../../shared/format";
import { resolveDocumentVisual } from "./document-visual";
import { useLibraryState, type LibraryState } from "./useLibraryState";
import type { LibraryEntry, LibrarySortDirection, LibrarySortMode } from "./library-view-state";

interface LibraryPageProps {
  onOpenSettings: () => void;
}

export function LibraryPage({ onOpenSettings }: LibraryPageProps) {
  const library = useLibraryState();
  const binding = library.snapshot?.binding ?? null;

  if (!binding) {
    return <LibraryBindingPanel library={library} onOpenSettings={onOpenSettings} />;
  }

  return (
    <main className="library-page">
      <section className="page-heading library-heading">
        <div>
          <p className="eyebrow">{t("appTagline")}</p>
          <h1>{t("libraryTitle")}</h1>
          <p className="page-subtitle">{t("librarySubtitle")}</p>
        </div>
        <div className="heading-actions">
          <button type="button" className="secondary-button" onClick={() => void library.reload()}>
            {t("libraryReload")}
          </button>
          <button type="button" className="primary-button" disabled={!binding || library.refreshPending} onClick={() => void library.refresh()}>
            {library.refreshPending ? t("libraryRefreshing") : t("libraryRefresh")}
          </button>
        </div>
      </section>

      <section className="summary-strip">
        <div>
          <span className={resolveStatusDotClass(library.snapshot?.status.state, binding?.enabled)} />
          {binding
            ? binding.enabled
              ? t("librarySummaryBound", { rootDir: binding.rootDir })
              : t("librarySummaryDisabled")
            : t("librarySummaryUnbound")}
        </div>
        <div>{t("libraryStatusTitle")}：{resolveIndexStatusLabel(library.snapshot?.status.state)}</div>
        <div>{t("libraryCountDocuments", { count: library.snapshot?.documentCount ?? 0 })}</div>
      </section>

      <LibraryStatusPanel library={library} />

      {library.error ? (
        <section className="inline-alert">
          <strong>{t("libraryErrorTitle")}</strong>
          <span>{library.error}</span>
        </section>
      ) : null}

      <section className="library-workspace">
        <LibrarySidebar library={library} />
        <LibraryStage library={library} />
        <LibraryDetail library={library} />
      </section>
    </main>
  );
}

function LibraryBindingPanel({ library, onOpenSettings }: { library: LibraryState; onOpenSettings: () => void }) {
  const [rootDir, setRootDir] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const nextRootDir = rootDir.trim();
    if (!nextRootDir) {
      setError(t("settingsRequiredRootDir"));
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await library.bindLibrary(nextRootDir);
      setRootDir("");
    } catch (err) {
      setError(toApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="library-init-page">
      <section className="library-init-panel">
        <header className="library-init-header">
          <span className="affairs-inline-pill">{t("libraryInitPill")}</span>
          <h1>{t("libraryInitTitle")}</h1>
          <p>{t("libraryInitSubtitle")}</p>
        </header>

        <div className="library-init-body">
          <form className="library-init-form" onSubmit={(event) => void submit(event)}>
            <label>
              <span>{t("settingsRootDir")}</span>
              <input
                value={rootDir}
                placeholder={t("settingsRootDirPlaceholder")}
                onChange={(event) => setRootDir(event.target.value)}
              />
            </label>
            <p className="muted-copy">{t("libraryBindingInlineHint")}</p>
            {error ? <div className="inline-alert compact">{error}</div> : null}
            {library.error ? <div className="inline-alert compact">{library.error}</div> : null}
            <div className="button-row">
              <button type="submit" className="primary-button" disabled={saving}>
                {saving ? t("settingsSaving") : t("libraryInitSubmit")}
              </button>
              <button type="button" className="secondary-button" onClick={() => void library.reload()}>
                {t("libraryReload")}
              </button>
              <button type="button" className="secondary-button" onClick={onOpenSettings}>
                {t("libraryInitOpenAdvanced")}
              </button>
            </div>
          </form>

          <aside className="library-init-preview" aria-label={t("libraryInitPreviewTitle")}>
            <div className="library-init-avatar">XF</div>
            <strong>{t("libraryInitPreviewTitle")}</strong>
            <p>{t("libraryInitPreviewCopy")}</p>
            <ul>
              <li>{t("libraryInitBenefitLocal")}</li>
              <li>{t("libraryInitBenefitIndex")}</li>
              <li>{t("libraryInitBenefitOffice")}</li>
            </ul>
          </aside>
        </div>
      </section>
    </main>
  );
}

function LibraryStatusPanel({ library }: { library: LibraryState }) {
  const status = library.snapshot?.status;
  if (!status) {
    return null;
  }

  return (
    <section className="status-panel">
      <StatusItem label={t("libraryStatusLastRequested")} value={formatDateTime(status.lastRequestedAt)} />
      <StatusItem label={t("libraryStatusLastStarted")} value={formatDateTime(status.lastStartedAt)} />
      <StatusItem label={t("libraryStatusLastCompleted")} value={formatDateTime(status.lastCompletedAt)} />
      <StatusItem label={t("libraryStatusLastFailed")} value={formatDateTime(status.lastFailedAt)} />
      <StatusItem label={t("libraryStatusRunningStage")} value={status.runningStage ?? t("commonNone")} />
      <StatusItem label={t("libraryStatusDirtyReasons")} value={status.dirtyReasons.length ? status.dirtyReasons.join(", ") : t("commonNone")} />
      <StatusItem label={t("libraryStatusErrorSummary")} value={status.errorSummary ?? library.snapshot?.lastError ?? t("commonNone")} />
      {status.progress ? (
        <StatusItem
          label={t("libraryStatusProgress")}
          value={t("libraryProgressSummary", {
            scanned: status.progress.scannedCount,
            indexed: status.progress.indexedCount,
            failed: status.progress.failedCount
          })}
        />
      ) : null}
    </section>
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function LibrarySidebar({ library }: { library: LibraryState }) {
  const snapshot = library.snapshot;
  const currentFolder = library.viewState.selectedFolderPath;
  const selectedTagPath = library.viewState.selectedTagPath;

  return (
    <aside className="library-sidebar">
      <div className="sidebar-section">
        <div className="section-header">
          <h2>{t("libraryBrowse")}</h2>
        </div>
        <button
          type="button"
          className={!currentFolder && library.viewState.browseMode === "folder" ? "nav-row active" : "nav-row"}
          onClick={() => library.selectFolder(null)}
        >
          <span>{t("libraryAllFiles")}</span>
          <small>{t("libraryCountDocuments", { count: snapshot?.documentCount ?? 0 })}</small>
        </button>
        <div className="folder-list">
          {(snapshot?.folders ?? []).slice(0, 24).map((folder) => (
            <button
              key={folder.path}
              type="button"
              className={currentFolder === folder.path ? "nav-row active" : "nav-row"}
              onClick={() => library.selectFolder(folder.path)}
            >
              <span>{folder.name || getPathName(folder.path)}</span>
              <small>{t("libraryCountDocuments", { count: folder.documentCount })}</small>
            </button>
          ))}
        </div>
      </div>

      <div className="sidebar-section">
        <div className="section-header">
          <h2>{t("libraryFavorites")}</h2>
          <small>{t("libraryCountFavorites", { count: snapshot?.favorites.length ?? 0 })}</small>
        </div>
        {(snapshot?.favorites.length ?? 0) === 0 ? (
          <p className="muted-copy">{t("libraryEmptyFavorite")}</p>
        ) : (
          snapshot?.favorites.map((favorite) => (
            <button
              key={`${favorite.kind}:${favorite.path}`}
              type="button"
              className={library.viewState.selectedFavoriteId === favorite.path ? "nav-row active" : "nav-row"}
              onClick={() => library.selectFavorite(favorite)}
            >
              <span>{favorite.label || favorite.path}</span>
              <small>{resolveFavoriteKindLabel(favorite.kind)}</small>
            </button>
          ))
        )}
      </div>

      <div className="sidebar-section">
        <div className="section-header">
          <h2>{t("libraryTags")}</h2>
        </div>
        <button
          type="button"
          className={!selectedTagPath && library.viewState.browseMode === "tag" ? "nav-row active" : "nav-row"}
          onClick={() => library.selectTag(null)}
        >
          <span>{t("libraryTags")}</span>
          <small>{t("libraryCountDocuments", { count: snapshot?.documentCount ?? 0 })}</small>
        </button>
        {(library.tags.length ? library.tags : snapshot?.tags ?? []).slice(0, 36).map((tag) => (
          <button
            key={tag.path}
            type="button"
            className={selectedTagPath === tag.path ? "nav-row active" : "nav-row"}
            onClick={() => library.selectTag(tag.path)}
          >
            <span>{tag.name}</span>
            <small>{tag.documentCount}</small>
          </button>
        ))}
      </div>
    </aside>
  );
}

function LibraryStage({ library }: { library: LibraryState }) {
  const currentPath = library.viewState.browseMode === "folder"
    ? library.viewState.selectedFolderPath
    : library.viewState.selectedTagPath;
  const directoryStatus = library.documentPage?.directoryStatus ?? null;

  return (
    <section className="library-stage">
      <div className="stage-toolbar">
        <div>
          <p className="toolbar-label">{library.viewState.browseMode === "folder" ? t("libraryCurrentFolder") : t("libraryTags")}</p>
          <h2>{currentPath ? getPathName(currentPath) : t("libraryRootFolder")}</h2>
          <Breadcrumbs path={library.viewState.browseMode === "folder" ? library.viewState.selectedFolderPath : null} onSelect={library.selectFolder} />
          {directoryStatus ? (
            <p className="muted-copy">
              {resolveDirectoryStateLabel(directoryStatus.state)} · {resolveDirectorySourceLabel(directoryStatus.source)}
              {directoryStatus.errorSummary ? ` · ${directoryStatus.errorSummary}` : ""}
            </p>
          ) : null}
        </div>
        <div className="toolbar-actions">
          <input
            className="search-input"
            value={library.viewState.keyword}
            placeholder={t("libraryKeywordPlaceholder")}
            onChange={(event) => library.setViewState((current) => ({ ...current, keyword: event.target.value }))}
          />
          <select
            value={library.viewState.librarySort.mode}
            onChange={(event) => library.setViewState((current) => ({
              ...current,
              librarySort: { ...current.librarySort, mode: event.target.value as LibrarySortMode }
            }))}
          >
            <option value="recent">{t("librarySortRecent")}</option>
            <option value="name">{t("librarySortName")}</option>
            <option value="type">{t("librarySortType")}</option>
            <option value="size">{t("librarySortSize")}</option>
            <option value="createdAt">{t("librarySortCreatedAt")}</option>
          </select>
          <select
            value={library.viewState.librarySort.direction}
            onChange={(event) => library.setViewState((current) => ({
              ...current,
              librarySort: { ...current.librarySort, direction: event.target.value as LibrarySortDirection }
            }))}
          >
            <option value="desc">{t("librarySortDesc")}</option>
            <option value="asc">{t("librarySortAsc")}</option>
          </select>
          <div className="segmented-control">
            <button
              type="button"
              className={library.viewState.viewMode === "grid" ? "active" : ""}
              onClick={() => library.setViewState((current) => ({ ...current, viewMode: "grid" }))}
            >
              {t("libraryViewGrid")}
            </button>
            <button
              type="button"
              className={library.viewState.viewMode === "list" ? "active" : ""}
              onClick={() => library.setViewState((current) => ({ ...current, viewMode: "list" }))}
            >
              {t("libraryViewList")}
            </button>
          </div>
        </div>
      </div>

      <div className="stage-quick-actions">
        <button type="button" className="secondary-button" onClick={() => void toggleCurrentFavorite(library)}>
          {resolveCurrentFavorite(library) ? t("libraryFavoriteRemove") : resolveCurrentFavoriteLabel(library)}
        </button>
        {library.viewState.browseMode === "folder" ? (
          <>
            <button type="button" className="secondary-button" onClick={() => void createFolder(library)}>
              {t("libraryCreateFolder")}
            </button>
            <button type="button" className="secondary-button" onClick={() => void createFile(library)}>
              {t("libraryCreateFile")}
            </button>
          </>
        ) : null}
        <button type="button" className="secondary-button" onClick={() => void library.reloadDocuments(true)}>
          {t("libraryReloadCurrent")}
        </button>
      </div>

      <FolderTagPanel library={library} />

      {library.loading || library.documentsLoading ? (
        <div className="stage-loading">{library.loading ? t("libraryLoading") : t("libraryDocumentsLoading")}</div>
      ) : library.entries.length === 0 ? (
        <div className="stage-empty">
          {library.viewState.browseMode === "tag" ? t("libraryEmptyTag") : t("libraryEmptyFolder")}
        </div>
      ) : (
        <div className={library.viewState.viewMode === "grid" ? "library-entry-grid" : "library-entry-list"}>
          {library.entries.map((entry) => (
            <LibraryEntryCard key={`${entry.kind}:${entry.kind === "folder" ? entry.path : entry.documentId}`} entry={entry} library={library} />
          ))}
        </div>
      )}

      {library.hasMore ? (
        <button type="button" className="load-more-button" disabled={library.documentsLoading} onClick={() => void library.loadMore()}>
          {t("libraryLoadMore")}
        </button>
      ) : null}
    </section>
  );
}

function LibraryEntryCard({ entry, library }: { entry: LibraryEntry; library: LibraryState }) {
  if (entry.kind === "folder") {
    return (
      <button type="button" className="library-entry folder" onClick={() => library.selectFolder(entry.path)}>
        <span className="folder-icon">DIR</span>
        <strong>{entry.name}</strong>
        <small>{t("libraryCountDocuments", { count: entry.documentCount })}</small>
      </button>
    );
  }

  const visual = resolveDocumentVisual(entry.path);
  const active = library.viewState.selectedDocumentId === entry.documentId;
  return (
    <article className={active ? "library-entry document active" : "library-entry document"}>
      <button type="button" className="entry-main" onClick={() => library.selectDocument(entry.documentId)}>
        <span className={`doc-badge tone-${visual.tone}`}>{visual.badge}</span>
        <span>
          <strong>{entry.title || t("libraryUntitled")}</strong>
          <small>{entry.path}</small>
        </span>
      </button>
      <p>{entry.summary || t("libraryPreviewEmpty")}</p>
      <div className="entry-meta">
        <span>{formatBytes(entry.sizeBytes)}</span>
        <span>{formatDateTime(entry.updatedAt)}</span>
      </div>
      <div className="entry-actions">
        <button type="button" className="secondary-button" onClick={() => library.selectDocument(entry.documentId)}>
          {t("libraryDetails")}
        </button>
        <button type="button" className="secondary-button" onClick={() => void library.openPreview(entry.path)}>
          {t("libraryPreview")}
        </button>
      </div>
    </article>
  );
}

function LibraryDetail({ library }: { library: LibraryState }) {
  const selected = library.selectedDocument;
  const preview = library.preview;

  return (
    <aside className="library-detail">
      <div className="section-header">
        <h2>{t("libraryDetails")}</h2>
      </div>
      {!selected ? (
        <div className="detail-empty">{t("libraryNoSelection")}</div>
      ) : (
        <>
          <div className="detail-title">
            <span className={`doc-badge tone-${resolveDocumentVisual(selected.path).tone}`}>
              {resolveDocumentVisual(selected.path).badge}
            </span>
            <div>
              <h3>{selected.title || t("libraryUntitled")}</h3>
              <p>{selected.path}</p>
            </div>
          </div>

          <div className="detail-actions">
            <button type="button" className="primary-button" onClick={() => void library.openPreview(selected.path)}>
              {t("libraryPreview")}
            </button>
            <button type="button" className="secondary-button" onClick={() => void library.downloadSelected(selected.path)}>
              {t("libraryDownload")}
            </button>
            <button type="button" className="secondary-button" onClick={() => void renameSelected(library, selected.path)}>
              {t("libraryRename")}
            </button>
            <button type="button" className="danger-button" onClick={() => void deleteSelected(library, selected.path)}>
              {t("libraryDelete")}
            </button>
          </div>

          <DetailRow label={t("libraryMetaSummary")} value={selected.summary || t("commonNone")} />
          <DetailRow label={t("libraryMetaSize")} value={formatBytes(selected.sizeBytes)} />
          <DetailRow label={t("libraryMetaUpdatedAt")} value={formatDateTime(selected.updatedAt)} />
          <DetailRow label={t("libraryMetaCreatedAt")} value={formatDateTime(selected.createdAt)} />
          <TagPills label={t("libraryMetaTags")} items={selected.tags} />
          <TagPills label={t("libraryMetaDerivedTags")} items={selected.derivedTags} />
          <DocumentTagEditor key={selected.documentId} library={library} documentId={selected.documentId} />

          <PreviewPanel preview={preview} loading={library.previewLoading} error={library.previewError} />
        </>
      )}
    </aside>
  );
}

function PreviewPanel({ preview, loading, error }: { preview: LibraryPreview | null; loading: boolean; error: string | null }) {
  if (loading) {
    return <div className="preview-box">{t("libraryDocumentsLoading")}</div>;
  }

  if (error) {
    return <div className="preview-box error">{error}</div>;
  }

  if (!preview) {
    return <div className="preview-box">{t("libraryPreviewEmpty")}</div>;
  }

  if (!preview.supported) {
    return <div className="preview-box">{preview.reason || t("libraryPreviewUnsupported")}</div>;
  }

  if (preview.kind === "image" && preview.previewUrl) {
    return <img className="preview-image" src={preview.previewUrl} alt={preview.path} />;
  }

  if ((preview.kind === "pdf" || preview.kind === "html") && preview.previewUrl) {
    return (
      <a className="preview-link" href={preview.previewUrl} target="_blank" rel="noreferrer">
        {t("libraryPreviewOpenResource")}
      </a>
    );
  }

  if (preview.kind === "office" && preview.onlyOffice) {
    return (
      <div className="preview-box">
        <a className="preview-link" href={preview.onlyOffice.documentUrl} target="_blank" rel="noreferrer">
          {t("libraryPreviewOnlyOffice")}
        </a>
        <small>{preview.onlyOffice.editorMode === "edit" ? t("libraryPreviewOfficeEdit") : t("libraryPreviewOfficeView")}</small>
      </div>
    );
  }

  return (
    <div>
      <PreviewCapabilities preview={preview} />
      <pre className="preview-box text">{preview.content || t("libraryPreviewEmpty")}</pre>
    </div>
  );
}

function PreviewCapabilities({ preview }: { preview: LibraryPreview }) {
  const enabled = [
    preview.capabilities.canEdit ? t("libraryCapabilityEdit") : null,
    preview.capabilities.canRefresh ? t("libraryCapabilityRefresh") : null,
    preview.capabilities.canResize ? t("libraryCapabilityResize") : null,
    preview.capabilities.canZoom ? t("libraryCapabilityZoom") : null,
    preview.capabilities.canPaginate ? t("libraryCapabilityPaginate") : null
  ].filter((item): item is string => Boolean(item));

  return (
    <div className="capability-row">
      <span>{t("libraryPreviewCapabilities")}</span>
      <strong>{enabled.length ? enabled.join(", ") : t("commonNone")}</strong>
    </div>
  );
}

function DocumentTagEditor({ library, documentId }: { library: LibraryState; documentId: string }) {
  const selected = library.selectedDocument;
  const [value, setValue] = useState(() => selected?.tags.join(", ") ?? "");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(): Promise<void> {
    setSaving(true);
    setMessage(null);
    try {
      await saveDocumentTags(documentId, { createTagPaths: splitTagInput(value) });
      setMessage(t("settingsSaveSuccess"));
      await library.reload();
      await library.reloadDocuments(true);
    } catch (err) {
      setMessage(toApiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="tag-editor">
      <label>
        <span>{t("libraryEditTags")}</span>
        <input value={value} placeholder={t("libraryEditTagsPlaceholder")} onChange={(event) => setValue(event.target.value)} />
      </label>
      <button type="button" className="secondary-button" disabled={saving} onClick={() => void save()}>
        {saving ? t("settingsSaving") : t("librarySaveTags")}
      </button>
      {message ? <small>{message}</small> : null}
    </div>
  );
}

function FolderTagPanel({ library }: { library: LibraryState }) {
  const folderPath = library.viewState.browseMode === "folder" ? library.viewState.selectedFolderPath ?? "" : null;
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (folderPath === null) {
      return;
    }

    let cancelled = false;
    void getFolderTagDetails(folderPath)
      .then((details) => {
        if (!cancelled) {
          setValue(details.bindings.map((item) => item.tagPath).filter(Boolean).join(", "));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setMessage(toApiErrorMessage(err));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [folderPath]);

  if (folderPath === null) {
    return null;
  }

  async function save(): Promise<void> {
    try {
      await saveFolderTags({ folderPath: folderPath ?? "", createTagPaths: splitTagInput(value) });
      setMessage(t("settingsSaveSuccess"));
      await library.reload();
    } catch (err) {
      setMessage(toApiErrorMessage(err));
    }
  }

  return (
    <div className="folder-tag-panel">
      <label>
        <span>{t("libraryFolderTags")}</span>
        <input value={value} placeholder={t("libraryFolderTagsPlaceholder")} onChange={(event) => setValue(event.target.value)} />
      </label>
      <button type="button" className="secondary-button" onClick={() => void save()}>
        {t("librarySaveTags")}
      </button>
      {message ? <small>{message}</small> : null}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TagPills({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="tag-group">
      <span>{label}</span>
      <div>
        {items.length ? items.map((item) => <mark key={item}>{item}</mark>) : <small>{t("libraryNoTags")}</small>}
      </div>
    </div>
  );
}

function resolveIndexStatusLabel(state: LibraryIndexState | undefined): string {
  switch (state) {
    case "fresh":
      return t("libraryStatusFresh");
    case "stale":
      return t("libraryStatusStale");
    case "queued":
      return t("libraryStatusQueued");
    case "running":
      return t("libraryStatusRunning");
    case "queue_timeout":
      return t("libraryStatusQueueTimeout");
    case "cooldown":
      return t("libraryStatusCooldown");
    case "failed":
      return t("libraryStatusFailed");
    default:
      return t("libraryStatusUnknown");
  }
}

function resolveDirectoryStateLabel(state: LibraryDirectoryState): string {
  const labels: Record<LibraryDirectoryState, string> = {
    idle: t("libraryDirectoryStateIdle"),
    queued: t("libraryDirectoryStateQueued"),
    running: t("libraryDirectoryStateRunning"),
    queue_timeout: t("libraryDirectoryStateQueueTimeout"),
    fresh: t("libraryDirectoryStateFresh"),
    failed: t("libraryDirectoryStateFailed")
  };
  return labels[state];
}

function resolveDirectorySourceLabel(source: LibraryDirectorySource): string {
  const labels: Record<LibraryDirectorySource, string> = {
    live: t("libraryDirectorySourceLive"),
    snapshot: t("libraryDirectorySourceSnapshot"),
    mixed: t("libraryDirectorySourceMixed"),
    stale_fallback: t("libraryDirectorySourceStaleFallback")
  };
  return labels[source];
}

function resolveFavoriteKindLabel(kind: LibraryFavoriteKind): string {
  const labels: Record<LibraryFavoriteKind, string> = {
    folder: t("libraryFavoriteFolder"),
    tag: t("libraryFavoriteTag"),
    tag_filter: t("libraryFavoriteTagFilter")
  };
  return labels[kind];
}

function Breadcrumbs({ path, onSelect }: { path: string | null; onSelect: (path: string | null) => void }) {
  const segments = path?.split("/").filter(Boolean) ?? [];
  if (!segments.length) {
    return <div className="breadcrumbs"><button type="button" onClick={() => onSelect(null)}>{t("libraryRootFolder")}</button></div>;
  }

  return (
    <div className="breadcrumbs">
      <button type="button" onClick={() => onSelect(null)}>{t("libraryRootFolder")}</button>
      {segments.map((segment, index) => {
        const nextPath = segments.slice(0, index + 1).join("/");
        return (
          <button key={nextPath} type="button" onClick={() => onSelect(nextPath)}>
            {segment}
          </button>
        );
      })}
    </div>
  );
}

function resolveCurrentFavorite(library: LibraryState): LibraryFavoriteRecord | null {
  const favorite = buildCurrentFavorite(library);
  if (!favorite) {
    return null;
  }
  return library.snapshot?.favorites.find((item) => item.kind === favorite.kind && item.path === favorite.path) ?? null;
}

function buildCurrentFavorite(library: LibraryState): LibraryFavoriteRecord | null {
  if (library.viewState.browseMode === "folder") {
    const path = library.viewState.selectedFolderPath ?? "";
    return {
      kind: "folder",
      path,
      label: path ? getPathName(path) : t("libraryRootFolder")
    };
  }

  const tagPath = library.viewState.selectedTagPath;
  if (!tagPath) {
    return null;
  }

  return {
    kind: library.viewState.selectedTagPaths.length > 1 ? "tag_filter" : "tag",
    path: tagPath,
    label: getPathName(tagPath),
    tagPaths: library.viewState.selectedTagPaths.length ? library.viewState.selectedTagPaths : [tagPath]
  };
}

function resolveCurrentFavoriteLabel(library: LibraryState): string {
  return library.viewState.browseMode === "folder" ? t("libraryFavoriteAddFolder") : t("libraryFavoriteAddTag");
}

async function toggleCurrentFavorite(library: LibraryState): Promise<void> {
  const favorite = buildCurrentFavorite(library);
  if (favorite) {
    await library.toggleFavorite(favorite);
  }
}

async function createFolder(library: LibraryState): Promise<void> {
  const name = window.prompt(t("libraryCreateFolderPrompt"));
  const normalized = name?.trim();
  if (!normalized) {
    return;
  }
  await library.operateFile({
    opType: "create_directory",
    dstPath: joinPath(library.viewState.selectedFolderPath, normalized)
  });
}

async function createFile(library: LibraryState): Promise<void> {
  const name = window.prompt(t("libraryCreateFilePrompt"));
  const normalized = name?.trim();
  if (!normalized) {
    return;
  }
  await library.operateFile({
    opType: "create_file",
    dstPath: joinPath(library.viewState.selectedFolderPath, normalized),
    content: ""
  });
}

async function renameSelected(library: LibraryState, path: string): Promise<void> {
  const nextName = window.prompt(t("libraryRenamePrompt"), getPathName(path));
  const normalized = nextName?.trim();
  if (!normalized) {
    return;
  }
  await library.operateFile({
    opType: "move",
    srcPath: path,
    dstPath: joinPath(getParentPath(path), normalized)
  });
}

async function deleteSelected(library: LibraryState, path: string): Promise<void> {
  if (!window.confirm(t("libraryDeleteConfirm", { path }))) {
    return;
  }
  await library.operateFile({ opType: "delete", srcPath: path });
}

function joinPath(basePath: string | null | undefined, name: string): string {
  const base = basePath?.trim().replace(/\/+$/, "");
  return base ? `${base}/${name}` : name;
}

function getParentPath(path: string): string | null {
  const segments = path.split("/").filter(Boolean);
  segments.pop();
  return segments.length ? segments.join("/") : null;
}

function splitTagInput(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function resolveStatusDotClass(state: LibraryIndexState | undefined, enabled: boolean | undefined): string {
  if (!enabled) {
    return "status-dot muted";
  }
  if (state === "failed" || state === "queue_timeout") {
    return "status-dot failed";
  }
  if (state === "running" || state === "queued" || state === "stale") {
    return "status-dot warn";
  }
  return "status-dot fresh";
}
