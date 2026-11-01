import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isValidSemver, normalizeTagVersion } from "./version.mjs";

describe("版本管理辅助函数", () => {
  it("接受正式版和 prerelease 版本", () => {
    assert.equal(isValidSemver("0.2.0"), true);
    assert.equal(isValidSemver("0.2.0-beta.1"), true);
  });

  it("拒绝不完整或带空格的版本", () => {
    assert.equal(isValidSemver("0.2"), false);
    assert.equal(isValidSemver(" v0.2.0"), false);
  });

  it("规范化带 v 前缀的 tag", () => {
    assert.equal(normalizeTagVersion("v0.2.0-beta.1"), "0.2.0-beta.1");
  });
});
