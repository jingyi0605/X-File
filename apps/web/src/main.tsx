import { createRoot } from "react-dom/client";

import { App } from "./App";
import { initializePreferences } from "./preferences/preferences-store";
import { initializeRuntimeConfig } from "./runtime/runtime-config-store";
import { ThemeProvider } from "./shared/theme/ThemeProvider";
import { initTheme } from "./shared/theme/theme";

initializePreferences();
initializeRuntimeConfig();
initTheme();

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
