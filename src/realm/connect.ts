// Bootstrapping the hidden execution realm: an empty same-origin srcdoc iframe,
// rewritten to a blank document at the guest's URL, with a Trusted Types policy
// minted inside it.
//
// This module also holds the handful of types the rest of src/realm/ shares. It
// is the one module in the directory that imports nothing from its siblings, so
// keeping them here is what makes the directory's imports acyclic.

import { toDOMString, toLegacyNullToEmptyString } from "../facade/webidl.js";
import type {
  VFrameErrorPhase,
  VFrameTrustedTypesPolicyDefinition,
  VFrameWindow,
} from "../types.js";

export interface RealmFailure {
  phase: VFrameErrorPhase;
  url: string;
  error: unknown;
}

export interface RealmTrustedTypes {
  createHTML(source: string): string;
  createGuestHTML(value: unknown, legacyNull?: boolean): string;
  createScript(source: string): string;
  createScriptURL(source: string): string;
}

export interface ConnectedRealmIframe {
  iframe: HTMLIFrameElement;
  trustedTypes: RealmTrustedTypes;
}

/** The realm window shape `connectRealmIframe` has already proven exists. */
export type NavigationWindow = VFrameWindow & {
  readonly NavigateEvent: typeof NavigateEvent;
  readonly navigation: Navigation;
};

interface TrustedTypePolicyFactoryLike {
  readonly emptyHTML: unknown;
  isHTML?(value: unknown): boolean;
  createPolicy(
    name: string,
    policy: Omit<VFrameTrustedTypesPolicyDefinition, "name">,
  ): Omit<VFrameTrustedTypesPolicyDefinition, "name">;
}

export function abortError(): DOMException {
  return new DOMException("The v-frame load was superseded", "AbortError");
}

type NativeMoveBefore = (node: Node, child: Node | null) => void;

const nativeShadowMoveBefore: NativeMoveBefore | undefined =
  typeof ShadowRoot === "function"
    ? (ShadowRoot.prototype as ShadowRoot & { moveBefore?: NativeMoveBefore }).moveBefore
    : undefined;

interface PrewarmedRealmSlot {
  targetDocument: Document | null;
  hostWindow: Window | null;
  iframe: HTMLIFrameElement | null;
  moveBefore: NativeMoveBefore | null;
  readyDoc: Document | null;
  readyWin: Window | null;
  expectedSrcdoc: string | null;
  onLoad: EventListener | null;
  onPageHide: EventListener | null;
  removalObserver: MutationObserver | null;
}

const prewarmedSlots = new WeakMap<Document, PrewarmedRealmSlot>();

function teardownPrewarmedSlot(slot: PrewarmedRealmSlot, keepIframe = false): void {
  const { iframe, hostWindow, targetDocument, onLoad, onPageHide, removalObserver } =
    slot;
  if (iframe === null) return;
  slot.targetDocument = null;
  slot.hostWindow = null;
  slot.iframe = null;
  slot.moveBefore = null;
  slot.readyDoc = null;
  slot.readyWin = null;
  slot.expectedSrcdoc = null;
  slot.onLoad = null;
  slot.onPageHide = null;
  slot.removalObserver = null;
  removalObserver?.disconnect();
  if (onLoad !== null) iframe.removeEventListener("load", onLoad);
  if (onPageHide !== null) hostWindow?.removeEventListener("pagehide", onPageHide);
  if (targetDocument !== null && prewarmedSlots.get(targetDocument) === slot) {
    prewarmedSlots.delete(targetDocument);
  }
  if (!keepIframe) iframe.remove();
}

function makeSlotDisposer(initial: PrewarmedRealmSlot): () => void {
  let slot: PrewarmedRealmSlot | null = initial;
  return () => {
    if (slot === null) return;
    const current = slot;
    slot = null;
    teardownPrewarmedSlot(current, false);
  };
}

function createHiddenRealmIframe(
  hostDocument: Document,
  hostTrustedTypes: TrustedTypePolicyFactoryLike | undefined,
): HTMLIFrameElement {
  const iframe = hostDocument.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  for (const [property, value] of [
    ["position", "absolute"],
    ["top", "0"],
    ["left", "0"],
    ["width", "1px"],
    ["height", "1px"],
    ["border", "0"],
    ["opacity", "0"],
    ["pointer-events", "none"],
  ] as const) {
    iframe.style.setProperty(property, value, "important");
  }
  try {
    iframe.srcdoc = (hostTrustedTypes?.emptyHTML ?? "") as string;
  } catch (error) {
    throw new Error("v-frame could not create its empty srcdoc execution realm", {
      cause: error,
    });
  }
  return iframe;
}

/** Prewarms a single pristine hidden srcdoc iframe per host document for atomic `moveBefore` claiming. */
export function prewarmRealmIframe(
  targetDocument: Document | undefined = globalThis.document,
): () => void {
  const hostWindow = targetDocument?.defaultView as
    | (Window & {
        ShadowRoot?: typeof ShadowRoot;
        trustedTypes?: TrustedTypePolicyFactoryLike;
      })
    | null
    | undefined;
  const hostRoot = targetDocument?.documentElement;
  const moveBefore =
    hostWindow === globalThis.window && typeof nativeShadowMoveBefore === "function"
      ? nativeShadowMoveBefore
      : (
          hostWindow?.ShadowRoot?.prototype as
            | (ShadowRoot & { moveBefore?: NativeMoveBefore })
            | undefined
        )?.moveBefore;
  if (
    targetDocument === undefined ||
    !hostWindow ||
    !hostRoot ||
    typeof moveBefore !== "function"
  ) {
    return () => {};
  }
  const existing = prewarmedSlots.get(targetDocument);
  if (existing !== undefined) {
    if (existing.iframe?.parentNode === hostRoot) return makeSlotDisposer(existing);
    teardownPrewarmedSlot(existing, true);
  }
  let iframe: HTMLIFrameElement;
  try {
    iframe = createHiddenRealmIframe(targetDocument, hostWindow.trustedTypes);
  } catch {
    return () => {};
  }
  const expectedSrcdoc = iframe.getAttribute("srcdoc");
  const slot: PrewarmedRealmSlot = {
    targetDocument,
    hostWindow,
    iframe,
    moveBefore,
    readyDoc: null,
    readyWin: null,
    expectedSrcdoc,
    onLoad: null,
    onPageHide: null,
    removalObserver: null,
  };
  const onLoad: EventListener = () => {
    // Pin the first pristine srcdoc Document/WindowProxy. Any prior or later
    // srcdoc/src modification or subsequent load invalidates the spare.
    if (slot.readyDoc !== null || slot.iframe === null) {
      teardownPrewarmedSlot(slot, false);
      return;
    }
    const doc = slot.iframe.contentDocument;
    const win = slot.iframe.contentWindow;
    if (
      doc === null ||
      win === null ||
      doc.URL !== "about:srcdoc" ||
      slot.iframe.getAttribute("srcdoc") !== slot.expectedSrcdoc ||
      slot.iframe.hasAttribute("src")
    ) {
      teardownPrewarmedSlot(slot, false);
      return;
    }
    slot.readyDoc = doc;
    slot.readyWin = win;
  };
  const onPageHide: EventListener = () => teardownPrewarmedSlot(slot, false);
  const removalObserver = new globalThis.MutationObserver(() => {
    if (
      slot.iframe !== null &&
      slot.iframe.parentNode !== slot.targetDocument?.documentElement
    ) {
      teardownPrewarmedSlot(slot, true);
    }
  });
  slot.onLoad = onLoad;
  slot.onPageHide = onPageHide;
  slot.removalObserver = removalObserver;
  iframe.addEventListener("load", onLoad);
  hostWindow.addEventListener("pagehide", onPageHide, { once: true });
  prewarmedSlots.set(targetDocument, slot);
  try {
    hostRoot.append(iframe);
    removalObserver.observe(hostRoot, { childList: true });
  } catch {
    teardownPrewarmedSlot(slot, false);
    return () => {};
  }
  return makeSlotDisposer(slot);
}

function claimPrewarmedIframe(shadowRoot: ShadowRoot): HTMLIFrameElement | null {
  if (!shadowRoot.isConnected) return null;
  const slot = prewarmedSlots.get(shadowRoot.ownerDocument);
  if (slot === undefined) return null;
  const candidate = slot.iframe;
  if (
    candidate === null ||
    candidate.parentNode !== shadowRoot.ownerDocument.documentElement
  ) {
    teardownPrewarmedSlot(slot, true);
    return null;
  }
  const { readyDoc, readyWin, expectedSrcdoc, moveBefore } = slot;
  if (readyDoc === null || readyWin === null || moveBefore === null) {
    return null;
  }
  teardownPrewarmedSlot(slot, true);
  if (
    candidate.contentDocument === readyDoc &&
    candidate.contentWindow === readyWin &&
    candidate.getAttribute("srcdoc") === expectedSrcdoc &&
    !candidate.hasAttribute("src") &&
    readyDoc.URL === "about:srcdoc"
  ) {
    try {
      moveBefore.call(shadowRoot, candidate, null);
      if (
        candidate.parentNode === shadowRoot &&
        candidate.contentDocument === readyDoc &&
        candidate.contentWindow === readyWin
      ) {
        return candidate;
      }
    } catch {
      // Fall back to a fresh realm iframe if moveBefore is rejected or resets the realm.
    }
  }
  candidate.remove();
  return null;
}

export async function connectRealmIframe(
  shadowRoot: ShadowRoot,
  signal: AbortSignal,
  locationURL: string,
  trustedTypesPolicy: VFrameTrustedTypesPolicyDefinition | null,
  isCustomPolicy = false,
): Promise<ConnectedRealmIframe> {
  if (signal.aborted) {
    throw abortError();
  }

  const hostDocument = shadowRoot.ownerDocument;
  const hostTrustedTypes = (
    hostDocument.defaultView as
      | (Window & { trustedTypes?: TrustedTypePolicyFactoryLike })
      | null
  )?.trustedTypes;
  const prewarmed = claimPrewarmedIframe(shadowRoot);
  if (signal.aborted) {
    prewarmed?.remove();
    throw abortError();
  }
  const iframe = prewarmed ?? createHiddenRealmIframe(hostDocument, hostTrustedTypes);

  let realmTrustedTypes: RealmTrustedTypes | null = null;

  await new Promise<void>((resolve, reject) => {
    let replacementDocumentOpened = false;
    const loaded = (defer = true) => {
      if (replacementDocumentOpened) {
        return;
      }
      const document = iframe.contentDocument;
      const realmWindow = iframe.contentWindow as NavigationWindow | null;
      if (document === null || realmWindow === null) {
        cleanup();
        iframe.remove();
        reject(new Error("The connected iframe has no same-origin srcdoc realm"));
        return;
      }
      if (
        !("navigation" in realmWindow) ||
        !("NavigateEvent" in realmWindow) ||
        typeof realmWindow.navigation?.addEventListener !== "function" ||
        typeof realmWindow.NavigateEvent?.prototype?.intercept !== "function"
      ) {
        cleanup();
        iframe.remove();
        reject(
          new Error(
            "v-frame requires Navigation API support to isolate native Location changes",
          ),
        );
        return;
      }

      replacementDocumentOpened = true;
      const initialize = () => {
        if (signal.aborted) {
          return;
        }
        try {
          const factory = (
            realmWindow as unknown as { trustedTypes?: TrustedTypePolicyFactoryLike }
          ).trustedTypes;
          const isTrustedHTML = (value: unknown): boolean =>
            Boolean(factory?.isHTML?.(value) || hostTrustedTypes?.isHTML?.(value));
          const makeGuestHTML =
            (wrap: ((source: string) => string) | null) =>
            (value: unknown, legacyNull = false): string => {
              if (isTrustedHTML(value)) return value as string;
              const text = legacyNull
                ? toLegacyNullToEmptyString(value)
                : toDOMString(value);
              return wrap ? wrap(text) : text;
            };
          if (trustedTypesPolicy === null) {
            realmTrustedTypes = {
              createHTML: (source) => source,
              createGuestHTML: makeGuestHTML(null),
              createScript: (source) => source,
              createScriptURL: (source) => source,
            };
          } else {
            const policyRules = {
              createHTML: (source: string) => trustedTypesPolicy.createHTML(source),
              createScript: (source: string) => trustedTypesPolicy.createScript(source),
              createScriptURL: (source: string) =>
                trustedTypesPolicy.createScriptURL(source),
            };
            if (factory === undefined) {
              realmTrustedTypes = {
                ...policyRules,
                createGuestHTML: makeGuestHTML(
                  isCustomPolicy ? policyRules.createHTML : null,
                ),
              };
            } else {
              try {
                const policy = factory.createPolicy(trustedTypesPolicy.name, policyRules);
                const createHTML = (source: string) =>
                  policy.createHTML(source) as unknown as string;
                realmTrustedTypes = {
                  createHTML,
                  // Only custom host-supplied policies transform raw guest HTML strings;
                  // a string allowlist name keeps browser Trusted Types active on guest sinks.
                  createGuestHTML: makeGuestHTML(isCustomPolicy ? createHTML : null),
                  createScript: (source) =>
                    policy.createScript(source) as unknown as string,
                  createScriptURL: (source) =>
                    policy.createScriptURL(source) as unknown as string,
                };
              } catch (error) {
                throw new Error(
                  `v-frame could not create Trusted Types policy ${JSON.stringify(trustedTypesPolicy.name)} for ${locationURL}`,
                  { cause: error },
                );
              }
            }
          }
          let sawCompleteEvent = false;
          const onReadyStateChange = () => {
            if (document.readyState === "complete") {
              sawCompleteEvent = true;
            }
          };
          document.open();
          document.addEventListener("readystatechange", onReadyStateChange);
          try {
            document.write(realmTrustedTypes.createHTML("<!doctype html>"));
            document.close();
          } finally {
            document.removeEventListener("readystatechange", onReadyStateChange);
          }
          const finalizeLocation = (allowRetry: boolean) => {
            try {
              realmWindow.history.replaceState(null, "", locationURL);
              cleanup();
              resolve();
            } catch (error) {
              if (allowRetry) {
                realmWindow.setTimeout(() => finalizeLocation(false), 0);
                return;
              }
              cleanup();
              iframe.remove();
              reject(
                new Error(
                  `v-frame could not initialize its execution realm at ${locationURL}`,
                  { cause: error },
                ),
              );
            }
          };
          // Chromium fires the native readystatechange("complete") synchronously inside
          // document.close(), so replaceState can run immediately without a timer hop.
          // Engines that defer readystatechange("complete") (Firefox) yield one task so
          // the native event drains before guest lifecycle listeners attach.
          if (sawCompleteEvent) {
            finalizeLocation(true);
          } else {
            realmWindow.setTimeout(() => finalizeLocation(false), 0);
          }
        } catch (error) {
          cleanup();
          iframe.remove();
          reject(error);
        }
      };
      if (defer) queueMicrotask(initialize);
      else initialize();
    };
    const onLoad = () => loaded(true);
    const aborted = () => {
      cleanup();
      iframe.remove();
      reject(abortError());
    };
    const cleanup = () => {
      iframe.removeEventListener("load", onLoad);
      signal.removeEventListener("abort", aborted);
    };

    signal.addEventListener("abort", aborted, { once: true });
    if (prewarmed !== null) {
      loaded(false);
    } else {
      iframe.addEventListener("load", onLoad);
      shadowRoot.append(iframe);
    }
  });

  if (signal.aborted) {
    iframe.remove();
    throw abortError();
  }

  if (realmTrustedTypes === null) {
    iframe.remove();
    throw new Error(`v-frame did not initialize its execution realm at ${locationURL}`);
  }
  return { iframe, trustedTypes: realmTrustedTypes };
}
