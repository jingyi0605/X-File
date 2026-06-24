import assert from "node:assert/strict";
import test from "node:test";

import { resolveStandaloneSidecarProfile } from "./main.js";

test("独立 server 入口默认使用 full sidecar profile", () => {
  const previous = process.env.X_FILE_NODE_SIDECAR_PROFILE;
  delete process.env.X_FILE_NODE_SIDECAR_PROFILE;
  try {
    assert.equal(resolveStandaloneSidecarProfile(), "full");
  } finally {
    if (previous === undefined) {
      delete process.env.X_FILE_NODE_SIDECAR_PROFILE;
    } else {
      process.env.X_FILE_NODE_SIDECAR_PROFILE = previous;
    }
  }
});

test("显式 sidecar-only 配置仍然保留", () => {
  const previous = process.env.X_FILE_NODE_SIDECAR_PROFILE;
  process.env.X_FILE_NODE_SIDECAR_PROFILE = "sidecar-only";
  try {
    assert.equal(resolveStandaloneSidecarProfile(), "sidecar-only");
  } finally {
    if (previous === undefined) {
      delete process.env.X_FILE_NODE_SIDECAR_PROFILE;
    } else {
      process.env.X_FILE_NODE_SIDECAR_PROFILE = previous;
    }
  }
});
