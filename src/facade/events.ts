// Guest listeners see a document that does not exist: their events really
// travel the host tree, so every listener the guest registers is wrapped, and
// the event it receives is a proxy that reports the virtual target, phase and
// composed path. Document listeners are relayed from the shell root, inline
// event attributes are compiled in the realm before being installed as
// listeners, and the shadow boundary stops guest events from leaking out.

import { EnumerableWeakSet } from "../enumerable-weak.js";
import {
  ListenerRegistry,
  captureAbortSignalMethods,
  listenerPassive,
} from "../listener-registry.js";
import type { FacadeContext } from "./context.js";

export const DOCUMENT_EVENT_HANDLER_NAMES = [
  "click",
  "dblclick",
  "input",
  "change",
  "submit",
  "keydown",
  "keyup",
  "keypress",
  "pointerdown",
  "pointerup",
  "pointermove",
  "mousedown",
  "mouseup",
  "mousemove",
  "touchstart",
  "touchend",
  "wheel",
  "focus",
  "blur",
  "focusin",
  "focusout",
  "selectionchange",
  "readystatechange",
] as const;

export interface EventFacade {
  eventAttributeName(element: Element, attributeName: string): string | null;
  eventForListener(
    event: Event,
    currentTarget: EventTarget,
    eventPhase?: number,
    passive?: boolean,
  ): Event;
  finishEventListener(event: Event): void;
  setElementHandler(
    element: Element,
    eventName: string,
    listener: EventListener | null,
  ): void;
  compileEventAttribute(element: Element, attributeName: string, source: string): void;
  ensureRootEventRelay(type: string): void;
  documentListeners: ListenerRegistry;
  suppressEventDefault(event: Event): void;
  suppressNativeLinkDefault(event: Event, anchor: Element): void;
  wasEventDefaultPrevented(event: Event): boolean;
  installHandlerProperties(): void;
  installRelays(): void;
  installPatches(): void;
  dispose(): void;
}

export function installEventFacade(context: FacadeContext): EventFacade {
  const options = context.options;
  const {
    window,
    document,
    hostDocument,
    privateHead,
    eventTargetPrototype,
    nativeCreateElement,
    nativeAppendChild,
    nativeAddEventListener,
    nativeRemoveEventListener,
    nativeDispatchEvent,
    virtualNodes,
    logicalEventTargets,
    patch,
  } = context;
  let eventHandlerSequence = 0;
  const abortSignal = captureAbortSignalMethods(window);
  const eventPrototype = window.Event.prototype;
  const nativeDefaultPrevented = Object.getOwnPropertyDescriptor(
    eventPrototype,
    "defaultPrevented",
  )!.get!;
  const nativePreventDefault = eventPrototype.preventDefault;
  const nativeReturnValue = Object.getOwnPropertyDescriptor(
    eventPrototype,
    "returnValue",
  )!;
  const nativeRemoveAttributeNode = window.Element.prototype.removeAttributeNode;
  const nativeSetAttributeNodeNS = window.Element.prototype.setAttributeNodeNS;
  const nativeGetAttributeNodeNS = window.Element.prototype.getAttributeNodeNS;
  const queueMicrotask = hostDocument.defaultView!.queueMicrotask.bind(
    hostDocument.defaultView,
  );

  const elementHandlerValues = new WeakMap<Element, Map<string, EventListener | null>>();
  const elementHandlerWrappers = new WeakMap<Element, Map<string, EventListener>>();
  const virtualListeners = new WeakMap<EventTarget, ListenerRegistry>();
  // dispose() has to take the native listeners back off every target that still
  // has one, which is the only reason the targets are enumerable at all. An
  // element the guest has dropped does not need its listeners removed, so these
  // hold their targets weakly rather than pinning every row that ever carried an
  // onclick for the lifetime of the frame.
  const elementHandlerTargets = new EnumerableWeakSet<Element>();
  const virtualListenerTargets = new EnumerableWeakSet<EventTarget>();
  const mirroredEvents = new WeakMap<Event, Event>();
  const mirroredEventSources = new WeakMap<Event, Event>();
  const listenerEventSources = new WeakMap<Event, Event>();
  const listenerEvents = new WeakMap<Event, Event>();
  const logicalCurrentTargets = new WeakMap<Event, EventTarget>();
  const logicalEventPhases = new WeakMap<Event, number>();
  const immediatePropagationStopped = new WeakSet<Event>();
  const virtualPropagationStopped = new WeakSet<Event>();
  const boundaryPropagationStopped = new WeakSet<Event>();
  const hostDefaultsSuppressed = new WeakSet<Event>();
  const virtualDefaultsPrevented = new WeakSet<Event>();
  const passiveListeners = new WeakSet<Event>();
  const dispatchFinalizers = new WeakMap<Event, () => void>();
  const stoppedEventDefaults = new WeakMap<Event, () => void>();
  const resumedEventDefaults = new WeakMap<Event, () => void>();

  const eventAttributeName = (element: Element, attributeName: string): string | null => {
    const normalizedName = attributeName.toLowerCase();
    if (!/^on[a-z]/.test(normalizedName)) {
      return null;
    }
    // Browsers compile only the fixed set of event-handler content attributes;
    // the element interface's handler properties mirror that set, so names like
    // "once" or "onboarding-step" stay plain attributes. The prototype chain is
    // consulted directly to ignore expando properties.
    return normalizedName in Object.getPrototypeOf(element) ? normalizedName : null;
  };

  const listenerEventSource = (event: Event): Event =>
    listenerEventSources.get(event) ?? mirroredEventSources.get(event) ?? event;

  const createMirroredEvent = (source: Event): Event => {
    const existing = mirroredEvents.get(source);
    if (existing !== undefined) {
      return existing;
    }

    const hostWindow = hostDocument.defaultView;
    const eventInit = new Proxy(Object.create(null) as EventInit, {
      get(_target, property) {
        if (property === "view") {
          return window;
        }
        return Reflect.get(source, property, source);
      },
    });
    let mirrored: Event;
    try {
      if (
        hostWindow !== null &&
        typeof hostWindow.PointerEvent === "function" &&
        source instanceof hostWindow.PointerEvent &&
        typeof window.PointerEvent === "function"
      ) {
        mirrored = new window.PointerEvent(source.type, eventInit as PointerEventInit);
      } else if (hostWindow !== null && source instanceof hostWindow.WheelEvent) {
        mirrored = new window.WheelEvent(source.type, eventInit as WheelEventInit);
      } else if (
        hostWindow !== null &&
        typeof hostWindow.DragEvent === "function" &&
        source instanceof hostWindow.DragEvent &&
        typeof window.DragEvent === "function"
      ) {
        mirrored = new window.DragEvent(source.type, eventInit as DragEventInit);
      } else if (hostWindow !== null && source instanceof hostWindow.MouseEvent) {
        mirrored = new window.MouseEvent(source.type, eventInit as MouseEventInit);
      } else if (hostWindow !== null && source instanceof hostWindow.KeyboardEvent) {
        mirrored = new window.KeyboardEvent(source.type, eventInit as KeyboardEventInit);
      } else if (
        hostWindow !== null &&
        typeof hostWindow.InputEvent === "function" &&
        source instanceof hostWindow.InputEvent &&
        typeof window.InputEvent === "function"
      ) {
        mirrored = new window.InputEvent(source.type, eventInit as InputEventInit);
      } else if (
        hostWindow !== null &&
        typeof hostWindow.SubmitEvent === "function" &&
        source instanceof hostWindow.SubmitEvent &&
        typeof window.SubmitEvent === "function"
      ) {
        mirrored = new window.SubmitEvent(source.type, eventInit as SubmitEventInit);
      } else if (hostWindow !== null && source instanceof hostWindow.FocusEvent) {
        mirrored = new window.FocusEvent(source.type, eventInit as FocusEventInit);
      } else if (hostWindow !== null && source instanceof hostWindow.CustomEvent) {
        mirrored = new window.CustomEvent(source.type, eventInit as CustomEventInit);
      } else {
        mirrored = new window.Event(source.type, eventInit);
      }
    } catch {
      mirrored = new window.Event(source.type, {
        bubbles: source.bubbles,
        cancelable: source.cancelable,
        composed: source.composed,
      });
    }
    mirroredEvents.set(source, mirrored);
    mirroredEventSources.set(mirrored, source);
    return mirrored;
  };

  const logicalComposedPath = (source: Event): EventTarget[] => {
    const path = source.composedPath();
    const rootIndex = path.indexOf(options.html);
    if (rootIndex === -1) {
      return path;
    }
    return [...path.slice(0, rootIndex + 1), document, window];
  };

  const eventForListener = (
    event: Event,
    currentTarget: EventTarget,
    eventPhase?: number,
    passive = false,
  ): Event => {
    const source = listenerEventSource(event);
    resumedEventDefaults.get(source)?.();
    if (passive) {
      passiveListeners.add(source);
    } else {
      passiveListeners.delete(source);
    }
    logicalCurrentTargets.set(source, currentTarget);
    if (eventPhase === undefined) {
      logicalEventPhases.delete(source);
    } else {
      logicalEventPhases.set(source, eventPhase);
    }
    const existing = listenerEvents.get(source);
    if (existing !== undefined) {
      return existing;
    }
    const mirrored = event instanceof window.Event ? event : createMirroredEvent(source);
    const listenerEvent = new Proxy(mirrored, {
      get(target, property) {
        switch (property) {
          case "target":
          case "srcElement":
            return logicalEventTargets.get(source) ?? source.target;
          case "currentTarget":
            return source.currentTarget === null
              ? null
              : (logicalCurrentTargets.get(source) ?? source.currentTarget);
          case "eventPhase":
            return source.currentTarget === null
              ? 0
              : (logicalEventPhases.get(source) ?? source.eventPhase);
          case "view":
            return window;
          case "defaultPrevented":
            return wasEventDefaultPrevented(source);
          case "cancelBubble":
            return boundaryPropagationStopped.has(source) &&
              !virtualPropagationStopped.has(source)
              ? false
              : source.cancelBubble;
          case "returnValue":
            return !wasEventDefaultPrevented(source);
          case "isTrusted":
            // The mirrored event is synthetic; trust belongs to the source.
            return source.isTrusted;
          case "composedPath":
            return () => logicalComposedPath(source);
          case "preventDefault":
            return () => {
              if (passiveListeners.has(source) && source.currentTarget !== null) {
                return;
              }
              // preventDefault is a spec no-op on non-cancelable events.
              if (source.cancelable) {
                virtualDefaultsPrevented.add(source);
              }
              source.preventDefault();
              target.preventDefault();
            };
          case "stopPropagation":
            return () => {
              virtualPropagationStopped.add(source);
              source.stopPropagation();
              target.stopPropagation();
            };
          case "stopImmediatePropagation":
            return () => {
              virtualPropagationStopped.add(source);
              immediatePropagationStopped.add(source);
              source.stopImmediatePropagation();
              target.stopImmediatePropagation();
            };
          default: {
            if (!(property in target) && property in source) {
              const sourceValue = Reflect.get(source, property, source);
              return typeof sourceValue === "function"
                ? sourceValue.bind(source)
                : sourceValue;
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          }
        }
      },
      set(target, property, value) {
        if (property === "cancelBubble") {
          if (Boolean(value)) {
            virtualPropagationStopped.add(source);
          }
          source.cancelBubble = Boolean(value);
          target.cancelBubble = Boolean(value);
          return true;
        }
        if (property === "returnValue") {
          if (
            !value &&
            source.cancelable &&
            !(passiveListeners.has(source) && source.currentTarget !== null)
          ) {
            virtualDefaultsPrevented.add(source);
            source.preventDefault();
            target.preventDefault();
          }
          return true;
        }
        return Reflect.set(target, property, value, target);
      },
    });
    listenerEventSources.set(listenerEvent, source);
    listenerEvents.set(source, listenerEvent);
    return listenerEvent;
  };

  const finishEventListener = (event: Event): void => {
    const source = listenerEventSource(event);
    if (
      source.cancelBubble ||
      (source.currentTarget === options.shadowRoot && source.eventPhase === 3)
    )
      stoppedEventDefaults.get(source)?.();
  };

  // Document listeners run from the root relay rather than from the document
  // itself, so an event that reaches the wrapper with a foreign currentTarget
  // has to be told which phase the document would have seen it in.
  const documentListenerWrapper = (
    listener: EventListenerOrEventListenerObject,
    capture: boolean,
    listenerOptions: boolean | AddEventListenerOptions | undefined,
    type: string,
  ): EventListener => {
    const passive = listenerPassive(listenerOptions, type, true);
    return (event) => {
      const eventPhase = event.currentTarget === document ? undefined : capture ? 1 : 3;
      const listenerEvent = eventForListener(event, document, eventPhase, passive);
      try {
        if (typeof listener === "function") listener.call(document, listenerEvent);
        else listener.handleEvent(listenerEvent);
      } finally {
        finishEventListener(event);
      }
    };
  };

  const documentListeners = new ListenerRegistry({
    abortSignal,
    createWrapper: documentListenerWrapper,
    onError: (error) => window.reportError(error),
    addToTargets: (type, wrapper, listenerOptions) => {
      nativeAddEventListener.call(document, type, wrapper, listenerOptions);
    },
    removeFromTargets: (type, wrapper, capture) => {
      nativeRemoveEventListener.call(document, type, wrapper, capture);
    },
  });

  const removeElementHandler = (element: Element, eventName: string): void => {
    const wrapper = elementHandlerWrappers.get(element)?.get(eventName);
    if (wrapper !== undefined) {
      const target = element === options.body && eventName === "load" ? window : element;
      nativeRemoveEventListener.call(target, eventName, wrapper);
      elementHandlerWrappers.get(element)?.delete(eventName);
      if (elementHandlerWrappers.get(element)?.size === 0) {
        elementHandlerTargets.delete(element);
      }
    }
  };

  const setElementHandler = (
    element: Element,
    eventName: string,
    listener: EventListener | null,
  ): void => {
    removeElementHandler(element, eventName);
    let handlers = elementHandlerValues.get(element);
    if (handlers === undefined) {
      handlers = new Map();
      elementHandlerValues.set(element, handlers);
    }
    handlers.set(eventName, listener);
    if (listener === null) {
      return;
    }

    const wrapper: EventListener = (event) => {
      const listenerEvent = eventForListener(event, element);
      try {
        const result = (listener as (this: Element, event: Event) => unknown).call(
          element,
          listenerEvent,
        );
        if (result === false) {
          listenerEvent.preventDefault();
        }
      } catch (error) {
        options.onEventHandlerError(error);
      } finally {
        finishEventListener(event);
      }
    };
    let wrappers = elementHandlerWrappers.get(element);
    if (wrappers === undefined) {
      wrappers = new Map();
      elementHandlerWrappers.set(element, wrappers);
    }
    wrappers.set(eventName, wrapper);
    elementHandlerTargets.add(element);
    const target = element === options.body && eventName === "load" ? window : element;
    nativeAddEventListener.call(target, eventName, wrapper);
  };

  const compileEventAttribute = (
    element: Element,
    attributeName: string,
    source: string,
  ): void => {
    const eventName = attributeName.slice(2);
    const completionName = `__vFrameEventHandler${(eventHandlerSequence += 1)}`;
    let listener: EventListener | null = null;
    let compilationError: unknown;
    const errorListener: EventListener = (event) => {
      const errorEvent = event as ErrorEvent;
      compilationError = errorEvent.error ?? new Error(errorEvent.message);
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    Object.defineProperty(window, completionName, {
      configurable: true,
      value(compiledListener: EventListener) {
        listener = compiledListener;
      },
    });
    nativeAddEventListener.call(window, "error", errorListener);

    const companion = nativeCreateElement.call(document, "script") as HTMLScriptElement;
    const nonce = options.getNonce();
    if (nonce !== "") {
      companion.nonce = nonce;
    }
    companion.text = options.createScript(
      `globalThis[${JSON.stringify(completionName)}](function(event) {\n${source}\n});`,
    );
    try {
      nativeAppendChild.call(privateHead, companion);
    } catch (error) {
      compilationError = error;
    } finally {
      nativeRemoveEventListener.call(window, "error", errorListener);
      delete (window as unknown as Record<string, unknown>)[completionName];
      companion.remove();
    }

    if (listener === null) {
      setElementHandler(element, eventName, null);
      options.onEventHandlerError(
        compilationError ??
          new Error(`Event handler ${attributeName} could not be compiled`),
      );
      return;
    }
    setElementHandler(element, eventName, listener);
  };

  interface RootEventRelay {
    capture: EventListener;
    bubble: EventListener;
  }
  const rootEventRelays = new Map<string, RootEventRelay>();
  const boundaryEventRelays = new Map<string, EventListener>();
  const outsideEventRelays = new Map<string, EventListener>();
  const outsideEventTypes = new Set([
    "pointerdown",
    "pointerup",
    "click",
    "focusin",
    "focusout",
  ]);

  const ensureOutsideEventRelay = (type: string): void => {
    if (!outsideEventTypes.has(type) || outsideEventRelays.has(type)) return;
    const relay: EventListener = (source) => {
      if (
        !options.html.isConnected ||
        source.composedPath().includes(options.html) ||
        hostDocument.defaultView?.getComputedStyle(options.html).visibility === "hidden"
      )
        return;
      // Dispatch a separate event: guest cancellation must never suppress a host
      // interaction. Keep it inside this shadow root, including when other frames
      // use independent copies of the runtime. The body is an outside target for
      // guest dismiss layers, without exposing the host's actual target.
      const init = new Proxy({} as PointerEventInit, {
        get(_target, property) {
          return property === "composed" ? false : Reflect.get(source, property, source);
        },
      });
      const event = type.startsWith("pointer")
        ? new window.PointerEvent(type, init)
        : type.startsWith("focus")
          ? new window.FocusEvent(type, { bubbles: true })
          : new window.MouseEvent(type, init);
      nativeDispatchEvent.call(options.body, event);
    };
    outsideEventRelays.set(type, relay);
    hostDocument.addEventListener(type, relay, true);
  };

  const ensureBoundaryEventRelay = (type: string): void => {
    if (boundaryEventRelays.has(type)) {
      return;
    }
    const relay: EventListener = (event) => {
      if (event.composedPath().includes(options.html)) {
        boundaryPropagationStopped.add(listenerEventSource(event));
        event.stopPropagation();
      }
    };
    boundaryEventRelays.set(type, relay);
    options.shadowRoot.addEventListener(type, relay);
  };

  const listenerCanContinue = (event: Event): boolean =>
    !immediatePropagationStopped.has(listenerEventSource(event));

  const invokeRootListeners = (event: Event, capture: boolean): void => {
    virtualListeners
      .get(options.html)
      ?.invoke(event, capture, () => listenerCanContinue(event));
  };

  const ensureRootEventRelay = (type: string): void => {
    if (rootEventRelays.has(type)) {
      return;
    }
    ensureOutsideEventRelay(type);
    const capture: EventListener = (event) => {
      immediatePropagationStopped.delete(listenerEventSource(event));
      documentListeners.invoke(event, true, () => listenerCanContinue(event));
      if (event.cancelBubble || !listenerCanContinue(event)) {
        return;
      }
      invokeRootListeners(event, true);
    };
    const bubble: EventListener = (event) => {
      invokeRootListeners(event, false);
      if (!event.bubbles || event.cancelBubble || !listenerCanContinue(event)) {
        return;
      }
      documentListeners.invoke(event, false, () => listenerCanContinue(event));
    };
    rootEventRelays.set(type, { capture, bubble });
    nativeAddEventListener.call(options.html, type, capture, true);
    nativeAddEventListener.call(options.html, type, bubble, false);
  };

  const listenersFor = (target: EventTarget): ListenerRegistry => {
    let registry = virtualListeners.get(target);
    if (registry === undefined) {
      registry = new ListenerRegistry({
        abortSignal,
        createWrapper: (listener, _capture, listenerOptions, type) => {
          const passive = listenerPassive(
            listenerOptions,
            type,
            target === options.html || target === options.body,
          );
          return (event) => {
            const listenerEvent = eventForListener(event, target, undefined, passive);
            try {
              if (typeof listener === "function") listener.call(target, listenerEvent);
              else listener.handleEvent(listenerEvent);
            } finally {
              finishEventListener(event);
            }
          };
        },
        addToTargets: (type, wrapper, listenerOptions) => {
          if (target === options.html) {
            ensureRootEventRelay(type);
          } else {
            nativeAddEventListener.call(target, type, wrapper, listenerOptions);
          }
        },
        removeFromTargets: (type, wrapper, capture) => {
          if (target !== options.html) {
            nativeRemoveEventListener.call(target, type, wrapper, capture);
          }
        },
        onError: (error) => window.reportError(error),
      });
      virtualListeners.set(target, registry);
      virtualListenerTargets.add(target);
    }
    return registry;
  };

  const installHandlerProperties = (): void => {
    const patchedEventHandlerProperties = new WeakMap<object, Set<string>>();
    for (const startingPrototype of [
      window.HTMLElement.prototype,
      window.SVGElement.prototype,
    ]) {
      let prototype: object | null = startingPrototype;
      while (prototype !== null && prototype !== eventTargetPrototype) {
        for (const propertyName of Object.getOwnPropertyNames(prototype)) {
          if (!propertyName.startsWith("on")) {
            continue;
          }
          const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);
          if (descriptor?.get === undefined || descriptor.set === undefined) {
            continue;
          }
          let names = patchedEventHandlerProperties.get(prototype);
          if (names === undefined) {
            names = new Set();
            patchedEventHandlerProperties.set(prototype, names);
          }
          if (names.has(propertyName)) {
            continue;
          }
          names.add(propertyName);
          const eventName = propertyName.slice(2);
          patch(prototype, propertyName, {
            get(this: Element) {
              if (!virtualNodes.has(this)) {
                return descriptor.get?.call(this) ?? null;
              }
              return elementHandlerValues.get(this)?.get(eventName) ?? null;
            },
            set(this: Element, value: EventListener | null) {
              if (!virtualNodes.has(this)) {
                descriptor.set?.call(this, value);
                return;
              }
              setElementHandler(
                this,
                eventName,
                typeof value === "function" ? value : null,
              );
            },
          });
        }
        prototype = Object.getPrototypeOf(prototype) as object | null;
      }
    }
  };

  const installRelays = (): void => {
    for (const eventType of [
      ...DOCUMENT_EVENT_HANDLER_NAMES,
      "auxclick",
      "beforeinput",
      "contextmenu",
      "dragstart",
      "dragend",
      "drop",
    ]) {
      ensureBoundaryEventRelay(eventType);
    }
  };

  const installPatches = (): void => {
    patch(eventPrototype, "defaultPrevented", {
      get(this: Event) {
        return wasEventDefaultPrevented(this);
      },
    });
    patch(eventPrototype, "preventDefault", {
      writable: true,
      value(this: Event) {
        if (passiveListeners.has(this) && this.currentTarget !== null) return;
        if (this.cancelable) virtualDefaultsPrevented.add(this);
        nativePreventDefault.call(this);
      },
    });
    patch(eventPrototype, "returnValue", {
      get(this: Event) {
        return !wasEventDefaultPrevented(this);
      },
      set(this: Event, value: boolean) {
        if (passiveListeners.has(this) && this.currentTarget !== null) return;
        if (!value && this.cancelable) virtualDefaultsPrevented.add(this);
        nativeReturnValue.set!.call(this, value);
      },
    });
    patch(eventTargetPrototype, "addEventListener", {
      writable: true,
      value(
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        listenerOptions?: boolean | AddEventListenerOptions,
      ): void {
        if (!virtualNodes.has(this as Node)) {
          nativeAddEventListener.call(this, type, listener, listenerOptions);
          return;
        }
        listenersFor(this).add(type, listener, listenerOptions);
      },
    });
    patch(eventTargetPrototype, "removeEventListener", {
      writable: true,
      value(
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        listenerOptions?: boolean | EventListenerOptions,
      ): void {
        if (!virtualNodes.has(this as Node)) {
          nativeRemoveEventListener.call(this, type, listener, listenerOptions);
          return;
        }
        virtualListeners.get(this)?.remove(type, listener, listenerOptions);
      },
    });
    patch(eventTargetPrototype, "dispatchEvent", {
      writable: true,
      value(this: EventTarget, event: Event): boolean {
        const virtual = virtualNodes.has(this as Node);
        if (virtual) {
          ensureBoundaryEventRelay(event.type);
          logicalEventTargets.delete(listenerEventSource(event));
        }
        const result = nativeDispatchEvent.call(this, event);
        // The browser's activation has finished, but the virtual default action
        // is still queued. Restore any temporarily inert link before returning.
        dispatchFinalizers.get(listenerEventSource(event))?.();
        return virtual ? !wasEventDefaultPrevented(event) : result;
      },
    });
  };

  const dispose = (): void => {
    documentListeners.dispose();
    for (const [type, relay] of rootEventRelays) {
      nativeRemoveEventListener.call(options.html, type, relay.capture, true);
      nativeRemoveEventListener.call(options.html, type, relay.bubble, false);
    }
    rootEventRelays.clear();
    for (const [type, relay] of boundaryEventRelays) {
      options.shadowRoot.removeEventListener(type, relay);
    }
    boundaryEventRelays.clear();
    for (const [type, relay] of outsideEventRelays) {
      hostDocument.removeEventListener(type, relay, true);
    }
    outsideEventRelays.clear();
    for (const target of virtualListenerTargets) {
      virtualListeners.get(target)?.dispose();
    }
    virtualListenerTargets.clear();
    for (const element of elementHandlerTargets) {
      for (const eventName of [...(elementHandlerWrappers.get(element)?.keys() ?? [])]) {
        removeElementHandler(element, eventName);
      }
    }
  };

  const suppressEventDefault = (event: Event): void => {
    const source = listenerEventSource(event);
    if (wasEventDefaultPrevented(source)) {
      virtualDefaultsPrevented.add(source);
    }
    hostDefaultsSuppressed.add(source);
    nativePreventDefault.call(source);
  };

  const wasEventDefaultPrevented = (event: Event): boolean => {
    const source = listenerEventSource(event);
    if (!nativeDefaultPrevented.call(source)) {
      // Legacy event initializers reset the native canceled flag. Do not let
      // bookkeeping from an earlier dispatch outlive that reset.
      virtualDefaultsPrevented.delete(source);
      hostDefaultsSuppressed.delete(source);
      return false;
    }
    return virtualDefaultsPrevented.has(source) || !hostDefaultsSuppressed.has(source);
  };

  const suppressNativeLinkDefault = (event: Event, anchor: Element): void => {
    const source = listenerEventSource(event);
    if (source.cancelable || dispatchFinalizers.has(source)) return;
    // A non-cancelable click cannot suppress native activation. Make its link
    // inert only after guest listeners finish, then restore the same Attr nodes
    // once native dispatch returns. This also covers new tabs and downloads,
    // whose activation never reaches the host Navigation API guard.
    const path = source.composedPath();
    const removed: Attr[] = [];
    let attributeOrder: Attr[] = [];
    let finished = false;
    const restore = () => {
      if (removed.length === 0) return;
      const first = attributeOrder.findIndex((attribute) => removed.includes(attribute));
      context.mutateInternally(() => {
        for (const attribute of attributeOrder.slice(first)) {
          const attached = nativeGetAttributeNodeNS.call(
            anchor,
            attribute.namespaceURI,
            attribute.localName,
          );
          if (attached === attribute) nativeRemoveAttributeNode.call(anchor, attribute);
          else if (attached !== null || !removed.includes(attribute)) continue;
          nativeSetAttributeNodeNS.call(anchor, attribute);
        }
      });
      removed.length = 0;
    };
    const block = () => {
      if (removed.length !== 0 || finished) return;
      attributeOrder = Array.from(
        context.nativeAttributes!.get!.call(anchor) as NamedNodeMap,
      );
      context.mutateInternally(() => {
        for (const namespace of [null, "http://www.w3.org/1999/xlink"]) {
          const attribute = nativeGetAttributeNodeNS.call(anchor, namespace, "href");
          if (attribute !== null) {
            removed.push(attribute);
            nativeRemoveAttributeNode.call(anchor, attribute);
          }
        }
      });
    };
    const tail: EventListener = (current) => {
      if (current !== source) return;
      if (
        current.cancelBubble ||
        (!current.bubbles && current.eventPhase === 2) ||
        (current.currentTarget === options.shadowRoot && current.eventPhase === 3)
      )
        block();
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const target of path) {
        nativeRemoveEventListener.call(target, source.type, tail, true);
        nativeRemoveEventListener.call(target, source.type, tail, false);
      }
      stoppedEventDefaults.delete(source);
      resumedEventDefaults.delete(source);
      dispatchFinalizers.delete(source);
      restore();
    };
    stoppedEventDefaults.set(source, block);
    resumedEventDefaults.set(source, restore);
    dispatchFinalizers.set(source, finish);
    for (const target of path) {
      nativeAddEventListener.call(target, source.type, tail, true);
      nativeAddEventListener.call(target, source.type, tail, false);
    }
    // A caller using a captured host dispatchEvent bypasses the facade's return
    // hook; synthetic dispatch still finishes before its microtask checkpoint.
    queueMicrotask(finish);
  };

  return {
    eventAttributeName,
    eventForListener,
    finishEventListener,
    setElementHandler,
    compileEventAttribute,
    ensureRootEventRelay,
    documentListeners,
    suppressEventDefault,
    suppressNativeLinkDefault,
    wasEventDefaultPrevented,
    installHandlerProperties,
    installRelays,
    installPatches,
    dispose,
  };
}
