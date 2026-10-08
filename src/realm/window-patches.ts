// The patches that make the hidden realm's `window` behave like the top-level
// window of the host page — viewport metrics, scrolling, the event bridge —
// plus the two constructed stylesheets v-frame owns on the host shadow root.

import {
  ListenerRegistry,
  captureAbortSignalMethods,
  listenerCapture,
  listenerPassive,
} from "../listener-registry.js";
import type { VFrameWindow } from "../types.js";

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

interface WindowEventHandler {
  listener: EventListener;
  wrapper: EventListener;
}

// Handler properties whose events are fired at the realm window itself and are
// not part of the guest's logical event path. Every other `on*` accessor the
// window exposes is bridged like addEventListener is, so the set follows the
// browser instead of a hand-kept list. `resize` and `scroll` are deliberately
// absent: the viewport patches re-dispatch them from the host.
const NATIVE_WINDOW_EVENT_HANDLER_TYPES = new Set([
  "afterprint",
  "appinstalled",
  "beforeinstallprompt",
  "beforeprint",
  "beforeunload",
  "devicemotion",
  "deviceorientation",
  "deviceorientationabsolute",
  "error",
  "gamepadconnected",
  "gamepaddisconnected",
  "hashchange",
  "languagechange",
  "load",
  "message",
  "messageerror",
  "offline",
  "online",
  "orientationchange",
  "pagehide",
  "pagereveal",
  "pageshow",
  "pageswap",
  "popstate",
  "rejectionhandled",
  "storage",
  "unhandledrejection",
  "unload",
]);

interface InternalStyles {
  updateTopLayerViewport(x: number, y: number): void;
  dispose(): void;
}

export function installInternalStyles(shadowRoot: ShadowRoot): InternalStyles {
  // Without these rules v-html/v-body are inline and v-head is visible, so a
  // guest would render wrongly with no error. Constructable stylesheets are a
  // documented requirement; fail like installStagingStyles does.
  const view = shadowRoot.ownerDocument.defaultView;
  if (view === null || typeof view.CSSStyleSheet !== "function") {
    throw new Error("v-frame requires constructable stylesheet support");
  }

  const sheet = new view.CSSStyleSheet();
  sheet.replaceSync(INTERNAL_CSS);
  shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
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
}

export function installStagingStyles(shadowRoot: ShadowRoot): () => void {
  const view = shadowRoot.ownerDocument.defaultView;
  if (view === null || typeof view.CSSStyleSheet !== "function") {
    throw new Error("Cannot stage v-frame markup without constructed stylesheet support");
  }

  const liveMarkupPosition =
    Array.from(shadowRoot.children).filter((element) => element.localName === "v-html")
      .length + 1;
  const liveMarkupSelector = `:host > v-html:nth-of-type(${liveMarkupPosition})${STAGING_SELECTOR_SPECIFICITY}`;
  const sheet = new view.CSSStyleSheet();
  sheet.replaceSync(`
:host(${STAGING_SELECTOR_SPECIFICITY}) {
  display: grid !important;
  overflow-anchor: none !important;
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
  const host = shadowRoot.host;
  const left = host.scrollLeft;
  const top = host.scrollTop;
  shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet];
  // Changing the scroll container to grid can adjust its existing offset in
  // WebKit. Preserve the offset synchronously; overflow-anchor above prevents
  // a later anchor adjustment from moving the already-painted preview.
  host.scrollTo({ left, top, behavior: "instant" });
  return () => {
    const left = host.scrollLeft;
    const top = host.scrollTop;
    shadowRoot.adoptedStyleSheets = shadowRoot.adoptedStyleSheets.filter(
      (candidate) => candidate !== sheet,
    );
    host.scrollTo({ left, top, behavior: "instant" });
  };
}

export function installWindowEventBridge(
  window: VFrameWindow,
  virtualEventTarget: ShadowRoot,
  eventForListener: (
    event: Event,
    currentTarget: EventTarget,
    eventPhase?: number,
    passive?: boolean,
  ) => Event,
  finishEventListener: (event: Event) => void,
): () => void {
  const nativeAddEventListener = window.addEventListener.bind(window);
  const nativeRemoveEventListener = window.removeEventListener.bind(window);
  const eventHandlers = new Map<string, WindowEventHandler>();
  const patchedDescriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();

  const patch = (name: PropertyKey, descriptor: PropertyDescriptor) => {
    patchedDescriptors.set(name, Object.getOwnPropertyDescriptor(window, name));
    Object.defineProperty(window, name, { configurable: true, ...descriptor });
  };

  const bridgedWindowListener = (
    listener: EventListenerOrEventListenerObject,
    _capture: boolean,
    options: boolean | AddEventListenerOptions | undefined,
    type: string,
  ): EventListener => {
    const passive = listenerPassive(options, type, true);
    return (event) => {
      const listenerEvent = eventForListener(event, window, undefined, passive);
      try {
        if (typeof listener === "function") listener.call(window, listenerEvent);
        else listener.handleEvent(listenerEvent);
      } finally {
        finishEventListener(event);
      }
    };
  };

  // Every window listener is mirrored onto the shadow root so guest events that
  // never reach the realm window still walk the logical window path. `once` is
  // deliberately withheld from both targets: the record has to be unwound from
  // the pair together, which is the registry's job, not the native one's.
  const windowListeners = new ListenerRegistry({
    abortSignal: captureAbortSignalMethods(window),
    createWrapper: bridgedWindowListener,
    addToTargets: (type, wrapper, options) => {
      const listenerOptions = {
        capture: listenerCapture(options),
        passive: listenerPassive(options, type, true),
      };
      nativeAddEventListener(type, wrapper, listenerOptions);
      virtualEventTarget.addEventListener(type, wrapper, listenerOptions);
    },
    removeFromTargets: (type, wrapper, capture) => {
      nativeRemoveEventListener(type, wrapper, capture);
      virtualEventTarget.removeEventListener(type, wrapper, capture);
    },
  });

  patch("addEventListener", {
    writable: true,
    value(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      windowListeners.add(type, listener, options);
    },
  });
  patch("removeEventListener", {
    writable: true,
    value(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ) {
      windowListeners.remove(type, listener, options);
    },
  });

  const discoveredHandlerProperties = new Map<string, PropertyDescriptor>();
  let prototype: object | null = window;
  while (prototype !== null) {
    for (const name of Object.getOwnPropertyNames(prototype)) {
      if (
        discoveredHandlerProperties.has(name) ||
        !name.startsWith("on") ||
        NATIVE_WINDOW_EVENT_HANDLER_TYPES.has(name.slice(2))
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
        if (typeof value !== "function") {
          if (previous !== undefined) {
            window.removeEventListener(eventType, previous.wrapper);
            eventHandlers.delete(eventType);
          }
          return;
        }
        // Replacing a live handler keeps its place among the listeners: the one
        // wrapper reads the current value, as the element handlers do.
        if (previous !== undefined) {
          previous.listener = value as EventListener;
          return;
        }
        const handler: WindowEventHandler = {
          listener: value as EventListener,
          wrapper: (event) => {
            const current = eventHandlers.get(eventType)?.listener;
            if (current === undefined) return;
            if (
              (current as (this: VFrameWindow, event: Event) => unknown).call(
                window,
                event,
              ) === false
            ) {
              event.preventDefault();
            }
          },
        };
        eventHandlers.set(eventType, handler);
        window.addEventListener(eventType, handler.wrapper);
      },
    });
  }

  return () => {
    windowListeners.dispose();
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

export function installViewportPatches(
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
  const restore = (): void => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor === undefined) {
        delete (window as unknown as Record<PropertyKey, unknown>)[name];
      } else {
        Object.defineProperty(window, name, descriptor);
      }
    }
    descriptors.clear();
  };
  const patch = (name: PropertyKey, descriptor: PropertyDescriptor) => {
    const original = Object.getOwnPropertyDescriptor(window, name);
    try {
      Object.defineProperty(window, name, { configurable: true, ...descriptor });
    } catch (error) {
      // A property left unpatched would keep reporting the hidden 1px iframe,
      // so the failure aborts bootstrap; undo what already landed first.
      restore();
      throw error;
    }
    descriptors.set(name, original);
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

  // WebKit suspends rAF in a zero-sized execution iframe. Rendering belongs
  // to the host, but timestamps must still use the guest's performance origin.
  const animationFrames = new Set<number>();
  const timeOffset = hostWindow.performance.timeOrigin - window.performance.timeOrigin;
  patch("requestAnimationFrame", {
    writable: true,
    value(callback: FrameRequestCallback) {
      if (typeof callback !== "function")
        throw new window.TypeError("Callback must be a function");
      const id = hostWindow.requestAnimationFrame((time) => {
        animationFrames.delete(id);
        if (listenerLifetime.signal.aborted) return;
        try {
          callback.call(window, time + timeOffset);
        } catch (error) {
          window.dispatchEvent(
            new window.ErrorEvent("error", {
              error,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
      animationFrames.add(id);
      return id;
    },
  });
  patch("cancelAnimationFrame", {
    writable: true,
    value(id: number) {
      if (animationFrames.delete(Number(id))) hostWindow.cancelAnimationFrame(Number(id));
    },
  });

  const resizeListener = () => {
    window.dispatchEvent(new window.Event("resize"));
  };
  const scrollListener = () => {
    dispatchScrollEvent();
  };
  const listenerLifetime = new AbortController();
  hostWindow.addEventListener("resize", resizeListener, {
    signal: listenerLifetime.signal,
  });
  host.addEventListener("scroll", scrollListener, {
    passive: true,
    signal: listenerLifetime.signal,
  });

  return {
    dispose() {
      listenerLifetime.abort();
      for (const id of animationFrames) hostWindow.cancelAnimationFrame(id);
      animationFrames.clear();
      restore();
    },
  };
}
