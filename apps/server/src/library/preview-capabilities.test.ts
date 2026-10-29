import assert from "node:assert/strict";
import test from "node:test";

import { LIBRARY_PREVIEW_FORMATS, resolveLibraryPreviewFormat } from "@x-file/shared";

import {
  detectPreviewKind,
  isResourcePreviewKind,
} from "./file-preview.js";

test("preview manifest classifies formats and keeps index/icon policy separate", () => {
  assert.equal(detectPreviewKind("docs/README.MD"), "markdown");
  assert.equal(detectPreviewKind("src/page.mdx"), "text");
  assert.equal(detectPreviewKind("data.csv"), "text");
  assert.equal(detectPreviewKind("report.xlsx"), "office");
  assert.equal(detectPreviewKind("photo.heic"), "unsupported");
  assert.equal(resolveLibraryPreviewFormat("report.docx")?.editable, false);
  assert.equal(resolveLibraryPreviewFormat("notes.txt")?.editable, true);
  assert.equal(isResourcePreviewKind("html"), true);
  assert.equal(isResourcePreviewKind("office"), true);
  assert.equal(isResourcePreviewKind("text"), false);

  const extensions = LIBRARY_PREVIEW_FORMATS.flatMap((format) => format.extensions);
  assert.equal(new Set(extensions).size, extensions.length);
});
