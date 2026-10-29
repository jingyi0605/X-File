import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listLibraryDocuments } from "./library";
import { initializeRuntimeConfig } from "../runtime/runtime-config-store";

describe("组合文档检索 API", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    initializeRuntimeConfig();
    Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ total: 0, items: [] })));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("HTTP 请求带上搜索范围与匹配模式", async () => {
    await listLibraryDocuments({
      browseMode: "tag",
      selectedTagPaths: ["部门/法务", "类型/合同"],
      selectedFavoriteId: "favorite-1",
      keyword: "保密",
      searchScope: "all",
      searchMode: "content",
      offset: 0,
      limit: 20,
    });

    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), "http://localhost");
    expect(requestedUrl.searchParams.get("searchScope")).toBe("all");
    expect(requestedUrl.searchParams.get("searchMode")).toBe("content");
    expect(requestedUrl.searchParams.get("selectedTagPaths")).toBe("部门/法务,类型/合同");
    expect(requestedUrl.searchParams.get("selectedFavoriteId")).toBe("favorite-1");
  });
});
