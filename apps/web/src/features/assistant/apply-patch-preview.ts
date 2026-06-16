// 迁移父仓库的 apply_patch 预览解析器，供文件助手工具卡片渲染差异摘要。

export interface ApplyPatchPreviewLine {
  kind: "add" | "remove" | "context";
  text: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
}

export interface ApplyPatchFileChange {
  path: string;
  nextPath: string | null;
  action: "add" | "delete" | "update";
  additions: number;
  deletions: number;
  statsKnown: boolean;
  lines: ApplyPatchPreviewLine[];
}

export interface ApplyPatchPreview {
  files: ApplyPatchFileChange[];
  totalAdditions: number;
  totalDeletions: number;
}

export function parseApplyPatchPreview(input: string): ApplyPatchPreview | null {
  const normalized = input.replace(/\r\n/g, "\n");
  if (!normalized.includes("*** Begin Patch") || !normalized.includes("*** End Patch")) {
    return null;
  }

  const lines = normalized.split("\n");
  const files: ApplyPatchFileChange[] = [];
  let current: ApplyPatchFileChange | null = null;
  let oldLine = 1;
  let newLine = 1;

  const pushCurrent = () => {
    if (!current) {
      return;
    }
    files.push(current);
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith("*** Add File: ")) {
      pushCurrent();
      current = {
        path: line.slice("*** Add File: ".length).trim(),
        nextPath: null,
        action: "add",
        additions: 0,
        deletions: 0,
        statsKnown: true,
        lines: [],
      };
      oldLine = 1;
      newLine = 1;
      continue;
    }

    if (line.startsWith("*** Delete File: ")) {
      pushCurrent();
      current = {
        path: line.slice("*** Delete File: ".length).trim(),
        nextPath: null,
        action: "delete",
        additions: 0,
        deletions: 0,
        statsKnown: true,
        lines: [],
      };
      oldLine = 1;
      newLine = 1;
      continue;
    }

    if (line.startsWith("*** Update File: ")) {
      pushCurrent();
      current = {
        path: line.slice("*** Update File: ".length).trim(),
        nextPath: null,
        action: "update",
        additions: 0,
        deletions: 0,
        statsKnown: true,
        lines: [],
      };
      oldLine = 1;
      newLine = 1;
      continue;
    }

    if (line.startsWith("*** Move to: ")) {
      if (current) {
        current.nextPath = line.slice("*** Move to: ".length).trim();
      }
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("@@")) {
      current.lines.push({
        kind: "context",
        text: line,
        oldLineNumber: null,
        newLineNumber: null,
      });
      continue;
    }

    if (line.startsWith("+")) {
      current.additions += 1;
      current.lines.push({
        kind: "add",
        text: line,
        oldLineNumber: null,
        newLineNumber: newLine,
      });
      newLine += 1;
      continue;
    }

    if (line.startsWith("-")) {
      current.deletions += 1;
      current.lines.push({
        kind: "remove",
        text: line,
        oldLineNumber: oldLine,
        newLineNumber: null,
      });
      oldLine += 1;
      continue;
    }

    if (line.startsWith(" ")) {
      current.lines.push({
        kind: "context",
        text: line,
        oldLineNumber: oldLine,
        newLineNumber: newLine,
      });
      oldLine += 1;
      newLine += 1;
    }
  }

  pushCurrent();

  if (files.length === 0) {
    return null;
  }

  return {
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files,
  };
}

export function extractApplyPatchPathsFromToolOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("*** ") && line.includes("File: "))
    .map((line) => line.replace(/^.*File:\s*/, "").trim())
    .filter(Boolean);
}

export function normalizeApplyPatchPreviewInput(input: string, fallbackPaths: string[]): string | null {
  const normalized = input.trim();
  if (normalized) {
    return normalized;
  }

  if (fallbackPaths.length === 0) {
    return null;
  }

  return [
    "*** Begin Patch",
    ...fallbackPaths.map((filePath) => `*** Update File: ${filePath}`),
    "*** End Patch",
  ].join("\n");
}

export function getApplyPatchDisplayName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).at(-1) ?? filePath;
}
