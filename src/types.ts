export const VFrameStatus = {
  Idle: "idle",
  Loading: "loading",
  Ready: "ready",
  Error: "error",
} as const;

export type VFrameStatus = (typeof VFrameStatus)[keyof typeof VFrameStatus];

export type VFrameWindow = Window & typeof globalThis;

export type VFrameCredentials = "omit" | "same-origin" | "include";

export type VFrameNavigation = "guest" | "host";

export interface VFrameTrustedTypesPolicyDefinition {
  readonly name: string;
  createHTML(source: string): string;
  createScript(source: string): string;
  createScriptURL(source: string): string;
}

export type VFrameTrustedTypesPolicy = string | VFrameTrustedTypesPolicyDefinition;

export type VFrameErrorPhase =
  | "entry"
  | "bootstrap"
  | "stylesheet"
  | "script"
  | "runtime"
  | "navigation"
  | "network";

export type VFrameNavigationKind =
  | "link"
  | "form"
  | "window"
  | "push"
  | "replace"
  | "traverse"
  | "fragment";

export interface VFrameLoadEventDetail {
  url: string;
}

export interface VFrameErrorEventDetail {
  phase: VFrameErrorPhase;
  url: string;
  error: unknown;
  fatal: boolean;
}

export interface VFrameNavigateEventDetail {
  from: string;
  to: string;
  kind: VFrameNavigationKind;
  state: unknown;
}

export interface VFrameNavigatedEventDetail {
  from: string;
  to: string;
  kind: VFrameNavigationKind;
}

export interface VFrameNavigateOptions {
  replace?: boolean;
}

export interface VFrameEventMap {
  "v-frame-loadstart": CustomEvent<VFrameLoadEventDetail>;
  "v-frame-load": CustomEvent<VFrameLoadEventDetail>;
  "v-frame-error": CustomEvent<VFrameErrorEventDetail>;
  "v-frame-navigate": CustomEvent<VFrameNavigateEventDetail>;
  "v-frame-navigated": CustomEvent<VFrameNavigatedEventDetail>;
}
