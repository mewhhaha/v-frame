import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { defineVFrame } from "v-frame";
import { App } from "./App";

defineVFrame();

const container = document.getElementById("root");
if (!container) {
  throw new Error("missing #root element to mount the host app into");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
