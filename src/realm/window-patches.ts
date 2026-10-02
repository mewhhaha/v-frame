// The patches that make the hidden realm's `window` behave like the top-level
// window of the host page — viewport metrics, scrolling, the event bridge —
// plus the two constructed stylesheets v-frame owns on the host shadow root.

import {
  ListenerRegistry,
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

export interface InternalStyles {
  updateTopLayerViewport(x: number, y: number): void;
  dispose(): void;
}

export function installInternalStyles(shadowRoot: ShadowRoot): InternalStyles {
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

export function installWindowEventBridge(
  window: VFrameWindow,
  virtualEventTarget: ShadowRoot,
  eventForListener: (
    event: Event,
    currentTarget: EventTarget,
    eventPhase?: number,
    passive?: boolean,
  ) => Event,
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
      if (typeof listener === "function") {
        listener.call(window, listenerEvent);
      } else {
        listener.handleEvent(listenerEvent);
      }
    };
  };

  // Every window listener is mirrored onto the shadow root so guest events that
  // never reach the realm window still walk the logical window path. `once` is
  // deliberately withheld from both targets: the record has to be unwound from
  // the pair together, which is the registry's job, not the native one's.
  const windowListeners = new ListenerRegistry({
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
