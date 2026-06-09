import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { initializePreferences } from "./preferences/preferences-store";
import { ThemeProvider } from "./shared/theme/ThemeProvider";
import { initTheme } from "./shared/theme/theme";

initializePreferences();
initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>
);
