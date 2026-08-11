import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@mewhhaha/v-frame/register";
import { App } from "./App";

const container = document.getElementById("root");
if (!container) {
  throw new Error("missing #root element to mount the host app into");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
