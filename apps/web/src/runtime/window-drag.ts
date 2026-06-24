import { getCurrentWindow } from "@tauri-apps/api/window";
const WINDOW_DRAG_BLOCK_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='menuitem']",
  "[contenteditable='true']",
  "[data-window-drag='ignore']",
].join(", ");

export interface MacOsTitlebarDragPlatform {
  runtimePlatform: "desktop" | "web";
  osFamily: "macos" | "windows" | "web";
  overlayTitlebar: boolean;
}

function hasTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as Window & { __TAURI_INTERNALS__?: unknown })
  );
}

export function canStartDesktopWindowDragFromTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return true;
  }

  if (target.closest("[data-window-drag='ignore']")) {
    return false;
  }

  if (target.closest("[data-window-drag-handle]")) {
    return true;
  }

  return !target.closest(WINDOW_DRAG_BLOCK_SELECTOR);
}

export function isDesktopWindowDragHandleTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    !target.closest("[data-window-drag='ignore']") &&
    Boolean(target.closest("[data-window-drag-handle]"))
  );
}

export function canHandleMacOsTitlebarPointerGesture(
  platform: MacOsTitlebarDragPlatform,
  button: number,
  target: EventTarget | null,
): boolean {
  return (
    platform.runtimePlatform === "desktop" &&
    platform.osFamily === "macos" &&
    platform.overlayTitlebar &&
    button === 0 &&
    canStartDesktopWindowDragFromTarget(target)
  );
}

export function beginMacOsTitlebarDragGesture(input: {
  platform: MacOsTitlebarDragPlatform;
  button: number;
  target: EventTarget | null;
  clientX: number;
  clientY: number;
}): void {
  if (!canHandleMacOsTitlebarPointerGesture(input.platform, input.button, input.target)) {
    return;
  }
  void startDesktopWindowDrag();
}

export async function startDesktopWindowDrag(): Promise<void> {
  if (!hasTauriRuntime()) {
    return;
  }

  await getCurrentWindow().startDragging();
}

export async function toggleDesktopWindowMaximize(): Promise<void> {
  if (!hasTauriRuntime()) {
    return;
  }

  await getCurrentWindow().toggleMaximize();
}
