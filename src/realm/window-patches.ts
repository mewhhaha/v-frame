// The patches that make the hidden realm's `window` behave like the top-level
// window of the host page — viewport metrics, scrolling, the event bridge —
// plus the two constructed stylesheets v-frame owns on the host shadow root.

import {
  ListenerRegistry,
  captureAbortSignalMethods,
  listenerCapture,
  listenerPassive,
} from "../listener-registry.js";
import type { DocumentFacade } from "../facade/index.js";
import type { VFrameWindow } from "../types.js";

const INTERNAL_CSS = `
:host {
  contain: layout;
  display: block;
  position: relative;
  overflow: auto;
}
:host([hidden]:not([hidden="until-found" i])) {
  display: none !important;
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
:host(${STAGING_SELECTOR_SPECIFICITY}:not([hidden]:not([hidden="until-found" i]))) {
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

function renderedBy(guestRoot: Element, target: Node, hostWindow: VFrameWindow): boolean {
  const { contains, getRootNode } = hostWindow.Node.prototype;
  let node = target;
  while (!contains.call(guestRoot, node)) {
    const root = getRootNode.call(node);
    if (!("host" in root)) return false;
    node = (root as ShadowRoot).host;
  }
  return true;
}

export function installStagedTopLayer(
  window: VFrameWindow,
  root: HTMLElement,
  shadowRoot: ShadowRoot,
  isActive: () => boolean,
  getFacade: () => DocumentFacade | null,
) {
  const prototype = window.HTMLDialogElement.prototype;
  const nativeShow = prototype.show;
  const nativeShowModal = prototype.showModal;
  const htmlPrototype = window.HTMLElement.prototype;
  const nativeShowPopover = htmlPrototype.showPopover;
  const nativeHidePopover = htmlPrototype.hidePopover;
  const nativeTogglePopover = htmlPrototype.togglePopover;
  const popoverAttribute = Object.getOwnPropertyDescriptor(
    htmlPrototype,
    "popover",
  )!.get!;
  const nativeAddEventListener = window.EventTarget.prototype.addEventListener;
  const pending = new Map<HTMLElement, "modal" | ShowPopoverOptions>();
  const hostWindow = shadowRoot.ownerDocument.defaultView!;
  let installed = true;
  const lifetime = new AbortController();
  const restores: Array<() => void> = [];

  const patch = <T extends object, K extends keyof T>(
    target: T,
    key: K,
    replacement: T[K],
  ): void => {
    const original = target[key];
    target[key] = replacement;
    restores.push(() => {
      if (Object.getOwnPropertyDescriptor(target, key)?.value === replacement) {
        target[key] = original;
      }
    });
  };
  const showModal = function showModal(this: HTMLDialogElement) {
    if (this.open && pending.get(this) === "modal") return;
    if (!installed || this.open || !this.isConnected || this.matches(":popover-open")) {
      nativeShowModal.call(this);
      return;
    }
    // A native modal would make the visible document inert, even if the
    // dialog itself is hidden. Keep its open state until this guest is revealed.
    this.open = true;
    pending.set(this, "modal");
  };
  patch(prototype, "showModal", showModal);
  patch(prototype, "show", function show(this: HTMLDialogElement) {
    if (this.open && pending.get(this) === "modal") {
      throw new window.DOMException("The dialog is already modal", "InvalidStateError");
    }
    pending.delete(this);
    nativeShow.call(this);
  });

  const canStagePopover = (element: HTMLElement) =>
    installed &&
    element.isConnected &&
    popoverAttribute.call(element) !== null &&
    !(element.localName === "dialog" && (element as HTMLDialogElement).open);
  const popoverSource = (options: ShowPopoverOptions | undefined) => {
    if (options != null && typeof options !== "object" && typeof options !== "function") {
      throw new window.TypeError("Popover options must be an object");
    }
    const source = options?.source;
    if (source !== undefined) popoverAttribute.call(source);
    return source;
  };
  const queuePopover = (element: HTMLElement, source?: HTMLElement) => {
    if (!pending.has(element)) pending.set(element, source ? { source } : {});
  };
  patch(
    htmlPrototype,
    "showPopover",
    function showPopover(this: HTMLElement, options?: ShowPopoverOptions) {
      if (canStagePopover(this) && pending.get(this) !== "modal") {
        queuePopover(this, popoverSource(options));
      } else nativeShowPopover.call(this, options);
    },
  );
  patch(htmlPrototype, "hidePopover", function hidePopover(this: HTMLElement) {
    if (canStagePopover(this) && pending.get(this) !== "modal") {
      pending.delete(this);
    } else nativeHidePopover.call(this);
  });
  patch(
    htmlPrototype,
    "togglePopover",
    function togglePopover(this: HTMLElement, options?: boolean | TogglePopoverOptions) {
      if (!canStagePopover(this) || pending.get(this) === "modal") {
        return nativeTogglePopover.call(this, options);
      }
      let force = pending.has(this) === false;
      let source: HTMLElement | undefined;
      if (typeof options === "boolean") force = options;
      else {
        const supplied = options?.force;
        if (supplied !== undefined) force = Boolean(supplied);
        source = popoverSource(options);
      }
      if (force) {
        queuePopover(this, source);
      } else pending.delete(this);
      return force;
    },
  );

  const capture = { capture: true, signal: lifetime.signal };
  const deferDefault = (event: Event, target: HTMLElement, action: () => void): void => {
    const facade = getFacade();
    if (!facade) return;
    // A listener on a foreign DOM wrapper can still call the native method.
    // Distinguish its cancellation from the runtime's own suppression.
    let canceled = facade.wasEventDefaultPrevented(event);
    const prevent = event.preventDefault;
    const previous = Object.getOwnPropertyDescriptor(event, "preventDefault");
    const cancel = () => {
      canceled = true;
      prevent.call(event);
    };
    if (Object.isExtensible(event) && previous === undefined)
      event.preventDefault = cancel;
    facade.suppressEventDefault(event);
    queueMicrotask(() => {
      if (event.preventDefault === cancel)
        Reflect.deleteProperty(event, "preventDefault");
      if (
        installed &&
        !canceled &&
        !facade.wasEventDefaultPrevented(event) &&
        target.isConnected &&
        renderedBy(root, target, hostWindow)
      )
        action();
    });
  };
  // Declarative invokers call the native algorithms directly. Capture the
  // command's intent, then wait for the native opening. A canceled command
  // never produces a beforetoggle, including listeners on foreign-realm nodes.
  const modalCommands = new WeakSet<HTMLElement>();
  const commandListener: EventListener = (event) => {
    const command = event as CommandEvent;
    const target = event.target as HTMLElement | null;
    if (!event.isTrusted || !event.cancelable) return;
    if (
      command.command === "show-modal" &&
      target?.localName === "dialog" &&
      renderedBy(root, target, hostWindow)
    ) {
      modalCommands.add(target);
      queueMicrotask(() => modalCommands.delete(target));
    }
  };
  const openingListener: EventListener = (event) => {
    const toggle = event as ToggleEvent;
    const target = event.target as HTMLElement | null;
    if (
      !event.cancelable ||
      !event.isTrusted ||
      toggle.newState !== "open" ||
      !target ||
      !renderedBy(root, target, hostWindow)
    )
      return;
    if (modalCommands.delete(target)) {
      deferDefault(event, target, () => showModal.call(target as HTMLDialogElement));
    } else if (target.popover != null) {
      deferDefault(event, target, () =>
        queuePopover(target, (toggle.source ?? undefined) as HTMLElement | undefined),
      );
    }
  };
  const observed = new WeakSet<ShadowRoot>();
  const observe = (boundary: ShadowRoot): void => {
    if (!installed || observed.has(boundary)) return;
    observed.add(boundary);
    nativeAddEventListener.call(boundary, "command", commandListener, capture);
    nativeAddEventListener.call(boundary, "beforetoggle", openingListener, capture);
    if (boundary !== shadowRoot) {
      for (const element of boundary.querySelectorAll("*")) {
        if (element.shadowRoot) observe(element.shadowRoot);
      }
    }
  };
  observe(shadowRoot);

  const dispose = () => {
    if (!installed) return;
    installed = false;
    lifetime.abort();
    pending.clear();
    for (const restore of restores) restore();
  };
  return {
    dispose,
    observe,
    reveal() {
      const requests = [...pending];
      dispose();
      for (const [element, request] of requests) {
        if (!isActive()) break;
        if (!element.isConnected || !renderedBy(root, element, hostWindow)) continue;
        if (request === "modal") {
          const dialog = element as HTMLDialogElement;
          if (dialog.open) {
            dialog.open = false;
            nativeShowModal.call(dialog);
          }
        } else if (element.popover !== null) {
          nativeShowPopover.call(element, request);
        }
      }
    },
  };
}

export function installWindowEventBridge(
  window: VFrameWindow,
  virtualEventTarget: ShadowRoot,
  guestRoot: Element,
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
  const shadowListeners = new WeakMap<EventListener, EventListener>();

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
      // Two guests can share this shadow root during replacement. Filter
      // before invoking the registry wrapper, which consumes once listeners.
      const shadowListener: EventListener = (event) => {
        if (event.composedPath().includes(guestRoot)) wrapper(event);
      };
      shadowListeners.set(wrapper, shadowListener);
      nativeAddEventListener(type, wrapper, listenerOptions);
      virtualEventTarget.addEventListener(type, shadowListener, listenerOptions);
    },
    removeFromTargets: (type, wrapper, capture) => {
      nativeRemoveEventListener(type, wrapper, capture);
      const shadowListener = shadowListeners.get(wrapper);
      if (shadowListener)
        virtualEventTarget.removeEventListener(type, shadowListener, capture);
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
  guestRoot: Element,
  isStaged: () => boolean,
  preserveScroll: boolean,
  getSelection: () => Selection | null,
  dispatchScrollEvent: () => void,
) {
  const view = host.ownerDocument.defaultView;
  if (view === null || typeof view.matchMedia !== "function") {
    throw new Error("v-frame requires a host window with matchMedia support");
  }
  const hostWindow = view;

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

  // The rendered guest owns the host's scroll box. A second guest booting
  // behind it records its own requests until it takes over that box.
  let stagedLeft = 0;
  let stagedTop = 0;
  const scrollRequests: Array<() => void> = [];
  const listenerLifetime = new AbortController();
  if (preserveScroll) {
    stagedLeft = host.scrollLeft;
    stagedTop = host.scrollTop;
  }
  const scrollCoordinate = (value: number): number => {
    const number = +value;
    if (Number.isFinite(number)) return number;
    return 0;
  };
  const stageScroll = (
    left: number | undefined,
    top: number | undefined,
    native: typeof host.scrollTo,
    relative = false,
  ): void => {
    const position: ScrollToOptions = { behavior: "instant" };
    if (left !== undefined) {
      position.left = scrollCoordinate(left);
      if (!relative) stagedLeft = 0;
      stagedLeft += position.left;
    }
    if (top !== undefined) {
      position.top = scrollCoordinate(top);
      if (!relative) stagedTop = 0;
      stagedTop += position.top;
    }
    if (left !== undefined || top !== undefined) {
      scrollRequests.push(() => Reflect.apply(native, host, [position]));
    }
  };
  const scrollMethod =
    (native: typeof host.scrollTo, relative: boolean) =>
    (...args: unknown[]): void => {
      if (listenerLifetime.signal.aborted) return;
      if (!isStaged()) {
        Reflect.apply(native, host, args);
        return;
      }
      let left: number | undefined;
      let top: number | undefined;
      if (args.length >= 2) {
        left = args[0] as number;
        top = args[1] as number;
      } else {
        const init = args[0] as ScrollToOptions | null | undefined;
        if (init != null && typeof init !== "object" && typeof init !== "function") {
          throw new window.TypeError("Scroll options must be an object");
        }
        const behavior = init?.behavior;
        if (
          behavior !== undefined &&
          !["auto", "instant", "smooth"].includes(`${behavior}`)
        ) {
          throw new window.TypeError("Invalid scroll behavior");
        }
        left = init?.left;
        top = init?.top;
      }
      stageScroll(left, top, native, relative);
    };
  const scroll = {
    get scrollLeft() {
      return isStaged() ? stagedLeft : host.scrollLeft;
    },
    set scrollLeft(value: number) {
      if (isStaged()) {
        stageScroll(value, undefined, host.scrollTo);
      } else host.scrollLeft = value;
    },
    get scrollTop() {
      return isStaged() ? stagedTop : host.scrollTop;
    },
    set scrollTop(value: number) {
      if (isStaged()) {
        stageScroll(undefined, value, host.scrollTo);
      } else host.scrollTop = value;
    },
    scrollTo: scrollMethod(host.scrollTo, false),
    scrollBy: scrollMethod(host.scrollBy, true),
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
  patch("scrollX", { get: () => scroll.scrollLeft });
  patch("scrollY", { get: () => scroll.scrollTop });
  patch("pageXOffset", { get: () => scroll.scrollLeft });
  patch("pageYOffset", { get: () => scroll.scrollTop });
  patch("scrollTo", { writable: true, value: scroll.scrollTo });
  patch("scroll", { writable: true, value: scroll.scrollTo });
  patch("scrollBy", { writable: true, value: scroll.scrollBy });
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

  const elementPrototype = window.Element.prototype;
  const nativeScrollIntoView = elementPrototype.scrollIntoView;
  function scrollIntoView(this: Element, options?: boolean | ScrollIntoViewOptions) {
    if (listenerLifetime.signal.aborted) return;
    if (!isStaged() || !this.isConnected) {
      nativeScrollIntoView.call(this, options);
      return;
    }
    let requested = options;
    if (options && typeof options === "object") {
      const input = options as ScrollIntoViewOptions & { container?: string };
      const converted: Record<string, string> = {};
      const alignments = ["start", "center", "end", "nearest"];
      const supported = {
        behavior: ["auto", "instant", "smooth"],
        block: alignments,
        container: ["all", "nearest"],
        inline: alignments,
      };
      for (const name of Object.keys(supported) as Array<keyof typeof supported>) {
        const value = input[name];
        if (value === undefined) continue;
        const option = `${value}`;
        if (!supported[name].includes(option)) {
          throw new window.TypeError(`Invalid scrollIntoView ${name}`);
        }
        converted[name] = option;
      }
      requested = converted;
    }
    scrollRequests.push(() => {
      if (this.isConnected && renderedBy(guestRoot, this, hostWindow)) {
        nativeScrollIntoView.call(this, requested);
      }
    });
  }
  if (isStaged()) elementPrototype.scrollIntoView = scrollIntoView;

  const resizeListener = () => {
    window.dispatchEvent(new window.Event("resize"));
  };
  const scrollListener = () => {
    if (!isStaged()) dispatchScrollEvent();
  };
  hostWindow.addEventListener("resize", resizeListener, {
    signal: listenerLifetime.signal,
  });
  host.addEventListener("scroll", scrollListener, {
    passive: true,
    signal: listenerLifetime.signal,
  });

  return {
    scroll,
    revealScroll() {
      if (!preserveScroll) {
        const topLeft = { left: 0, top: 0, behavior: "instant" } as const;
        host.scrollTo(topLeft);
        const left = host.scrollLeft;
        const top = host.scrollTop;
        if (left || top) {
          // After the staging grid is removed WebKit can treat zero as already
          // applied. Change the scroll position, then reset it in the same task.
          host.scrollTo({
            left: Math.sign(left),
            top: Math.sign(top),
            behavior: "instant",
          });
          host.scrollTo(topLeft);
        }
      }
      for (const request of scrollRequests.splice(0)) {
        if (listenerLifetime.signal.aborted) break;
        request();
      }
    },
    dispose() {
      listenerLifetime.abort();
      for (const id of animationFrames) hostWindow.cancelAnimationFrame(id);
      animationFrames.clear();
      scrollRequests.length = 0;
      if (elementPrototype.scrollIntoView === scrollIntoView) {
        elementPrototype.scrollIntoView = nativeScrollIntoView;
      }
      restore();
    },
  };
}
