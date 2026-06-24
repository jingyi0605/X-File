import { createRoot } from "react-dom/client";
import { useEffect } from "react";

import { App } from "./App";
import { initializeFileOpenPreferences } from "./preferences/file-open-preference-store";
import { initializePreferences } from "./preferences/preferences-store";
import { initializeRuntimeConfig } from "./runtime/runtime-config-store";
import { ThemeProvider } from "./shared/theme/ThemeProvider";
import { initTheme } from "./shared/theme/theme";

initializePreferences();
initializeFileOpenPreferences();
initializeRuntimeConfig();
initTheme();

declare global {
  interface WindowEventMap {
    "x-file-startup-ready": CustomEvent<{ source: "react-mounted" | "native-sidebar-ready" }>;
  }
}

function dismissStartupShell(): void {
  const startupShell = document.getElementById("startup-shell");
  if (!startupShell) {
    return;
  }
  startupShell.setAttribute("data-state", "ready");
  window.setTimeout(() => {
    startupShell.setAttribute("data-state", "hidden");
  }, 180);
}

function StartupShellBridge() {
  useEffect(() => {
    let dismissed = false;
    let fallbackTimer: number | null = null;

    const handleReady = () => {
      if (dismissed) {
        return;
      }
      dismissed = true;
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
      }
      dismissStartupShell();
    };

    window.addEventListener("x-file-startup-ready", handleReady);

    fallbackTimer = window.setTimeout(() => {
      handleReady();
    }, 1200);

    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent("x-file-startup-ready", {
          detail: { source: "react-mounted" },
        }));
      });
      return () => window.cancelAnimationFrame(secondFrame);
    });

    return () => {
      window.removeEventListener("x-file-startup-ready", handleReady);
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
      }
      window.cancelAnimationFrame(firstFrame);
    };
  }, []);

  return (
    <ThemeProvider>
      <App />
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StartupShellBridge />
);
