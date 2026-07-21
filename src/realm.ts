import {
  CSSOMImportRuleError,
  fetchStylesheetText,
  rewriteCSSOMAddRule,
  rewriteCSSOMInsertRule,
  rewriteCSSOMSelectorText,
  rewriteStyleAttribute,
  rewriteStylesheet,
  type StylesheetContext,
  type StylesheetImportFailure,
} from "./css.js";
import {
  installDocumentFacade,
  type DocumentFacade,
} from "./document-facade.js";
import { VirtualHistory, VirtualHistorySession } from "./history.js";
import {
  V_FRAME_GATEWAY_VERSION,
  V_FRAME_REALM_MARKER,
} from "./gateway-contract.js";
import {
  prepareAdoptedMarkup,
  prepareMarkup,
  type PreparedMarkup,
} from "./markup.js";
import { installNetworkPatches } from "./network.js";
import { ScriptRunner } from "./scripts.js";
import { isSameDocumentFragment } from "./url.js";
import type {
  VFrameCredentials,
  VFrameErrorPhase,
  VFrameNavigateEventDetail,
  VFrameWindow,
} from "./types.js";

const INTERNAL_CSS = `
:host {
  contain: layout;
  display: block;
  position: relative;
  overflow: auto;
}
v-html,
v-body {
  display: block;
}
v-head {
  display: none !important;
}
`;

// Initial markup can contain rewritten inline !important rules; staging must
// outrank them without exposing a private marker attribute to the child app.
// The shadow host is featureless, so on :host the armor only matches as the
// functional argument, :host(:not(...)) — a bare :host:not(...) never does.
const STAGING_SELECTOR_SPECIFICITY = `:not(${Array.from(
  { length: 64 },
  (_value, index) => `#v-frame-staging-${index}`,
).join("")})`;

interface BridgedWindowListener {
  type: string;
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
  signal?: AbortSignal;
  abort?: () => void;
  wrapper: EventListener;
}

interface WindowEventHandler {
  listener: EventListener;
  wrapper: EventListener;
}

interface DynamicStyleSnapshot {
  source: string;
  stylesheetURL: string;
  media: string;
  disabled: boolean;
}

interface DynamicStyleUpdate {
  revision: number;
  snapshot: DynamicStyleSnapshot;
  physicalText: string;
  status: "pending" | "committed" | "empty" | "failed";
}

interface DynamicLinkSnapshot {
  href: string;
  media: string;
  disabled: boolean;
  authoredRel: string;
}

interface DynamicLinkUpdate {
  revision: number;
  snapshot: DynamicLinkSnapshot | null;
  authoredRel: string | null;
}

const VIRTUAL_WINDOW_EVENT_HANDLER_TYPES = new Set([
  "auxclick",
  "beforeinput",
  "blur",
  "change",
  "click",
  "contextmenu",
  "dblclick",
  "focus",
  "input",
  "keydown",
  "keypress",
  "keyup",
  "mousedown",
  "mouseenter",
  "mouseleave",
  "mousemove",
  "mouseout",
  "mouseover",
  "mouseup",
  "pointercancel",
  "pointerdown",
  "pointerenter",
  "pointerleave",
  "pointermove",
  "pointerout",
  "pointerover",
  "pointerup",
  "resize",
  "scroll",
  "submit",
  "touchcancel",
  "touchend",
  "touchmove",
  "touchstart",
  "wheel",
]);

function inheritedPropertyDescriptor(
  value: object,
  name: PropertyKey,
): PropertyDescriptor | undefined {
  let prototype: object | null = value;
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (descriptor !== undefined) {
      return descriptor;
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  return undefined;
}

export interface RealmFailure {
  phase: VFrameErrorPhase;
  url: string;
  error: unknown;
}

export interface CreateRealmOptions {
  host: HTMLElement;
  shadowRoot: ShadowRoot;
  iframe: HTMLIFrameElement;
  markup:
    | { kind: "document"; source: string }
    | { kind: "adopted"; source: string; previewNodes: readonly Node[] };
  pageURL: string;
  historySession: VirtualHistorySession;
  stageMarkup: boolean;
  credentials: VFrameCredentials;
  signal: AbortSignal;
  getNonce(): string;
  fetchStylesheet(url: string): Promise<string>;
  onURLChange(url: string): void;
  onNavigate(detail: VFrameNavigateEventDetail): boolean;
  onShellNavigation(detail: VFrameNavigateEventDetail): boolean;
  onNativeLocationNavigation(detail: VFrameNavigateEventDetail): void;
  onError(failure: RealmFailure): void;
  onFatal(failure: RealmFailure): void;
}

export interface VFrameRealm {
  readonly window: VFrameWindow;
  executeInitialScripts(): Promise<void>;
  reveal(): void;
  dispose(): void;
}

function abortError(): DOMException {
  return new DOMException("The v-frame load was superseded", "AbortError");
}

export async function connectRealmIframe(
  shadowRoot: ShadowRoot,
  signal: AbortSignal,
  locationURL: string,
): Promise<HTMLIFrameElement> {
  if (signal.aborted) {
    throw abortError();
  }

  const iframe = shadowRoot.ownerDocument.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.style.setProperty("position", "absolute", "important");
  iframe.style.setProperty("top", "0", "important");
  iframe.style.setProperty("left", "0", "important");
  iframe.style.setProperty("width", "1px", "important");
  iframe.style.setProperty("height", "1px", "important");
  iframe.style.setProperty("border", "0", "important");
  iframe.style.setProperty("opacity", "0", "important");
  iframe.style.setProperty("pointer-events", "none", "important");
  iframe.src = locationURL;

  await new Promise<void>((resolve, reject) => {
    let replacementDocumentOpened = false;
    const loaded = () => {
      if (!replacementDocumentOpened) {
        const document = iframe.contentDocument;
        const realmWindow = iframe.contentWindow;
        if (document === null || realmWindow === null) {
          cleanup();
          iframe.remove();
          reject(new Error("The connected iframe has no same-origin initial realm"));
          return;
        }
        if (
          document.querySelector(
            `meta[name="${V_FRAME_REALM_MARKER}"][content="${V_FRAME_GATEWAY_VERSION}"]`,
          ) === null
        ) {
          cleanup();
          iframe.remove();
          reject(new Error(
            `v-frame route ${locationURL} did not return the gateway realm marker`,
          ));
          return;
        }
        if (
          realmWindow.location.href !== locationURL
        ) {
          const resolvedURL = realmWindow.location.href;
          cleanup();
          iframe.remove();
          reject(new Error(
            `v-frame route ${locationURL} resolved its iframe marker to ${resolvedURL}`,
          ));
          return;
        }

        replacementDocumentOpened = true;
        // document.open() keeps the current URL without making another request.
        queueMicrotask(() => {
          if (signal.aborted) {
            return;
          }
          try {
            document.open();
            document.write("<!doctype html>");
            document.close();
            // Firefox completes the replacement document asynchronously; wait
            // so application handlers cannot observe that bootstrap lifecycle.
            realmWindow.setTimeout(() => {
              cleanup();
              resolve();
            }, 0);
          } catch (error) {
            cleanup();
            iframe.remove();
            reject(error);
          }
        });
        return;
      }

      cleanup();
      resolve();
    };
    const aborted = () => {
      cleanup();
      iframe.remove();
      reject(abortError());
    };
    const cleanup = () => {
      iframe.removeEventListener("load", loaded);
      signal.removeEventListener("abort", aborted);
    };

    iframe.addEventListener("load", loaded);
    signal.addEventListener("abort", aborted, { once: true });
    shadowRoot.append(iframe);
  });

  if (signal.aborted) {
    iframe.remove();
    throw abortError();
  }

  return iframe;
}

interface InternalStyles {
  updateTopLayerViewport(x: number, y: number): void;
  dispose(): void;
}

function installInternalStyles(shadowRoot: ShadowRoot): InternalStyles {
  const previous = [...shadowRoot.adoptedStyleSheets];
  const view = shadowRoot.ownerDocument.defaultView;
  if (view === null || typeof view.CSSStyleSheet !== "function") {
    return {
      updateTopLayerViewport: () => undefined,
      dispose: () => undefined,
    };
  }

  try {
    const sheet = new view.CSSStyleSheet();
    sheet.replaceSync(INTERNAL_CSS);
    shadowRoot.adoptedStyleSheets = [...previous, sheet];
    return {
      updateTopLayerViewport(x, y) {
        sheet.replaceSync(`${INTERNAL_CSS}
:where([popover]:popover-open) {
  translate: ${x}px ${y}px !important;
}
`);
      },
      dispose() {
        shadowRoot.adoptedStyleSheets = shadowRoot.adoptedStyleSheets.filter(
          (candidate) => candidate !== sheet,
        );
      },
    };
  } catch {
    return {
      updateTopLayerViewport: () => undefined,
      dispose: () => undefined,
    };
  }
}

function installStagingStyles(shadowRoot: ShadowRoot): () => void {
  const view = shadowRoot.ownerDocument.defaultView;
  if (view === null || typeof view.CSSStyleSheet !== "function") {
    throw new Error(
      "Cannot stage v-frame markup without constructed stylesheet support",
    );
  }

  const liveMarkupPosition = Array.from(shadowRoot.children).filter(
    (element) => element.localName === "v-html",
  ).length + 1;
  const liveMarkupSelector =
    `:host > v-html:nth-of-type(${liveMarkupPosition})${STAGING_SELECTOR_SPECIFICITY}`;
  const sheet = new view.CSSStyleSheet();
  sheet.replaceSync(`
:host(${STAGING_SELECTOR_SPECIFICITY}) {
  display: grid !important;
}
:host > v-html${STAGING_SELECTOR_SPECIFICITY} {
  grid-area: 1 / 1 !important;
  min-width: 0 !important;
}
${liveMarkupSelector},
${liveMarkupSelector} * {
  visibility: hidden !important;
  pointer-events: none !important;
}
${liveMarkupSelector} {
  opacity: 0 !important;
}
`);
  shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
  return () => {
    shadowRoot.adoptedStyleSheets = shadowRoot.adoptedStyleSheets.filter(
      (candidate) => candidate !== sheet,
    );
  };
}

function installWindowEventBridge(
  window: VFrameWindow,
  virtualEventTarget: ShadowRoot,
  eventForListener: (event: Event, currentTarget: EventTarget) => Event,
): () => void {
  const nativeAddEventListener = window.addEventListener.bind(window);
  const nativeRemoveEventListener = window.removeEventListener.bind(window);
  const records: BridgedWindowListener[] = [];
  const eventHandlers = new Map<string, WindowEventHandler>();
  const patchedDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();

  const patch = (name: PropertyKey, descriptor: PropertyDescriptor) => {
    patchedDescriptors.set(name, Object.getOwnPropertyDescriptor(window, name));
    Object.defineProperty(window, name, { configurable: true, ...descriptor });
  };

  const removeRecord = (record: BridgedWindowListener) => {
    const index = records.indexOf(record);
    if (index !== -1) {
      records.splice(index, 1);
    }
    nativeRemoveEventListener(record.type, record.wrapper, record.capture);
    virtualEventTarget.removeEventListener(record.type, record.wrapper, record.capture);
    if (record.signal !== undefined && record.abort !== undefined) {
      record.signal.removeEventListener("abort", record.abort);
    }
  };

  patch("addEventListener", {
    writable: true,
    value(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (listener === null) {
        return;
      }
      if (typeof options !== "boolean" && options?.signal?.aborted === true) {
        return;
      }

      const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
      if (
        records.some(
          (record) =>
            record.type === type && record.listener === listener && record.capture === capture,
        )
      ) {
        return;
      }

      const record: BridgedWindowListener = {
        type,
        listener,
        capture,
        wrapper: () => undefined,
      };
      record.wrapper = (event) => {
        try {
          const listenerEvent = eventForListener(event, window);
          if (typeof listener === "function") {
            listener.call(window, listenerEvent);
          } else {
            listener.handleEvent(listenerEvent);
          }
        } finally {
          if (typeof options !== "boolean" && options?.once === true) {
            removeRecord(record);
          }
        }
      };
      records.push(record);
      const listenerOptions = typeof options === "boolean"
        ? options
        : { capture, passive: options?.passive ?? false };
      nativeAddEventListener(type, record.wrapper, listenerOptions);
      virtualEventTarget.addEventListener(type, record.wrapper, listenerOptions);
      if (typeof options !== "boolean" && options?.signal !== undefined) {
        record.signal = options.signal;
        record.abort = () => removeRecord(record);
        options.signal.addEventListener("abort", record.abort, { once: true });
      }
    },
  });
  patch("removeEventListener", {
    writable: true,
    value(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      if (listener === null) {
        return;
      }

      const capture = typeof options === "boolean" ? options : (options?.capture ?? false);
      const index = records.findIndex(
        (record) =>
          record.type === type && record.listener === listener && record.capture === capture,
      );
      const record = records[index];
      if (record === undefined) {
        return;
      }
      removeRecord(record);
    },
  });

  const discoveredHandlerProperties = new Map<string, PropertyDescriptor>();
  let prototype: object | null = window;
  while (prototype !== null) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (
        discoveredHandlerProperties.has(name) ||
        !name.startsWith("on") ||
        !VIRTUAL_WINDOW_EVENT_HANDLER_TYPES.has(name.slice(2))
      ) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor?.get !== undefined && descriptor.set !== undefined) {
        discoveredHandlerProperties.set(name, descriptor);
      }
    }
    prototype = Object.getPrototypeOf(prototype);
  }

  for (const [name, nativeDescriptor] of discoveredHandlerProperties) {
    const eventType = name.slice(2);
    patch(name, {
      enumerable: nativeDescriptor.enumerable ?? false,
      get: () => eventHandlers.get(eventType)?.listener ?? null,
      set(value: unknown) {
        const previous = eventHandlers.get(eventType);
        if (previous !== undefined) {
          window.removeEventListener(eventType, previous.wrapper);
          eventHandlers.delete(eventType);
        }
        if (typeof value !== "function") {
          return;
        }

        const listener = value as (this: VFrameWindow, event: Event) => unknown;
        const wrapper: EventListener = (event) => {
          if (listener.call(window, event) === false) {
            event.preventDefault();
          }
        };
        eventHandlers.set(eventType, { listener: value as EventListener, wrapper });
        window.addEventListener(eventType, wrapper);
      },
    });
  }

  return () => {
    for (const record of [...records]) {
      removeRecord(record);
    }
    eventHandlers.clear();
    for (const [name, descriptor] of [...patchedDescriptors].reverse()) {
      if (descriptor === undefined) {
        delete (window as unknown as Record<PropertyKey, unknown>)[name];
      } else {
        Object.defineProperty(window, name, descriptor);
      }
    }
  };
}

function installViewportPatches(
  host: HTMLElement,
  window: VFrameWindow,
  getSelection: () => Selection | null,
  dispatchScrollEvent: () => void,
): { dispose(): void } {
  const hostWindow = host.ownerDocument.defaultView;
  if (hostWindow === null || typeof hostWindow.matchMedia !== "function") {
    throw new Error("v-frame requires a host window with matchMedia support");
  }

  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const patch = (name: PropertyKey, descriptor: PropertyDescriptor) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(window, name));
    try {
      Object.defineProperty(window, name, { configurable: true, ...descriptor });
    } catch {
      descriptors.delete(name);
    }
  };

  patch("innerWidth", { get: () => hostWindow.innerWidth });
  patch("innerHeight", { get: () => hostWindow.innerHeight });
  patch("outerWidth", { get: () => hostWindow.outerWidth });
  patch("outerHeight", { get: () => hostWindow.outerHeight });
  patch("visualViewport", { get: () => hostWindow.visualViewport });
  patch("matchMedia", {
    writable: true,
    value: hostWindow.matchMedia.bind(hostWindow),
  });
  patch("scrollX", { get: () => host.scrollLeft });
  patch("scrollY", { get: () => host.scrollTop });
  patch("pageXOffset", { get: () => host.scrollLeft });
  patch("pageYOffset", { get: () => host.scrollTop });
  patch("scrollTo", {
    writable: true,
    value: host.scrollTo.bind(host),
  });
  patch("scroll", {
    writable: true,
    value: host.scroll.bind(host),
  });
  patch("scrollBy", {
    writable: true,
    value: host.scrollBy.bind(host),
  });
  patch("getSelection", {
    writable: true,
    value: getSelection,
  });

  const resizeListener = () => {
    window.dispatchEvent(new window.Event("resize"));
  };
  hostWindow.addEventListener("resize", resizeListener);
  let disposed = false;
  const scrollListener = () => {
    if (!disposed) {
      dispatchScrollEvent();
    }
  };
  host.addEventListener("scroll", scrollListener, { passive: true });

  return {
    dispose() {
      disposed = true;
      hostWindow.removeEventListener("resize", resizeListener);
      host.removeEventListener("scroll", scrollListener);
      for (const [name, descriptor] of descriptors) {
        if (descriptor === undefined) {
          delete (window as unknown as Record<PropertyKey, unknown>)[name];
        } else {
          Object.defineProperty(window, name, descriptor);
        }
      }
    },
  };
}

export async function createRealm(options: CreateRealmOptions): Promise<VFrameRealm> {
  const internalStyles = installInternalStyles(options.shadowRoot);
  const bootstrapDisposers: Array<() => void> = [];
  let restoreStagingStyles: () => void = () => undefined;
  let iframe: HTMLIFrameElement | null = options.iframe;
  let markup: PreparedMarkup | null = null;

  try {
    const window = iframe.contentWindow as VFrameWindow | null;
    const document = iframe.contentDocument;
    if (window === null || document === null) {
      throw new Error("The connected iframe has no same-origin execution realm");
    }

    const nativeCurrentScriptGetter = Object.getOwnPropertyDescriptor(
      window.Document.prototype,
      "currentScript",
    )?.get;
    const nativeWindowOpen = window.open.bind(window);
    const scheduleNavigationDefault = window.setTimeout.bind(window);

    const prepare = options.markup.kind === "adopted"
      ? prepareAdoptedMarkup
      : prepareMarkup;
    markup = await prepare({
      window,
      document,
      source: options.markup.source,
      pageURL: options.pageURL,
      nonce: options.getNonce(),
      fetchStylesheet: options.fetchStylesheet,
      onError(failure) {
        if (!options.signal.aborted) {
          options.onError(failure);
        }
      },
    });

    if (options.signal.aborted) {
      throw abortError();
    }

    const privateHead = document.head;
    if (privateHead === null) {
      throw new Error("The execution document lost its private head before bootstrap");
    }
    const privateBase = document.createElement("base");
    privateBase.href = markup.baseURL;
    privateHead.append(privateBase);

    let currentURL = options.pageURL;
    let disposed = false;
    let fatalReported = false;
    let navigationInstalled = false;
    let scriptRunner: ScriptRunner | null = null;
    let facade: DocumentFacade | null = null;
    const stylesheetContext = markup.stylesheetContext;
    const processedStyles = new WeakMap<HTMLStyleElement, string>();
    const dynamicStyleUpdates = new WeakMap<HTMLStyleElement, DynamicStyleUpdate>();
    const dynamicLinkUpdates = new WeakMap<HTMLLinkElement, DynamicLinkUpdate>();
    const generatedStyleWrites = new WeakSet<HTMLStyleElement>();
    const connectedStylesAwaitingObservation = new WeakSet<HTMLStyleElement>();
    const connectedLinksAwaitingObservation = new WeakSet<HTMLLinkElement>();
    const isConnectedToRealm = (node: Node): boolean => markup?.html.contains(node) ?? false;

    const reportFatal = (failure: RealmFailure) => {
      if (disposed || fatalReported) {
        return;
      }
      fatalReported = true;
      options.onFatal(failure);
    };
    const getDocumentBaseURL = (): string => {
      for (const base of markup?.html.querySelectorAll("base[href]") ?? []) {
        const authoredHref = markup?.authoredURLAttributes.get(base)?.get("href") ??
          base.getAttribute("href") ??
          "";
        try {
          return new URL(authoredHref, currentURL).href;
        } catch {
          continue;
        }
      }
      return currentURL;
    };
    const getDocumentBaseTarget = (): string => {
      for (const base of markup?.html.querySelectorAll("base[target]") ?? []) {
        const target = base.getAttribute("target") ?? "";
        const normalizedTarget = target.toLowerCase();
        const isKeyword = normalizedTarget === "_blank" ||
          normalizedTarget === "_self" ||
          normalizedTarget === "_parent" ||
          normalizedTarget === "_top";
        if (
          target === "" ||
          /[\t\n\r<]/.test(target) ||
          (target.startsWith("_") && !isKeyword)
        ) {
          continue;
        }
        return normalizedTarget;
      }
      return "_self";
    };
    const updateDocumentBaseURL = (): void => {
      privateBase.href = getDocumentBaseURL();
      facade?.rebaseURLs();
    };

    const history = new VirtualHistory({
      window,
      session: options.historySession,
      getBaseURL: getDocumentBaseURL,
      onNavigate: options.onNavigate,
      onURLChange(url) {
        currentURL = url;
        updateDocumentBaseURL();
        options.onURLChange(url);
      },
    });
    history.install();
    bootstrapDisposers.push(() => history.dispose());

    const networkDispose = installNetworkPatches({
      window,
      signal: options.signal,
      credentials: options.credentials,
      getBaseURL: getDocumentBaseURL,
    });
    bootstrapDisposers.push(networkDispose);
    const viewport = installViewportPatches(
      options.host,
      window,
      () => facade?.getSelection() ?? null,
      () => {
        facade?.dispatchDocumentEvent("scroll", { bubbles: true });
      },
    );
    bootstrapDisposers.push(() => viewport.dispose());

    const registeredStyleSheets = new WeakSet<CSSStyleSheet>();
    const registeredStyleRules = new WeakSet<CSSStyleRule>();
    const registeredStyleDeclarations = new WeakSet<CSSStyleDeclaration>();
    const installCSSOMRules = (sheet: CSSStyleSheet): void => {
      const installRule = (rule: CSSRule): void => {
        if (rule.type === window.CSSRule.STYLE_RULE) {
          const styleRule = rule as CSSStyleRule;
          if (!registeredStyleRules.has(styleRule)) {
            registeredStyleRules.add(styleRule);
            const selectorText = inheritedPropertyDescriptor(styleRule, "selectorText");
            if (selectorText?.get !== undefined && selectorText.set !== undefined) {
              try {
                Object.defineProperty(styleRule, "selectorText", {
                  configurable: true,
                  get: () => selectorText.get?.call(styleRule),
                  set(value: string) {
                    selectorText.set?.call(
                      styleRule,
                      rewriteCSSOMSelectorText(String(value)),
                    );
                  },
                });
              } catch {
                // Browser CSSOM objects may reject own property definitions.
              }
            }

            const declaration = styleRule.style;
            if (!registeredStyleDeclarations.has(declaration)) {
              registeredStyleDeclarations.add(declaration);
              const cssText = inheritedPropertyDescriptor(declaration, "cssText");
              if (cssText?.get !== undefined && cssText.set !== undefined) {
                try {
                  Object.defineProperty(declaration, "cssText", {
                    configurable: true,
                    get: () => cssText.get?.call(declaration),
                    set(value: string) {
                      cssText.set?.call(
                        declaration,
                        rewriteStyleAttribute(String(value), getDocumentBaseURL()),
                      );
                    },
                  });
                } catch {
                  // Browser CSSOM objects may reject own property definitions.
                }
              }
            }
          }
        }

        const nested = rule as CSSRule & { cssRules?: CSSRuleList };
        if (nested.cssRules !== undefined) {
          for (const child of Array.from(nested.cssRules)) {
            installRule(child);
          }
        }
      };

      for (const rule of Array.from(sheet.cssRules)) {
        installRule(rule);
      }
    };
    const applyNonce = (style: HTMLStyleElement): void => {
      if (options.getNonce() === "") {
        style.removeAttribute("nonce");
      } else {
        style.nonce = options.getNonce();
      }
    };
    const installCSSOMStyleSheet = (style: HTMLStyleElement): void => {
      applyNonce(style);
      if ((style.textContent ?? "") === "") {
        processedStyles.set(style, "");
      }

      const sheet = style.sheet;
      if (sheet === null) {
        return;
      }
      if (registeredStyleSheets.has(sheet)) {
        installCSSOMRules(sheet);
        return;
      }
      registeredStyleSheets.add(sheet);

      const nativeInsertRule = sheet.insertRule;
      const legacySheet = sheet as CSSStyleSheet & {
        addRule?: (selector: string, declarations: string, index?: number) => number;
      };
      const nativeAddRule = legacySheet.addRule;
      Object.defineProperties(sheet, {
        insertRule: {
          configurable: true,
          writable: true,
          value(rule: string, index?: number): number {
            let rewritten: string;
            try {
              rewritten = rewriteCSSOMInsertRule(String(rule), getDocumentBaseURL());
            } catch (error) {
              if (error instanceof CSSOMImportRuleError) {
                throw new window.DOMException(
                  "CSSOM @import rules are unsupported inside v-frame",
                  "NotSupportedError",
                );
              }
              throw error;
            }

            const insertionIndex = index === undefined
              ? nativeInsertRule.call(sheet, rewritten)
              : nativeInsertRule.call(sheet, rewritten, index);
            installCSSOMRules(sheet);
            return insertionIndex;
          },
        },
        addRule: {
          configurable: true,
          writable: true,
          value(selector: string, declarations: string, index?: number): number {
            const rewritten = rewriteCSSOMAddRule(
              String(selector),
              String(declarations),
              getDocumentBaseURL(),
            );
            if (nativeAddRule !== undefined) {
              const result = index === undefined
                ? nativeAddRule.call(sheet, rewritten.selector, rewritten.declarations)
                : nativeAddRule.call(sheet, rewritten.selector, rewritten.declarations, index);
              installCSSOMRules(sheet);
              return result;
            }

            const insertionIndex = index ?? sheet.cssRules.length;
            const result = nativeInsertRule.call(
              sheet,
              `${rewritten.selector}{${rewritten.declarations}}`,
              insertionIndex,
            );
            installCSSOMRules(sheet);
            return result;
          },
        },
      });
      installCSSOMRules(sheet);
    };
    const virtualStylesFrom = (nodes: readonly Node[]): HTMLStyleElement[] => {
      const styles: HTMLStyleElement[] = [];
      for (const node of nodes) {
        if (
          node instanceof window.HTMLStyleElement &&
          node !== markup?.inlineStyleSheet
        ) {
          styles.push(node);
        }
        if (node instanceof window.Element || node instanceof window.DocumentFragment) {
          styles.push(
            ...Array.from(node.querySelectorAll("style"))
              .filter((style) => style !== markup?.inlineStyleSheet),
          );
        }
      }
      return styles;
    };
    const installCSSOMStyleSheets = (nodes: readonly Node[]): void => {
      for (const style of virtualStylesFrom(nodes)) {
        if (isConnectedToRealm(style)) {
          installCSSOMStyleSheet(style);
        }
      }
    };

    const dynamicLinksFrom = (nodes: readonly Node[]): HTMLLinkElement[] => {
      const links = new Set<HTMLLinkElement>();
      for (const node of nodes) {
        if (node instanceof window.HTMLLinkElement) {
          links.add(node);
        }
        if (node instanceof window.Element || node instanceof window.DocumentFragment) {
          for (const link of node.querySelectorAll<HTMLLinkElement>("link")) {
            links.add(link);
          }
        }
      }
      return [...links];
    };
    const createRevisionStylesheetContext = (
      importFailures: StylesheetImportFailure[],
    ): StylesheetContext => ({
      fetchText: stylesheetContext.fetchText,
      requests: stylesheetContext.requests,
      onImportFailure(failure) {
        importFailures.push(failure);
      },
    });
    const reportImportFailures = (
      failures: readonly StylesheetImportFailure[],
      revisionIsCurrent: () => boolean,
    ): void => {
      for (const failure of failures) {
        if (!revisionIsCurrent()) {
          return;
        }
        options.onError({ phase: "stylesheet", ...failure });
      }
    };
    const sameStyleSnapshot = (
      first: DynamicStyleSnapshot,
      second: DynamicStyleSnapshot,
    ): boolean =>
      first.source === second.source &&
      first.stylesheetURL === second.stylesheetURL &&
      first.media === second.media &&
      first.disabled === second.disabled;
    const setGeneratedStyleText = (
      style: HTMLStyleElement,
      update: DynamicStyleUpdate,
      text: string,
    ): void => {
      update.physicalText = text;
      if ((style.textContent ?? "") !== text) {
        generatedStyleWrites.add(style);
        try {
          style.textContent = text;
        } finally {
          generatedStyleWrites.delete(style);
        }
      }
    };
    const styleRevisionIsCurrent = (
      style: HTMLStyleElement,
      update: DynamicStyleUpdate,
      revision: number,
      snapshot: DynamicStyleSnapshot,
    ): boolean =>
      !disposed &&
      !options.signal.aborted &&
      isConnectedToRealm(style) &&
      update.revision === revision &&
      update.snapshot === snapshot &&
      (style.textContent ?? "") === update.physicalText &&
      style.media === snapshot.media &&
      style.disabled === snapshot.disabled;
    const startDynamicStyleRevision = (
      style: HTMLStyleElement,
      snapshot: DynamicStyleSnapshot,
      update: DynamicStyleUpdate,
    ): void => {
      update.revision += 1;
      update.snapshot = snapshot;
      const revision = update.revision;

      if (snapshot.source === "") {
        update.status = "empty";
        setGeneratedStyleText(style, update, "");
        processedStyles.set(style, "");
        installCSSOMStyleSheet(style);
        return;
      }

      update.status = "pending";
      setGeneratedStyleText(style, update, "");
      processedStyles.set(style, "");
      installCSSOMStyleSheet(style);
      void (async () => {
        const importFailures: StylesheetImportFailure[] = [];
        try {
          const rewritten = await rewriteStylesheet(
            snapshot.source,
            snapshot.stylesheetURL,
            createRevisionStylesheetContext(importFailures),
          );
          if (!styleRevisionIsCurrent(style, update, revision, snapshot)) {
            return;
          }
          applyNonce(style);
          setGeneratedStyleText(style, update, rewritten);
          update.status = "committed";
          processedStyles.set(style, rewritten);
          installCSSOMStyleSheet(style);
          reportImportFailures(
            importFailures,
            () => styleRevisionIsCurrent(style, update, revision, snapshot),
          );
        } catch (error) {
          if (!styleRevisionIsCurrent(style, update, revision, snapshot)) {
            return;
          }
          update.status = "failed";
          options.onError({
            phase: "stylesheet",
            url: snapshot.stylesheetURL,
            error,
          });
        }
      })();
    };
    const scheduleDynamicStyle = (
      style: HTMLStyleElement,
      source: string,
      forceRevision = false,
    ): void => {
      if (!isConnectedToRealm(style)) {
        const update = dynamicStyleUpdates.get(style);
        if (update !== undefined) {
          update.revision += 1;
        }
        return;
      }

      const snapshot: DynamicStyleSnapshot = {
        source,
        stylesheetURL: getDocumentBaseURL(),
        media: style.media,
        disabled: style.disabled,
      };
      let update = dynamicStyleUpdates.get(style);
      if (update === undefined) {
        update = {
          revision: 0,
          snapshot,
          physicalText: style.textContent ?? "",
          status: source === "" ? "empty" : "committed",
        };
        dynamicStyleUpdates.set(style, update);
      } else if (
        !forceRevision &&
        sameStyleSnapshot(update.snapshot, snapshot) &&
        update.physicalText === (style.textContent ?? "")
      ) {
        return;
      }

      startDynamicStyleRevision(style, snapshot, update);
    };
    const scheduleDynamicStyleContent = (style: HTMLStyleElement): void => {
      const source = style.textContent ?? "";
      const update = dynamicStyleUpdates.get(style);
      if (update?.physicalText === source) {
        return;
      }
      if (processedStyles.get(style) === source) {
        return;
      }
      scheduleDynamicStyle(style, source);
    };
    const scheduleDynamicStyleAttributes = (style: HTMLStyleElement): void => {
      const update = dynamicStyleUpdates.get(style);
      const physicalText = style.textContent ?? "";
      const source = update?.physicalText === physicalText
        ? update.snapshot.source
        : physicalText;
      scheduleDynamicStyle(style, source);
    };
    const scheduleConnectedDynamicStyle = (style: HTMLStyleElement): void => {
      const physicalText = style.textContent ?? "";
      const update = dynamicStyleUpdates.get(style);
      if (update === undefined && processedStyles.get(style) === physicalText) {
        dynamicStyleUpdates.set(style, {
          revision: 0,
          snapshot: {
            source: physicalText,
            stylesheetURL: getDocumentBaseURL(),
            media: style.media,
            disabled: style.disabled,
          },
          physicalText,
          status: physicalText === "" ? "empty" : "committed",
        });
        installCSSOMStyleSheet(style);
        return;
      }

      const source = update?.physicalText === physicalText
        ? update.snapshot.source
        : physicalText;
      if (
        update?.status === "committed" &&
        update.physicalText === physicalText &&
        processedStyles.get(style) === physicalText
      ) {
        update.revision += 1;
        installCSSOMStyleSheet(style);
        return;
      }
      scheduleDynamicStyle(style, source, true);
    };
    const invalidateDynamicStyle = (style: HTMLStyleElement): void => {
      const update = dynamicStyleUpdates.get(style);
      if (update !== undefined) {
        update.revision += 1;
      }
    };
    const sameLinkSnapshot = (
      first: DynamicLinkSnapshot,
      second: DynamicLinkSnapshot,
    ): boolean =>
      first.href === second.href &&
      first.media === second.media &&
      first.disabled === second.disabled &&
      first.authoredRel === second.authoredRel;
    const linkRevisionIsCurrent = (
      link: HTMLLinkElement,
      update: DynamicLinkUpdate,
      revision: number,
      snapshot: DynamicLinkSnapshot,
    ): boolean =>
      !disposed &&
      !options.signal.aborted &&
      isConnectedToRealm(link) &&
      update.revision === revision &&
      update.snapshot === snapshot &&
      update.authoredRel === snapshot.authoredRel &&
      facade?.native.getAttribute(link, "rel") === "v-frame-stylesheet" &&
      link.href === snapshot.href &&
      link.media === snapshot.media &&
      link.disabled === snapshot.disabled;
    const scheduleDynamicLink = (
      link: HTMLLinkElement,
      forceRevision = false,
      authoredRelOverride?: string | null,
    ): void => {
      let update = dynamicLinkUpdates.get(link);
      const authoredRel = authoredRelOverride !== undefined
        ? authoredRelOverride
        : (update?.authoredRel ?? link.getAttribute("rel"));
      const authoredRelValue = authoredRel ?? "";
      const isStylesheet = authoredRelValue
        .split(/[\t\n\f\r ]+/)
        .some((token) => token.toLowerCase() === "stylesheet");
      if (update === undefined) {
        update = { revision: 0, snapshot: null, authoredRel };
        dynamicLinkUpdates.set(link, update);
      } else {
        update.authoredRel = authoredRel;
      }
      if (!isConnectedToRealm(link) || !isStylesheet || !link.hasAttribute("href")) {
        update.revision += 1;
        update.snapshot = null;
        return;
      }

      const snapshot: DynamicLinkSnapshot = {
        href: link.href,
        media: link.media,
        disabled: link.disabled,
        authoredRel: authoredRelValue,
      };
      if (
        !forceRevision &&
        update.snapshot !== null &&
        sameLinkSnapshot(update.snapshot, snapshot)
      ) {
        return;
      }

      update.revision += 1;
      update.snapshot = snapshot;
      update.authoredRel = authoredRel;
      const revision = update.revision;

      void (async () => {
        const importFailures: StylesheetImportFailure[] = [];
        try {
          const source = await fetchStylesheetText(snapshot.href, stylesheetContext);
          const rewritten = await rewriteStylesheet(
            source,
            snapshot.href,
            createRevisionStylesheetContext(importFailures),
          );
          if (!linkRevisionIsCurrent(link, update, revision, snapshot)) {
            return;
          }
          const style = document.createElement("style");
          applyNonce(style);
          style.dataset.vFrameSource = snapshot.href;
          style.media = snapshot.media;
          style.textContent = rewritten;
          processedStyles.set(style, rewritten);
          link.replaceWith(style);
          // disabled only reaches a sheet once the style is connected; on a
          // detached element the assignment is a spec-mandated no-op.
          style.disabled = snapshot.disabled;
          installCSSOMStyleSheet(style);
          link.dispatchEvent(new window.Event("load"));
          reportImportFailures(
            importFailures,
            () =>
              !disposed &&
              !options.signal.aborted &&
              isConnectedToRealm(style) &&
              processedStyles.get(style) === (style.textContent ?? ""),
          );
        } catch (error) {
          if (!linkRevisionIsCurrent(link, update, revision, snapshot)) {
            return;
          }
          update.revision += 1;
          update.snapshot = null;
          link.remove();
          link.dispatchEvent(new window.Event("error"));
          options.onError({ phase: "stylesheet", url: snapshot.href, error });
        }
      })();
    };
    const invalidateDynamicLink = (link: HTMLLinkElement): void => {
      const update = dynamicLinkUpdates.get(link);
      if (update !== undefined) {
        update.revision += 1;
        update.snapshot = null;
      }
    };
    const dynamicStyles = (nodes: readonly Node[]): void => {
      const styles = virtualStylesFrom(nodes);
      const links = dynamicLinksFrom(nodes);
      for (const style of styles) {
        connectedStylesAwaitingObservation.add(style);
        scheduleConnectedDynamicStyle(style);
      }
      for (const link of links) {
        connectedLinksAwaitingObservation.add(link);
        scheduleDynamicLink(link, true);
      }

      for (const node of nodes) {
        const parentStyle = node.parentNode instanceof window.HTMLStyleElement
          ? node.parentNode
          : null;
        if (parentStyle !== null && !styles.includes(parentStyle)) {
          scheduleDynamicStyleContent(parentStyle);
        }
      }
    };

    const initialStyleSources = new Map<HTMLStyleElement, string>();
    for (const style of markup.html.querySelectorAll("style")) {
      const source = style.textContent ?? "";
      initialStyleSources.set(style, source);
      processedStyles.set(style, source);
      style.textContent = "";
    }

    facade = installDocumentFacade({
      host: options.host,
      shadowRoot: options.shadowRoot,
      window,
      document,
      html: markup.html,
      head: markup.head,
      body: markup.body,
      authoredURLAttributes: markup.authoredURLAttributes,
      authoredStyleAttributes: markup.authoredStyleAttributes,
      inlineStyleSelectorAttribute: markup.inlineStyleSelectorAttribute,
      inlineStyleSheet: markup.inlineStyleSheet,
      updateTopLayerViewport: internalStyles.updateTopLayerViewport,
      getNonce: options.getNonce,
      getBaseURL: getDocumentBaseURL,
      getCurrentURL: () => currentURL,
      getCurrentScript: () => scriptRunner?.currentScript ?? null,
      onBaseElementChange: updateDocumentBaseURL,
      onEventHandlerError(error) {
        if (!options.signal.aborted) {
          options.onError({ phase: "runtime", url: currentURL, error });
        }
      },
      onDynamicScript(script, execution) {
        scriptRunner?.executeDynamic(script, execution);
      },
      onStyleElementChange(style) {
        if (
          style === markup?.inlineStyleSheet ||
          generatedStyleWrites.has(style)
        ) {
          return;
        }
        scheduleDynamicStyle(style, style.textContent ?? "", true);
      },
      onLinkElementChange(link, authoredRel) {
        scheduleDynamicLink(link, true, authoredRel);
      },
      onConnectedNodes(nodes) {
        installCSSOMStyleSheets(nodes);
        dynamicStyles(nodes);
      },
    });
    bootstrapDisposers.push(() => facade?.dispose());
    const liveMarkup = markup.html;
    if (options.markup.kind === "adopted" || options.stageMarkup) {
      restoreStagingStyles = installStagingStyles(
        options.shadowRoot,
      );
    }
    if (!options.signal.aborted) {
      options.shadowRoot.append(liveMarkup);
      for (const [style, source] of initialStyleSources) {
        applyNonce(style);
        style.textContent = source;
      }
      installCSSOMStyleSheets([liveMarkup]);
    }
    if (options.signal.aborted) {
      throw abortError();
    }

    scriptRunner = new ScriptRunner({
      window,
      native: facade.native,
      facade,
      scripts: markup.scripts,
      signal: options.signal,
      credentials: options.credentials,
      executionOrigin: options.host.ownerDocument.location.origin,
      getNonce: options.getNonce,
      getCurrentURL: () => currentURL,
      getNativeCurrentScript: () =>
        (nativeCurrentScriptGetter?.call(document) as HTMLScriptElement | null | undefined) ?? null,
      onError(failure) {
        options.onError({ phase: "script", ...failure });
      },
      onRuntimeError(failure) {
        options.onError({ phase: "runtime", ...failure });
      },
    });
    const windowEventDispose = installWindowEventBridge(
      window,
      options.shadowRoot,
      facade.eventForListener,
    );
    bootstrapDisposers.push(windowEventDispose);

    const mutationObserver = new globalThis.MutationObserver(
      (records) => {
        const stylesWithContentChanges = new Set<HTMLStyleElement>();
        const stylesWithAttributeChanges = new Set<HTMLStyleElement>();
        const linksWithAttributeChanges = new Set<HTMLLinkElement>();
        const stylesConnectedWithoutFacade = new Set<HTMLStyleElement>();
        const linksConnectedWithoutFacade = new Set<HTMLLinkElement>();
        const removedStyles = new Set<HTMLStyleElement>();
        const removedLinks = new Set<HTMLLinkElement>();
        let baseElementsChanged = false;
        // Only HTML-namespace base elements affect the document base URL;
        // querySelector's unprefixed type selector also matches foreign ones.
        const isHTMLBase = (element: Element): boolean =>
          element.localName === "base" &&
          element.namespaceURI === "http://www.w3.org/1999/xhtml";
        const subtreeHasBaseElement = (node: Node): boolean =>
          (node instanceof window.Element && isHTMLBase(node)) ||
          ("querySelectorAll" in node &&
            Array.from((node as ParentNode).querySelectorAll("base")).some(isHTMLBase));
        for (const record of records) {
          if (record.type === "childList") {
            if (
              record.target instanceof window.HTMLStyleElement &&
              record.target !== markup?.inlineStyleSheet
            ) {
              stylesWithContentChanges.add(record.target);
            }
            for (const node of record.addedNodes) {
              facade?.markVirtualTree(node);
              for (const style of virtualStylesFrom([node])) {
                if (!connectedStylesAwaitingObservation.delete(style)) {
                  stylesConnectedWithoutFacade.add(style);
                }
              }
              for (const link of dynamicLinksFrom([node])) {
                if (!connectedLinksAwaitingObservation.delete(link)) {
                  linksConnectedWithoutFacade.add(link);
                }
              }
              baseElementsChanged ||= subtreeHasBaseElement(node);
            }
            for (const node of record.removedNodes) {
              for (const style of virtualStylesFrom([node])) {
                removedStyles.add(style);
              }
              for (const link of dynamicLinksFrom([node])) {
                removedLinks.add(link);
              }
              baseElementsChanged ||= subtreeHasBaseElement(node);
            }
          } else if (record.type === "characterData") {
            const parentStyle = record.target.parentNode instanceof window.HTMLStyleElement
              ? record.target.parentNode
              : null;
            if (parentStyle !== null) {
              stylesWithContentChanges.add(parentStyle);
            }
          } else if (
            record.type === "attributes" &&
            record.target instanceof window.Element
          ) {
            facade?.synchronizeURLAttribute(
              record.target,
              record.attributeName ?? "",
              record.attributeNamespace,
            );
            if (record.attributeName === "style") {
              facade?.synchronizeStyleAttribute(record.target);
            }
            if (
              record.target instanceof window.HTMLStyleElement &&
              record.target !== markup?.inlineStyleSheet
            ) {
              stylesWithAttributeChanges.add(record.target);
            } else if (record.target instanceof window.HTMLLinkElement) {
              linksWithAttributeChanges.add(record.target);
            }
          }
        }
        if (baseElementsChanged) {
          updateDocumentBaseURL();
        }
        for (const style of removedStyles) {
          if (!isConnectedToRealm(style)) {
            invalidateDynamicStyle(style);
          }
        }
        for (const link of removedLinks) {
          if (!isConnectedToRealm(link)) {
            invalidateDynamicLink(link);
          }
        }
        for (const style of stylesConnectedWithoutFacade) {
          scheduleConnectedDynamicStyle(style);
        }
        for (const link of linksConnectedWithoutFacade) {
          scheduleDynamicLink(link, true);
        }
        for (const style of stylesWithContentChanges) {
          scheduleDynamicStyleContent(style);
        }
        for (const style of stylesWithAttributeChanges) {
          scheduleDynamicStyleAttributes(style);
        }
        for (const link of linksWithAttributeChanges) {
          scheduleDynamicLink(link);
        }
      },
    );
    mutationObserver.observe(markup.html, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        "action",
        "cite",
        "data",
        "disabled",
        "formaction",
        "href",
        "media",
        "poster",
        "rel",
        "src",
        "srcset",
        "style",
      ],
    });
    bootstrapDisposers.push(() => mutationObserver.disconnect());

    const nativeFormSubmit = window.HTMLFormElement.prototype.submit;
    const formSubmission = (form: HTMLFormElement, submitter: HTMLElement | null) => {
      const action = submitter !== null &&
          "formAction" in submitter &&
          submitter.hasAttribute("formaction")
        ? String(submitter.formAction)
        : form.action;
      const method = (submitter !== null &&
          "formMethod" in submitter &&
          submitter.hasAttribute("formmethod")
        ? String(submitter.formMethod)
        : form.method).toLowerCase();
      const target = (submitter !== null &&
          "formTarget" in submitter &&
          submitter.hasAttribute("formtarget")
        ? String(submitter.formTarget)
        : form.hasAttribute("target")
        ? form.target
        : getDocumentBaseTarget()).toLowerCase();
      const targetURL = new URL(action || currentURL, currentURL);
      if (method === "get") {
        const parameters = new window.URLSearchParams();
        const entries = new window.FormData(form, submitter as HTMLButtonElement | null);
        for (const [name, value] of entries) {
          parameters.append(name, typeof value === "string" ? value : value.name);
        }
        targetURL.search = parameters.toString();
      }

      const detail: VFrameNavigateEventDetail = {
        from: currentURL,
        to: targetURL.href,
        kind: "form",
        state: null,
      };
      if (target === "_blank") {
        const allowed = options.onNavigate(detail);
        if (allowed && method === "get") {
          nativeWindowOpen(targetURL.href, "_blank", "noopener");
        } else if (allowed) {
          options.onError({
            phase: "navigation",
            url: targetURL.href,
            error: new window.DOMException(
              `v-frame cannot submit ${method.toUpperCase()} form ${targetURL.href} to a new browsing context`,
              "NotSupportedError",
            ),
          });
        }
        return;
      }

      if (
        (target !== "" && target !== "_self") ||
        (targetURL.protocol !== "http:" && targetURL.protocol !== "https:")
      ) {
        options.onNavigate(detail);
        return;
      }

      if (method === "get") {
        options.onShellNavigation(detail);
        return;
      }

      if (options.onNavigate(detail)) {
        options.onError({
          phase: "navigation",
          url: targetURL.href,
          error: new window.DOMException(
            `v-frame cannot submit ${method.toUpperCase()} form ${targetURL.href}; only same-context GET navigation is supported`,
            "NotSupportedError",
          ),
        });
      }
    };

    const anchorFromEvent = (event: Event) =>
      event
        .composedPath()
        .find(
          (candidate): candidate is HTMLAnchorElement | HTMLAreaElement | SVGAElement =>
            candidate instanceof window.Element &&
            (candidate.localName === "a" || candidate.localName === "area") &&
            (candidate.hasAttribute("href") ||
              candidate.hasAttributeNS("http://www.w3.org/1999/xlink", "href")),
        );

    const scrollToFragment = (targetURL: URL): void => {
      const encodedIdentifier = targetURL.hash.slice(1);
      let identifier = encodedIdentifier;
      try {
        identifier = decodeURIComponent(encodedIdentifier);
      } catch {
        // Malformed escapes remain literal, matching URL fragment storage.
      }
      if (identifier === "") {
        options.host.scrollTo(0, 0);
        return;
      }
      const target = document.getElementById(identifier) ??
        Array.from(document.anchors).find(
          (anchor) => anchor.getAttribute("name") === identifier,
        );
      target?.scrollIntoView();
    };

    const navigateFromLink = (
      event: MouseEvent,
      anchor: HTMLAnchorElement | HTMLAreaElement | SVGAElement,
    ) => {
      const href = anchor instanceof window.SVGAElement
        ? anchor.getAttribute("href") ??
          anchor.getAttributeNS("http://www.w3.org/1999/xlink", "href") ??
          ""
        : anchor.href;
      const targetURL = new URL(href || currentURL, getDocumentBaseURL());
      const target = anchor.hasAttribute("target")
        ? (anchor.getAttribute("target") ?? "").toLowerCase()
        : getDocumentBaseTarget();
      const opensNewContext = event.type === "auxclick" ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey;
      if (opensNewContext || target === "_blank") {
        if (
          options.onNavigate({
            from: currentURL,
            to: targetURL.href,
            kind: "link",
            state: null,
          })
        ) {
          nativeWindowOpen(targetURL.href, "_blank", "noopener");
        }
        return;
      }

      if (
        (target !== "" && target !== "_self") ||
        (targetURL.protocol !== "http:" && targetURL.protocol !== "https:")
      ) {
        options.onNavigate({
          from: currentURL,
          to: targetURL.href,
          kind: "link",
          state: null,
        });
        return;
      }

      const fragment = isSameDocumentFragment(currentURL, targetURL.href);
      if (!fragment) {
        const detail = {
          from: currentURL,
          to: targetURL.href,
          kind: "link",
          state: null,
        } satisfies VFrameNavigateEventDetail;
        options.onShellNavigation(detail);
        return;
      }
      if (!history.navigateFragment(targetURL.href)) {
        return;
      }
      if (fragment) {
        scrollToFragment(targetURL);
      }
    };

    const scheduledNavigationEvents = new WeakSet<Event>();
    const suppressLinkDefault = (event: Event) => {
      const hostWindow = options.host.ownerDocument.defaultView;
      if (!(event instanceof hostWindow!.MouseEvent)) {
        return;
      }
      if (
        (event.type === "click" && event.button !== 0) ||
        (event.type === "auxclick" && event.button !== 1)
      ) {
        return;
      }

      const anchor = anchorFromEvent(event);
      if (anchor === undefined) {
        return;
      }

      facade?.suppressEventDefault(event);
      if (scheduledNavigationEvents.has(event)) {
        return;
      }
      scheduledNavigationEvents.add(event);
      scheduleNavigationDefault(() => {
        if (disposed || facade?.wasEventDefaultPrevented(event) === true) {
          return;
        }
        navigateFromLink(event, anchor);
      }, 0);
    };
    const suppressSubmitDefault = (event: Event) => {
      const hostWindow = options.host.ownerDocument.defaultView;
      if (!(event instanceof hostWindow!.SubmitEvent)) {
        return;
      }

      const form = event.target as HTMLFormElement;
      const submitter = event.submitter as HTMLElement | null;
      const method = (
        submitter?.getAttribute("formmethod") ?? form.getAttribute("method") ?? ""
      ).toLowerCase();
      // A dialog submission navigates nowhere; its default action (closing
      // the dialog) must stay native.
      if (method === "dialog") {
        return;
      }

      facade?.suppressEventDefault(event);
      if (scheduledNavigationEvents.has(event)) {
        return;
      }
      scheduledNavigationEvents.add(event);
      scheduleNavigationDefault(() => {
        if (disposed || facade?.wasEventDefaultPrevented(event) === true) {
          return;
        }
        formSubmission(form, submitter);
      }, 0);
    };

    const installNavigation = () => {
      if (navigationInstalled) {
        return;
      }
      navigationInstalled = true;
      options.shadowRoot.addEventListener("click", suppressLinkDefault, true);
      options.shadowRoot.addEventListener("auxclick", suppressLinkDefault, true);
      options.shadowRoot.addEventListener("submit", suppressSubmitDefault, true);
      window.HTMLFormElement.prototype.submit = function submit(): void {
        formSubmission(this, null);
      };
    };

    Object.defineProperty(window, "open", {
      configurable: true,
      writable: true,
      value(url?: string | URL, target = "_blank", features?: string): Window | null {
        const targetURL = new URL(String(url ?? "about:blank"), getDocumentBaseURL());
        const normalizedTarget = target.toLowerCase();
        const detail: VFrameNavigateEventDetail = {
          from: currentURL,
          to: targetURL.href,
          kind: "window",
          state: null,
        };
        if (normalizedTarget === "_blank") {
          return options.onNavigate(detail)
            ? nativeWindowOpen(targetURL.href, target, features)
            : null;
        }
        if (
          (normalizedTarget !== "" && normalizedTarget !== "_self") ||
          (targetURL.protocol !== "http:" && targetURL.protocol !== "https:")
        ) {
          options.onNavigate(detail);
          return null;
        }
        // A same-document _self open is a fragment navigation, with the same
        // events and scroll-to-anchor behavior as a link click.
        const fragment = isSameDocumentFragment(currentURL, targetURL.href);
        if (!fragment) {
          const allowed = options.onShellNavigation(detail);
          return allowed ? window : null;
        }
        if (!history.navigateFragment(targetURL.href)) {
          return null;
        }
        if (fragment) {
          scrollToFragment(targetURL);
        }
        return window;
      },
    });

    const runtimeErrorURL = (filename: string): string => {
      if (filename === "") {
        return currentURL;
      }

      const executionDocumentURL = new URL(window.location.href);
      executionDocumentURL.hash = "";
      if (
        filename === executionDocumentURL.href ||
        filename.startsWith(`${executionDocumentURL.href}:`) ||
        filename.startsWith(`${executionDocumentURL.href} `)
      ) {
        return currentURL;
      }
      return filename;
    };
    const runtimeErrorListener = (event: ErrorEvent) => {
      if (scriptRunner?.claimsRuntimeError(event) === true) {
        return;
      }
      options.onError({
        phase: "runtime",
        url: runtimeErrorURL(event.filename),
        error: event.error ?? new Error(event.message),
      });
    };
    const rejectionListener = (event: PromiseRejectionEvent) => {
      options.onError({ phase: "runtime", url: currentURL, error: event.reason });
    };
    // Reloading or leaving the host page unloads every child realm too. The
    // host's beforeunload reaches us first, so only an independently loaded
    // child marker is promoted back to the host.
    const hostView = options.host.ownerDocument.defaultView;
    let hostUnloadUnderway = false;
    const hostBeforeUnloadListener = () => {
      hostUnloadUnderway = true;
      hostView?.setTimeout(() => {
        hostUnloadUnderway = false;
      }, 0);
    };
    const iframeNavigationListener = () => {
      if (hostUnloadUnderway) {
        return;
      }
      let targetURL: string;
      let markerPresent: boolean;
      try {
        targetURL = window.location.href;
        markerPresent = window.document.querySelector(
          `meta[name="${V_FRAME_REALM_MARKER}"][content="${V_FRAME_GATEWAY_VERSION}"]`,
        ) !== null;
      } catch (error) {
        reportFatal({
          phase: "navigation",
          url: currentURL,
          error: new window.DOMException(
            `v-frame native Location left the same-origin gateway route from ${currentURL}: ${String(error)}`,
            "SecurityError",
          ),
        });
        return;
      }
      if (!markerPresent) {
        reportFatal({
          phase: "navigation",
          url: targetURL,
          error: new Error(
            `v-frame route ${targetURL} did not return the gateway realm marker`,
          ),
        });
        return;
      }
      options.onNativeLocationNavigation({
        from: currentURL,
        to: targetURL,
        kind: "window",
        state: null,
      });
    };
    const trustedHashChangeListener = (event: HashChangeEvent) => {
      if (!event.isTrusted) {
        return;
      }

      event.stopImmediatePropagation();
      const nativeURL = new URL(event.newURL);
      const virtualURL = new URL(currentURL);
      virtualURL.hash = nativeURL.hash;
      if (nativeURL.hash === "" && event.newURL.endsWith("#")) {
        virtualURL.href += "#";
      }
      if (!options.onShellNavigation({
        from: currentURL,
        to: virtualURL.href,
        kind: "fragment",
        state: null,
      })) {
        history.restoreMirroredURL();
      }
    };
    const trustedPopStateListener = (event: PopStateEvent) => {
      if (event.isTrusted) {
        // The hidden iframe history only mirrors the virtual history. Exposing
        // its native event would deliver a second popstate to the sub-app.
        event.stopImmediatePropagation();
      }
    };

    hostView?.addEventListener("beforeunload", hostBeforeUnloadListener, true);
    bootstrapDisposers.push(() => {
      hostView?.removeEventListener("beforeunload", hostBeforeUnloadListener, true);
    });
    window.addEventListener("error", runtimeErrorListener);
    window.addEventListener("unhandledrejection", rejectionListener);
    window.addEventListener("popstate", trustedPopStateListener);
    window.addEventListener("hashchange", trustedHashChangeListener);
    iframe.addEventListener("load", iframeNavigationListener);

    let adoptedMarkupRevealed = options.markup.kind !== "adopted";
    const revealAdoptedMarkup = (): void => {
      if (adoptedMarkupRevealed || disposed || options.signal.aborted) {
        return;
      }
      adoptedMarkupRevealed = true;
      for (const node of options.markup.kind === "adopted"
        ? options.markup.previewNodes
        : []) {
        node.parentNode?.removeChild(node);
      }
      restoreStagingStyles();
    };

    const runtime: VFrameRealm = {
      window,
      async executeInitialScripts() {
        installNavigation();
        await scriptRunner?.executeInitial();
      },
      reveal() {
        if (disposed || options.signal.aborted) {
          throw abortError();
        }
        // The staged live tree is pixel-identical to the preview, so a
        // synchronous swap never repaints. Masking it with a scoped View
        // Transition would itself flicker: Chromium pixel-snaps transition
        // snapshots, visibly shifting fractionally positioned frames.
        revealAdoptedMarkup();
      },
      dispose() {
        if (disposed) {
          return;
        }
        disposed = true;
        options.signal.removeEventListener("abort", runtime.dispose);
        mutationObserver.disconnect();
        options.shadowRoot.removeEventListener("click", suppressLinkDefault, true);
        options.shadowRoot.removeEventListener("auxclick", suppressLinkDefault, true);
        options.shadowRoot.removeEventListener("submit", suppressSubmitDefault, true);
        hostView?.removeEventListener("beforeunload", hostBeforeUnloadListener, true);
        window.removeEventListener("error", runtimeErrorListener);
        window.removeEventListener("unhandledrejection", rejectionListener);
        window.removeEventListener("popstate", trustedPopStateListener);
        window.removeEventListener("hashchange", trustedHashChangeListener);
        iframe?.removeEventListener("load", iframeNavigationListener);
        window.HTMLFormElement.prototype.submit = nativeFormSubmit;
        history.dispose();
        viewport.dispose();
        windowEventDispose();
        networkDispose();
        iframe?.remove();
        facade?.dispose();
        markup?.html.remove();
        markup?.inlineStyleSheet.remove();
        restoreStagingStyles();
        internalStyles.dispose();
      },
    };
    options.signal.addEventListener("abort", runtime.dispose, { once: true });
    return runtime;
  } catch (error) {
    for (const disposeBootstrapResource of bootstrapDisposers.reverse()) {
      disposeBootstrapResource();
    }
    markup?.html.remove();
    markup?.inlineStyleSheet.remove();
    iframe?.remove();
    restoreStagingStyles();
    internalStyles.dispose();
    throw error;
  }
}
