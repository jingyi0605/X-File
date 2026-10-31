import { describe, expect, it } from "vitest";

import { shouldAllowMirrorStartupWithoutHttpAuth } from "./mirror-startup";

describe("镜像模式启动认证降级", () => {
  it.each([0, 404, 500, 503])("远端状态 %s 时允许进入镜像页面", (status) => {
    expect(
      shouldAllowMirrorStartupWithoutHttpAuth("mirror", { status }),
    ).toBe(true);
  });

  it.each([401, 403])("远端状态 %s 时仍保持认证保护", (status) => {
    expect(
      shouldAllowMirrorStartupWithoutHttpAuth("mirror", { status }),
    ).toBe(false);
  });

  it("本地模式不因远端错误改变启动路径", () => {
    expect(
      shouldAllowMirrorStartupWithoutHttpAuth("local", { status: 0 }),
    ).toBe(false);
  });
});
