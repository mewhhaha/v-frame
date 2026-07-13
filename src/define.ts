import { VFrameElement } from "./v-frame-element.js";

export function defineVFrame(): typeof VFrameElement {
  const existing = customElements.get("v-frame");
  if (existing === undefined) {
    customElements.define("v-frame", VFrameElement);
    return VFrameElement;
  }

  if (existing !== VFrameElement) {
    throw new Error(
      `Cannot define v-frame because the tag is already owned by ${existing.name || "another custom element constructor"}`,
    );
  }

  return VFrameElement;
}
