import type { HttpServerState } from "../http-server-manager.js";

export interface PersistentBackendPolicy {
  keepBackendOnWindowClose: boolean;
  closeWindowBehavior: "hide_window_keep_backend" | "quit_application";
  quitApplicationBehavior: "stop_http_server";
  implementedByDesktopShell: boolean;
  requiresSystemTray: boolean;
  note: string;
}

export class PersistentBackendManager {
  getPolicy(httpServerState: HttpServerState): PersistentBackendPolicy {
    const keepBackendOnWindowClose = httpServerState.enabled && httpServerState.persistent;

    return {
      keepBackendOnWindowClose,
      closeWindowBehavior: keepBackendOnWindowClose ? "hide_window_keep_backend" : "quit_application",
      quitApplicationBehavior: "stop_http_server",
      implementedByDesktopShell: true,
      requiresSystemTray: keepBackendOnWindowClose,
      note: keepBackendOnWindowClose
        ? "桌面壳会在关闭窗口时隐藏主窗口并保留进程；系统托盘菜单和生产级后端子进程托管仍需后续增强。"
        : "用户关闭窗口时按普通退出处理；HTTP 服务不常驻。"
    };
  }
}
