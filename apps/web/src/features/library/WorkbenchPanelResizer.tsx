import {
  useCallback,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";

// 分割线热区列宽(px)：与 styles.css 中的 --workbench-resizer-gutter 保持一致。
// 拖拽 clamp 需要数值，所以这里也保留一份常量。
export const WORKBENCH_RESIZER_GUTTER = 7;

// 边栏宽度边界(px)
const SIDEBAR_MIN = 200;
const DETAIL_MIN = 240;
const MAIN_MIN = 420;

// 未自定义时的默认宽度，需与 styles.css 里 .workbench-window 的默认列宽一致。
const DEFAULT_SIDEBAR = 272;
const DEFAULT_DETAIL = 340;

const STORAGE_KEY = "x-file.library.panel-sizes";

type PanelSide = "left" | "right";

interface StoredPanelSizes {
  // null 表示沿用 CSS 默认宽度
  sidebar: number | null;
  detail: number | null;
}

interface DragState {
  side: PanelSide;
  startX: number;
  containerWidth: number;
  // 拖拽起始时两栏的宽度，拖拽过程中对面栏不变，clamp 以此为基准
  startSidebar: number;
  startDetail: number;
}

interface ResizablePanels {
  containerRef: RefObject<HTMLElement | null>;
  // null = 未自定义，沿用 CSS；非 null = 用户拖拽过的宽度
  sidebarWidth: number | null;
  detailWidth: number | null;
  hasCustomLayout: boolean;
  activeSide: PanelSide | null;
  // 仅在用户自定义过布局时给出 5 列模板，否则 undefined 让 CSS 接管
  gridTemplateColumns: string | undefined;
  startResize: (side: PanelSide, event: ReactMouseEvent) => void;
  resetSize: (side: PanelSide) => void;
}

interface WorkbenchPanelResizerProps {
  side: PanelSide;
  active: boolean;
  ariaLabel: string;
  onResizeStart: (side: PanelSide, event: ReactMouseEvent) => void;
  onReset: (side: PanelSide) => void;
}

function readStoredSizes(): StoredPanelSizes {
  if (typeof window === "undefined") {
    return { sidebar: null, detail: null };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { sidebar: null, detail: null };
    }
    const parsed = JSON.parse(raw) as Partial<StoredPanelSizes>;
    const sidebar =
      typeof parsed.sidebar === "number" && Number.isFinite(parsed.sidebar)
        ? parsed.sidebar
        : null;
    const detail =
      typeof parsed.detail === "number" && Number.isFinite(parsed.detail)
        ? parsed.detail
        : null;
    return { sidebar, detail };
  } catch {
    return { sidebar: null, detail: null };
  }
}

function persistSizes(sizes: StoredPanelSizes): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sizes));
  } catch {
    // 本地布局持久化失败不应阻断拖拽交互。
  }
}

// 拖拽中的宽度 clamp：保证主面板至少 MAIN_MIN，边栏不互相挤压。
function clampWidth(side: PanelSide, value: number, drag: DragState): number {
  const otherWidth = side === "left" ? drag.startDetail : drag.startSidebar;
  const min = side === "left" ? SIDEBAR_MIN : DETAIL_MIN;
  const max =
    drag.containerWidth - otherWidth - MAIN_MIN - 2 * WORKBENCH_RESIZER_GUTTER;
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function useResizablePanels(): ResizablePanels {
  const containerRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // 持有最新宽度，供 mousedown 闭包读取，避免依赖 state 重建回调
  const sidebarWidthRef = useRef<number | null>(null);
  const detailWidthRef = useRef<number | null>(null);
  const [stored, setStored] = useState<StoredPanelSizes>(() =>
    readStoredSizes()
  );
  const [activeSide, setActiveSide] = useState<PanelSide | null>(null);

  // 每次 render 同步 ref，拖拽起点取得到最新宽度
  sidebarWidthRef.current = stored.sidebar;
  detailWidthRef.current = stored.detail;

  const sidebarWidth = stored.sidebar;
  const detailWidth = stored.detail;
  const hasCustomLayout = sidebarWidth !== null || detailWidth !== null;
  const gridTemplateColumns = hasCustomLayout
    ? `${sidebarWidth ?? DEFAULT_SIDEBAR}px var(--workbench-resizer-gutter) minmax(${MAIN_MIN}px, 1fr) var(--workbench-resizer-gutter) ${
        detailWidth ?? DEFAULT_DETAIL
      }px`
    : undefined;

  const startResize = useCallback(
    (side: PanelSide, event: ReactMouseEvent) => {
      const container = containerRef.current;
      if (!container) {
        return;
      }
      // 阻止文本选中和默认拖拽
      event.preventDefault();

      const containerWidth = container.getBoundingClientRect().width;
      dragRef.current = {
        side,
        startX: event.clientX,
        containerWidth,
        startSidebar: sidebarWidthRef.current ?? DEFAULT_SIDEBAR,
        startDetail: detailWidthRef.current ?? DEFAULT_DETAIL,
      };
      setActiveSide(side);

      const onMove = (moveEvent: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) {
          return;
        }
        const deltaX = moveEvent.clientX - drag.startX;
        if (drag.side === "left") {
          const next = clampWidth("left", drag.startSidebar + deltaX, drag);
          setStored((prev) => ({ ...prev, sidebar: next }));
        } else {
          // 右栏在右侧，鼠标右移应让它变窄
          const next = clampWidth("right", drag.startDetail - deltaX, drag);
          setStored((prev) => ({ ...prev, detail: next }));
        }
      };

      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        dragRef.current = null;
        setActiveSide(null);
        setStored((prev) => {
          persistSizes(prev);
          return prev;
        });
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    []
  );

  const resetSize = useCallback((side: PanelSide) => {
    setStored((prev) => {
      const next: StoredPanelSizes =
        side === "left"
          ? { ...prev, sidebar: null }
          : { ...prev, detail: null };
      persistSizes(next);
      return next;
    });
  }, []);

  return {
    containerRef,
    sidebarWidth,
    detailWidth,
    hasCustomLayout,
    activeSide,
    gridTemplateColumns,
    startResize,
    resetSize,
  };
}

export function WorkbenchPanelResizer({
  side,
  active,
  ariaLabel,
  onResizeStart,
  onReset,
}: WorkbenchPanelResizerProps) {
  return (
    <div
      className="workbench-panel-resizer"
      data-side={side}
      data-active={active ? "true" : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      onMouseDown={(event) => onResizeStart(side, event)}
      onDoubleClick={() => onReset(side)}
    />
  );
}
