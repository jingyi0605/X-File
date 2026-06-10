import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HostDirectoryBrowserService } from "./host-directory-browser-service.js";
import { LibraryError } from "./library-errors.js";

test("目录浏览器遇到未创建的默认 X-File 时回退到用户主目录", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-host-home-"));
  const previousHome = process.env.HOME;
  process.env.HOME = tempHome;

  try {
    const defaultRootDir = path.join(tempHome, "X-File");
    assert.equal(fs.existsSync(defaultRootDir), false);

    const result = new HostDirectoryBrowserService().browse(defaultRootDir);
    assert.equal(result.currentPath, tempHome);
    assert.equal(result.roots[0]?.path, tempHome);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("目录浏览器仍然拒绝非默认的不可读路径", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "x-file-host-bad-path-"));
  const previousHome = process.env.HOME;
  process.env.HOME = tempHome;

  try {
    assert.throws(
      () => new HostDirectoryBrowserService().browse(path.join(tempHome, "missing-custom-folder")),
      (error) => error instanceof LibraryError && error.errorCode === "NOT_A_DIRECTORY",
    );
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
