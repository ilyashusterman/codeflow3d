import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyEditorTheme } from "./lib/editorTheme";
import "./styles.css";

// The editor theme is one module, consumed by the canvas screens directly and
// by the stylesheet through the variables this publishes. Before first paint,
// so no surface renders a frame with unset colours.
applyEditorTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
