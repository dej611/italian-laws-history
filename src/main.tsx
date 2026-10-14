import "./styles/global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initLocale } from "./i18n";
import { applyTheme, readThemePref } from "./theme";

if ("scrollRestoration" in history) {
  history.scrollRestoration = "manual";
}

initLocale();
applyTheme(readThemePref());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
