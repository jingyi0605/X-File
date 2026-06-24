import type { RuntimeConfig } from "../../types/runtime-config.js";
import type { ExportDocumentRecord } from "../../repositories/catalog-repository.js";
import { SUPPORTED_INDEX_EXTENSION_LIST } from "../../scanner/file-scanner.js";
import { buildLibraryExport } from "../export/export-builder.js";
import { DirtyScopeResolver, type DirtyScope } from "../dirty/dirty-scope-resolver.js";
import { executeTextIndex } from "./text-indexer.js";
import {
  createDefaultRuntimeBackedTextIndexStores,
} from "./text-index-catalog-store.js";
import {
  createSqliteAllowedExtensionsStore,
  type AllowedExtensionsStore,
} from "./allowed-extensions-store.js";
import { refreshRuntimeActiveFileStateSnapshot } from "../../library-index-tool.js";

const APPLIED_ALLOWED_EXTENSIONS_META_KEY = "config.allowed_extensions.applied";

function normalizeExtensions(values: string[]): string[] {
  return [...new Set(
    values
      .map(item => item.trim().toLowerCase())
      .filter(Boolean)
      .map(item => item.startsWith(".") ? item : `.${item}`),
  )].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function subtractExtensions(base: string[], removing: string[]): string[] {
  const removed = new Set(removing);
  return base.filter(item => !removed.has(item));
}

function uniqueDocuments(documents: ExportDocumentRecord[]): ExportDocumentRecord[] {
  const map = new Map<string, ExportDocumentRecord>();
  for (const document of documents) {
    map.set(document.documentId, document);
  }
  return [...map.values()];
}

function createExportSummary(
  dirtyScope: DirtyScope,
  exportResult: Awaited<ReturnType<typeof buildLibraryExport>>,
) {
  return {
    exportResult: {
      metaShardCount: exportResult.metaShardCount,
      detailShardCount: exportResult.detailShardCount,
      tagShardCount: exportResult.tagShardCount,
      exportedAt: exportResult.exportedAt,
    },
    dirtyScope,
  };
}

async function buildConfiguredExports(
  config: RuntimeConfig,
  dirtyScope: DirtyScope,
  signal?: AbortSignal,
) {
  const exportResult = await buildLibraryExport(config, { dirtyScope, signal });
  return createExportSummary(dirtyScope, exportResult);
}

function createEmptyIncrementalIndexResult(dirtyScope: DirtyScope) {
  return {
    scannedCount: 0,
    indexedCount: 0,
    unchangedCount: 0,
    indexedPaths: [] as string[],
    skippedPaths: [] as string[],
    failedPaths: [] as string[],
    failedCount: 0,
    failures: [] as Array<{ path: string; errorCode: string; message: string }>,
    failureOverflowCount: 0,
    deletedCount: 0,
    deletedPaths: [] as string[],
    dirtyScope,
    timingsMs: {
      scanFs: 0,
      parse: 0,
      tagInference: 0,
      skipCatalog: 0,
      writeIndexed: 0,
      writeSkipped: 0,
      scanAndParse: 0,
      writeSuccess: 0,
      writeFailure: 0,
      scanLoop: 0,
      cleanup: 0,
      reconcile: 0,
      dirtyScope: 0,
      total: 0,
    },
    batchStats: {
      writeBatchSize: 0,
      successBatchCount: 0,
      failureBatchCount: 0,
    },
    tagStats: {
      directAssignedCount: 0,
      derivedAssignedCount: 0,
      avgDirectPerIndexedDocument: 0,
      avgDerivedPerIndexedDocument: 0,
    },
    skipStats: {
      skippedCount: 0,
      skippedByExtension: {},
      skipCatalogRecords: 0,
    },
  };
}

export interface AllowedExtensionsDiffApplyResult {
  changed: boolean;
  addedExtensions: string[];
  removedExtensions: string[];
  dirtyScope: DirtyScope;
  indexResult: ReturnType<typeof createEmptyIncrementalIndexResult>;
  exportResult: ReturnType<typeof createExportSummary>["exportResult"] | null;
}

export interface AllowedExtensionsDiffDependencies {
  store?: AllowedExtensionsStore;
}

export class AllowedExtensionsDiffService {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly dependencies: AllowedExtensionsDiffDependencies = {},
  ) {}

  private resolveEffectiveAllowedExtensions(): string[] {
    return normalizeExtensions(
      this.config.allowedExtensions.length > 0
        ? this.config.allowedExtensions
        : SUPPORTED_INDEX_EXTENSION_LIST,
    );
  }

  private inferPreviouslyAppliedExtensions(store: AllowedExtensionsStore): string[] {
    const extensions = normalizeExtensions(store.listActiveFileExtensions());
    return extensions.length > 0 ? extensions : normalizeExtensions(SUPPORTED_INDEX_EXTENSION_LIST);
  }

  private loadPreviouslyAppliedExtensions(
    store: AllowedExtensionsStore,
  ): string[] {
    const raw = store.getSchemaMeta(APPLIED_ALLOWED_EXTENSIONS_META_KEY);
    if (typeof raw === "string" && raw.trim()) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) {
          return normalizeExtensions(parsed.filter((item): item is string => typeof item === "string"));
        }
      } catch (_) {
        return normalizeExtensions(SUPPORTED_INDEX_EXTENSION_LIST);
      }
    }

    return this.inferPreviouslyAppliedExtensions(store);
  }

  syncCurrentAsApplied(): void {
    const store = this.dependencies.store ?? createSqliteAllowedExtensionsStore({
      dbPath: this.config.dbPath,
    });
    store.setSchemaMeta(
      APPLIED_ALLOWED_EXTENSIONS_META_KEY,
      JSON.stringify(this.resolveEffectiveAllowedExtensions()),
    );
  }

  async applyIfNeeded(signal?: AbortSignal): Promise<AllowedExtensionsDiffApplyResult> {
    const store = this.dependencies.store ?? createSqliteAllowedExtensionsStore({
      dbPath: this.config.dbPath,
    });
    const effectiveCurrent = this.resolveEffectiveAllowedExtensions();
    const previous = this.loadPreviouslyAppliedExtensions(store);
    const addedExtensions = subtractExtensions(effectiveCurrent, previous);
    const removedExtensions = subtractExtensions(previous, effectiveCurrent);

    const resolver = new DirtyScopeResolver({
      listExportDocumentsByPaths: (paths: string[]) => store.listExportDocumentsByPaths(paths),
    });
    const emptyDirtyScope = resolver.resolve({
      indexedPaths: [],
      skippedPaths: [],
      deletedPaths: [],
      failedPaths: [],
      changedDocuments: [],
      triggerOverride: "incremental",
    });

    if (addedExtensions.length === 0 && removedExtensions.length === 0) {
      store.setSchemaMeta(APPLIED_ALLOWED_EXTENSIONS_META_KEY, JSON.stringify(effectiveCurrent));
      const exportSummary = await buildConfiguredExports(this.config, emptyDirtyScope, signal);
      return {
        changed: false,
        addedExtensions,
        removedExtensions,
        dirtyScope: emptyDirtyScope,
        indexResult: createEmptyIncrementalIndexResult(emptyDirtyScope),
        exportResult: exportSummary.exportResult,
      };
    }

    const addedIndexResult = addedExtensions.length > 0
      ? await executeTextIndex({
        config: this.config,
        ...createDefaultRuntimeBackedTextIndexStores(this.config),
        targetPath: undefined,
        allowedExtensionsOverride: addedExtensions,
        reconcileMode: "none",
        collectChangedPaths: true,
        dirtyScopeTrigger: "incremental",
        signal,
      })
      : createEmptyIncrementalIndexResult(emptyDirtyScope);
    if (addedExtensions.length > 0) {
      refreshRuntimeActiveFileStateSnapshot(this.config);
    }

    const deletedDocuments = removedExtensions.length > 0
      ? store.listExportDocumentsByExtensions(removedExtensions)
      : [];
    const deletionResult = removedExtensions.length > 0
      ? store.deleteActiveFilesByExtensions(removedExtensions)
      : { deletedCount: 0, deletedPaths: [] as string[] };

    store.setSchemaMeta(APPLIED_ALLOWED_EXTENSIONS_META_KEY, JSON.stringify(effectiveCurrent));

    const changedDocuments = uniqueDocuments([
      ...store.listExportDocumentsByPaths(addedIndexResult.indexedPaths),
      ...deletedDocuments,
    ]);

    const dirtyScope = resolver.resolve({
      indexedPaths: addedIndexResult.indexedPaths,
      skippedPaths: addedIndexResult.skippedPaths,
      deletedPaths: deletionResult.deletedPaths,
      failedPaths: addedIndexResult.failedPaths,
      changedDocuments,
      triggerOverride: "incremental",
    });

    const exportSummary = await buildConfiguredExports(this.config, dirtyScope, signal);

    return {
      changed: true,
      addedExtensions,
      removedExtensions,
      dirtyScope,
      indexResult: {
        ...addedIndexResult,
        deletedCount: deletionResult.deletedCount,
        deletedPaths: deletionResult.deletedPaths,
        dirtyScope,
      },
      exportResult: exportSummary.exportResult,
    };
  }
}
