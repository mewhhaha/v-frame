import { defineVFrame } from "./index.js";

// Shared application entries may also be imported by an SSR process.
if (typeof globalThis.customElements !== "undefined") defineVFrame();
