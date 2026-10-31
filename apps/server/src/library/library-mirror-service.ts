import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_LIBRARY_ALLOWED_EXTENSIONS,
  type LibraryConfig,
  type LibraryMirrorMutation,
  type LibraryMirrorMutationBatchResult,
  type LibraryMirrorMutationResult,
  type LibraryMirrorSnapshotDelta,
  type LibraryMirrorSnapshotUnchanged,
  type LibraryMirrorSnapshot,
} from "@x-file/shared";

import { LibraryService } from "./library-service.js";
import { TagService } from "./tag-service.js";

export class LibraryMirrorService {
  private previousSnapshot: LibraryMirrorSnapshot | null = null;

  constructor(
    private readonly libraryService: LibraryService,
    private readonly tagService: TagService,
    private readonly mutationStore = new LibraryMirrorMutationStore(),
  ) {}

  getSnapshot(): LibraryMirrorSnapshot {
    const snapshot = this.libraryService.getSnapshot();
    const mirrorState = snapshot.binding
      ? this.tagService.getMirrorState()
      : { tagDetails: [], documentTagBindings: [], folderTagBindings: [] };
    const documents = this.libraryService.getAllDocuments();
    const config = toLibraryConfig(snapshot);
    const generatedAt = new Date().toISOString();
    const revision = createRevision({
      config,
      snapshot,
      documents,
      tagDetails: mirrorState.tagDetails,
      documentTagBindings: mirrorState.documentTagBindings,
      folderTagBindings: mirrorState.folderTagBindings,
    });

    return {
      version: 1,
      revision,
      generatedAt,
      config,
      snapshot,
      documents,
      tagDetails: mirrorState.tagDetails,
      documentTagBindings: mirrorState.documentTagBindings,
      folderTagBindings: mirrorState.folderTagBindings,
    };
  }

  getSnapshotSince(
    revision: string | null,
  ): LibraryMirrorSnapshot | LibraryMirrorSnapshotDelta | LibraryMirrorSnapshotUnchanged {
    const current = this.getSnapshot();
    const previous = this.previousSnapshot;
    this.previousSnapshot = current;

    if (revision && revision === current.revision) {
      return {
        version: 1,
        kind: "unchanged",
        revision: current.revision,
        generatedAt: current.generatedAt,
      } satisfies LibraryMirrorSnapshotUnchanged;
    }

    if (!revision || previous?.revision !== revision) {
      return current;
    }

    const documents = diffRecords(previous.documents, current.documents, (item) => item.documentId);
    const tagDetails = diffRecords(previous.tagDetails, current.tagDetails, (item) => item.id);
    const documentTagBindings = diffRecords(
      previous.documentTagBindings,
      current.documentTagBindings,
      (item) => item.documentId,
    );
    const folderTagBindings = diffRecords(
      previous.folderTagBindings,
      current.folderTagBindings,
      (item) => item.folderPath,
    );
    const deltaRecordCount = documents.upserts.length + documents.deleted.length
      + tagDetails.upserts.length + tagDetails.deleted.length
      + documentTagBindings.upserts.length + documentTagBindings.deleted.length
      + folderTagBindings.upserts.length + folderTagBindings.deleted.length;
    const currentRecordCount = current.documents.length + current.tagDetails.length
      + current.documentTagBindings.length + current.folderTagBindings.length;

    if (deltaRecordCount >= 100 && deltaRecordCount / Math.max(1, currentRecordCount) >= 0.4) {
      return current;
    }

    return {
      version: 1,
      kind: "delta",
      baseRevision: previous.revision,
      revision: current.revision,
      generatedAt: current.generatedAt,
      config: current.config,
      snapshot: current.snapshot,
      documentUpserts: documents.upserts,
      deletedDocumentIds: documents.deleted,
      tagDetailUpserts: tagDetails.upserts,
      deletedTagIds: tagDetails.deleted,
      documentTagBindingUpserts: documentTagBindings.upserts,
      deletedDocumentTagBindingIds: documentTagBindings.deleted,
      folderTagBindingUpserts: folderTagBindings.upserts,
      deletedFolderTagPaths: folderTagBindings.deleted,
    } satisfies LibraryMirrorSnapshotDelta;
  }

  applyMutations(mutations: LibraryMirrorMutation[]): LibraryMirrorMutationBatchResult {
    const results = mutations.map((mutation) => this.applyMutation(mutation));
    return {
      revision: this.getSnapshot().revision,
      results,
    };
  }

  private applyMutation(mutation: LibraryMirrorMutation): LibraryMirrorMutationResult {
    const previous = this.mutationStore.read(mutation.mutationId);
    if (previous) {
      return previous;
    }

    let result: LibraryMirrorMutationResult;
    try {
      result = this.tagService.applyMirrorMutation(mutation);
    } catch (error) {
      result = {
        mutationId: mutation.mutationId,
        status: "conflict",
        updatedAt: mutation.updatedAt,
        detail: error instanceof Error ? error.message : "镜像标签修改未能应用",
      };
    }
    this.mutationStore.write(mutation.mutationId, result);
    return result;
  }
}

function diffRecords<T>(
  previous: T[],
  current: T[],
  getKey: (item: T) => string,
): { upserts: T[]; deleted: string[] } {
  const previousByKey = new Map(previous.map((item) => [getKey(item), item]));
  const currentByKey = new Map(current.map((item) => [getKey(item), item]));
  return {
    upserts: current.filter((item) => {
      const oldValue = previousByKey.get(getKey(item));
      return oldValue === undefined || !recordsEqual(oldValue, item);
    }),
    deleted: [...previousByKey.keys()].filter((key) => !currentByKey.has(key)),
  };
}

function recordsEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

class LibraryMirrorMutationStore {
  private readonly filePath = path.join(
    process.env.X_FILE_DATA_DIR?.trim()
      ? path.resolve(process.env.X_FILE_DATA_DIR)
      : path.join(os.homedir(), ".x-file"),
    "library-mirror-mutations.json",
  );

  read(mutationId: string): LibraryMirrorMutationResult | null {
    const all = this.readAll();
    return all[mutationId] ?? null;
  }

  write(mutationId: string, result: LibraryMirrorMutationResult): void {
    const all = this.readAll();
    all[mutationId] = result;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  }

  private readAll(): Record<string, LibraryMirrorMutationResult> {
    if (!fs.existsSync(this.filePath)) return {};
    return JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Record<string, LibraryMirrorMutationResult>;
  }
}

function toLibraryConfig(snapshot: ReturnType<LibraryService["getSnapshot"]>): LibraryConfig {
  const binding = snapshot.binding;
  return {
    binding,
    enabled: binding?.enabled ?? false,
    mirrorRoot: binding?.mirrorRoot ?? null,
    allowedExtensions: binding?.allowedExtensions?.length
      ? [...binding.allowedExtensions]
      : [...DEFAULT_LIBRARY_ALLOWED_EXTENSIONS],
    includedHiddenPaths: binding?.includedHiddenPaths ? [...binding.includedHiddenPaths] : [],
    hideDotFiles: binding?.hideDotFiles ?? true,
    hideSystemFolders: binding?.hideSystemFolders ?? true,
    folderOpenBehavior: binding?.folderOpenBehavior ?? "double_click",
    configRelativePath: binding?.configRelativePath ?? ".ai-index/doc-semantic-index.config.json",
    canWrite: binding !== null,
  };
}

function createRevision(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}
