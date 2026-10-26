import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";

import {
  createDocumentList,
  createDocumentRecord,
  installLibraryApiMock,
  libraryApiMock,
  resetLibraryApiMock,
} from "./mockLibraryApi";

installLibraryApiMock();

beforeEach(() => {
  localStorage.clear();
  resetLibraryApiMock();
});

it("修改时间排序传到分页请求，切换方向后从第一页重新加载", async () => {
  const documents = Array.from({ length: 125 }, (_, index) => createDocumentRecord({
    documentId: `doc-${index}`,
    path: `${String(index).padStart(3, "0")}.md`,
    updatedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  }));
  libraryApiMock.listLibraryDocuments.mockImplementation(async (query) => {
    const ordered = [...documents].sort((left, right) => {
      const delta = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
      return query.updatedAtOrder === "asc" ? delta : -delta;
    });
    return createDocumentList(ordered.slice(query.offset, query.offset + query.limit), {
      total: documents.length,
      offset: query.offset,
      limit: query.limit,
    });
  });

  const { useLibraryState } = await import("../useLibraryState");
  const { result } = renderHook(() => useLibraryState());
  await waitFor(() => expect(result.current.entries).toHaveLength(60));
  expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(
    expect.objectContaining({ updatedAtOrder: "desc", offset: 0, limit: 60 }),
  );
  expect(result.current.entries[0].path).toBe("124.md");

  await act(async () => result.current.loadMore());
  expect(result.current.entries).toHaveLength(120);
  expect(result.current.entries[119].path).toBe("005.md");

  act(() => result.current.setViewState((current) => ({
    ...current,
    librarySort: { mode: "recent", direction: "asc" },
  })));
  await waitFor(() => expect(libraryApiMock.listLibraryDocuments).toHaveBeenLastCalledWith(
    expect.objectContaining({ updatedAtOrder: "asc", offset: 0, limit: 120 }),
  ));
  await waitFor(() => expect(result.current.entries[0].path).toBe("000.md"));
  expect(result.current.entries[119].path).toBe("119.md");

  await act(async () => result.current.loadMore());
  expect(result.current.entries).toHaveLength(125);
  expect(result.current.entries[124].path).toBe("124.md");
  expect(new Set(result.current.entries.map((entry) => entry.path)).size).toBe(125);
});

it("切换排序后忽略旧方向尚未完成的分页响应", async () => {
  const newest = createDocumentRecord({ documentId: "new", path: "new.md" });
  const oldest = createDocumentRecord({ documentId: "old", path: "old.md", updatedAt: "2025-01-01T00:00:00Z" });
  let finishOldPage!: (page: ReturnType<typeof createDocumentList>) => void;
  libraryApiMock.listLibraryDocuments.mockImplementation((query) => {
    if (query.offset > 0) {
      return new Promise((resolve) => { finishOldPage = resolve; });
    }
    return Promise.resolve(createDocumentList(
      [query.updatedAtOrder === "asc" ? oldest : newest],
      { total: 2 },
    ));
  });

  const { useLibraryState } = await import("../useLibraryState");
  const { result } = renderHook(() => useLibraryState());
  await waitFor(() => expect(result.current.entries).toHaveLength(1));
  let pendingPage!: Promise<void>;
  act(() => { pendingPage = result.current.loadMore(); });
  await waitFor(() => expect(finishOldPage).toBeTypeOf("function"));

  act(() => result.current.setViewState((current) => ({
    ...current,
    librarySort: { mode: "recent", direction: "asc" },
  })));
  await waitFor(() => expect(result.current.entries[0].path).toBe("old.md"));
  await act(async () => {
    finishOldPage(createDocumentList([oldest], { total: 2, offset: 1 }));
    await pendingPage;
  });
  expect(result.current.entries.map((entry) => entry.path)).toEqual(["old.md"]);
});
