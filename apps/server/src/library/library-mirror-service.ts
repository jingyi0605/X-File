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
  type LibraryMirrorSnapshot,
} from "@x-file/shared";

import { LibraryService } from "./library-service.js";
import { TagService } from "./tag-service.js";

export class LibraryMirrorService {
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
