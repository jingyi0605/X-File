import { beforeEach, describe, expect, it } from "vitest";

import {
  createDefaultLibraryViewState,
  readLibraryViewState,
  resolveLibraryViewModeForViewport,
  writeLibraryViewState,
} from "../library-view-state";

describe("responsive library view state", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to list on mobile and grid on desktop", () => {
    const state = createDefaultLibraryViewState("mobile-default");

    expect(resolveLibraryViewModeForViewport(state, true)).toBe("list");
    expect(resolveLibraryViewModeForViewport(state, false)).toBe("grid");
  });

  it("keeps desktop and mobile view choices independent", () => {
    const state = {
      ...createDefaultLibraryViewState("separate-views"),
      viewMode: "grid" as const,
      desktopViewMode: "grid" as const,
      mobileViewMode: "grid" as const,
    };

    writeLibraryViewState(state);
    const restored = readLibraryViewState("separate-views");

    expect(resolveLibraryViewModeForViewport(restored, true)).toBe("grid");
    expect(resolveLibraryViewModeForViewport(restored, false)).toBe("grid");
  });

  it("migrates an old single view choice into the desktop preference", () => {
    expect(resolveLibraryViewModeForViewport({ viewMode: "list" }, false)).toBe("list");
    expect(resolveLibraryViewModeForViewport({ viewMode: "grid" }, true)).toBe("list");
  });
});
