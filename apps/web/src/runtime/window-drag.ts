import { getCurrentWindow } from "@tauri-apps/api/window";

const MACOS_TITLEBAR_DRAG_THRESHOLD_PX = 6;
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

  if (target.closest("[data-window-drag-handle]")) {
    return true;
  }

  return !target.closest(WINDOW_DRAG_BLOCK_SELECTOR);
}

export function isDesktopWindowDragHandleTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("[data-window-drag-handle]"));
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

  if (typeof window === "undefined") {
    return;
  }

  const startClientX = input.clientX;
  const startClientY = input.clientY;
  let active = true;

  const cleanup = () => {
    if (!active) {
      return;
    }

    active = false;
    window.removeEventListener("mousemove", handleMouseMove);
    window.removeEventListener("mouseup", handleMouseUp);
    window.removeEventListener("blur", handleWindowBlur);
  };

  const handleMouseMove = (event: MouseEvent) => {
    if (
      Math.abs(event.clientX - startClientX) < MACOS_TITLEBAR_DRAG_THRESHOLD_PX &&
      Math.abs(event.clientY - startClientY) < MACOS_TITLEBAR_DRAG_THRESHOLD_PX
    ) {
      return;
    }

    cleanup();
    void startDesktopWindowDrag();
  };

  const handleMouseUp = () => {
    cleanup();
  };

  const handleWindowBlur = () => {
    cleanup();
  };

  window.addEventListener("mousemove", handleMouseMove);
  window.addEventListener("mouseup", handleMouseUp);
  window.addEventListener("blur", handleWindowBlur);
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
