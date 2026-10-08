// Compiled by tsconfig.test.json, never run: it pins that the README quickstart
// typechecks without any global `HTMLElementTagNameMap` augmentation.
import { VFrameElement } from "../src/index.js";

export function watchOrders(): void {
  const frame = document.querySelector("v-frame");
  if (!(frame instanceof VFrameElement)) {
    throw new Error("host is missing its orders v-frame");
  }

  frame.addEventListener("v-frame-load", (event) => {
    console.log("orders ready", event.detail.url);
  });

  frame.addEventListener("v-frame-error", (event) => {
    console.error("orders failed", event.detail);
  });
}
