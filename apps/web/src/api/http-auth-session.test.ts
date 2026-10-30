import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiRequest } from "./http";
import { setHttpAuthSessionToken } from "./http-auth-session";
import { initializeRuntimeConfig, updateRuntimeConfig } from "../runtime/runtime-config-store";

describe("镜像模式 HTTP 会话", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    initializeRuntimeConfig();
    fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("向远端 API 请求时携带登录后的会话头", async () => {
    await updateRuntimeConfig({
      mode: "mirror",
      remoteApiBaseUrl: "https://primary.example.com"
    });
    setHttpAuthSessionToken("https://primary.example.com/api/auth/login", "session-token");

    expect(localStorage.getItem("x-file.http-auth-session.https://primary.example.com")).toBe("session-token");
    expect(sessionStorage.length).toBe(0);

    await expect(apiRequest("/api/library/config")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "https://primary.example.com/api/library/config",
      expect.objectContaining({
        credentials: "omit",
        headers: {
          "x-file-session": "session-token"
        }
      })
    );
  });
});
