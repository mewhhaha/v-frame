import { VFrameElement } from "./v-frame-element.js";
import type { VFrameEventMap } from "./types.js";

export { defineVFrame } from "./define.js";
export { VFrameElement };
export { VFrameStatus } from "./types.js";
export type {
  VFrameCredentials,
  VFrameErrorEventDetail,
  VFrameErrorPhase,
  VFrameEventMap,
  VFrameLoadEventDetail,
  VFrameLoadStartEventDetail,
  VFrameNavigateEventDetail,
  VFrameNavigation,
  VFrameNavigationKind,
  VFrameStatus as VFrameStatusValue,
  VFrameTrustedTypesPolicy,
  VFrameTrustedTypesPolicyDefinition,
} from "./types.js";

declare global {
  interface HTMLElementTagNameMap {
    "v-frame": VFrameElement;
  }

  interface HTMLElementEventMap extends VFrameEventMap {}
}
