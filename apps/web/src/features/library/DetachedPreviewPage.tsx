import { useEffect, useState } from "react";
import type { LibraryPreview, LibrarySnapshot } from "@x-file/shared";

import { getLibraryPreview, getLibrarySnapshot } from "../../api/library";
import { toApiErrorMessage } from "../../api/http";
import { t } from "../../i18n";
import { getPathName } from "../../shared/format";
import { getRuntimeConfigSnapshot } from "../../runtime/runtime-config-store";
import { LibraryPreviewRenderer } from "./LibraryPreviewRenderer";

export function DetachedPreviewPage({ path, title }: { path: string; title: string }) {
  const [preview, setPreview] = useState<LibraryPreview | null>(null);
  const [snapshot, setSnapshot] = useState<LibrarySnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([
      getLibraryPreview(path, "reading"),
      getLibrarySnapshot(),
    ]).then(([nextPreview, nextSnapshot]) => {
      if (!active) return;
      setPreview(nextPreview);
      setSnapshot(nextSnapshot);
    }).catch((reason: unknown) => {
      if (active) setError(toApiErrorMessage(reason));
    });
    return () => {
      active = false;
    };
  }, [path]);

  const runtimeConfig = getRuntimeConfigSnapshot().config;
  const localRootDir = runtimeConfig.mode === "mirror"
    ? runtimeConfig.localRootDir || snapshot?.binding?.mirrorRoot || null
    : snapshot?.binding?.rootDir || null;
  const localFilePath = localRootDir
    ? `${localRootDir.replace(/\/+$/g, "")}/${path.replace(/^\/+/, "")}`
    : null;

  return (
    <main className="library-detached-preview-page">
      <header className="library-detached-preview-header">
        <strong>{title || getPathName(path)}</strong>
        <span>{path}</span>
      </header>
      {error ? <div className="office-preview-state office-preview-error" role="alert">{error}</div> : null}
      {!error && !preview ? <div className="office-preview-state" role="status">{t("fileViewerOfficeLoading")}</div> : null}
      {preview ? (
        preview.supported ? (
          <LibraryPreviewRenderer
            preview={preview}
            content={preview.content || ""}
            layout="standalone"
            localFilePath={localFilePath}
          />
        ) : (
          <div className="office-preview-state office-preview-error" role="status">
            {preview.reason || t("libraryPreviewUnsupported")}
          </div>
        )
      ) : null}
    </main>
  );
}
