// Guest listeners see a document that does not exist: their events really
// travel the host tree, so every listener the guest registers is wrapped, and
// the event it receives is a proxy that reports the virtual target, phase and
// composed path. Document listeners are relayed from the shell root, inline
// event attributes are compiled in the realm before being installed as
// listeners, and the shadow boundary stops guest events from leaking out.

import { EnumerableWeakSet } from "../enumerable-weak.js";
import {
  type ListenerRecord,
  ListenerRegistry,
  listenerCapture,
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
  eventForListener(event: Event, currentTarget: EventTarget, eventPhase?: number): Event;
  setElementHandler(
    element: Element,
    eventName: string,
    listener: EventListener | null,
  ): void;
  compileEventAttribute(element: Element, attributeName: string, source: string): void;
  ensureRootEventRelay(type: string): void;
  documentListeners: ListenerRegistry;
  suppressEventDefault(event: Event): void;
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

  const elementHandlerValues = new WeakMap<Element, Map<string, EventListener | null>>();
  const elementHandlerWrappers = new WeakMap<Element, Map<string, EventListener>>();
  const virtualListenerRecords = new WeakMap<EventTarget, ListenerRecord[]>();
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
  ): Event => {
    const source = listenerEventSource(event);
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
            return (
              virtualDefaultsPrevented.has(source) ||
              target.defaultPrevented ||
              (source.defaultPrevented && !hostDefaultsSuppressed.has(source))
            );
          case "cancelBubble":
            return boundaryPropagationStopped.has(source) &&
              !virtualPropagationStopped.has(source)
              ? false
              : source.cancelBubble;
          case "returnValue":
            return !virtualDefaultsPrevented.has(source);
          case "isTrusted":
            // The mirrored event is synthetic; trust belongs to the source.
            return source.isTrusted;
          case "composedPath":
            return () => logicalComposedPath(source);
          case "preventDefault":
            return () => {
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
          if (!value && source.cancelable) {
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

  // Document listeners run from the root relay rather than from the document
  // itself, so an event that reaches the wrapper with a foreign currentTarget
  // has to be told which phase the document would have seen it in.
  const documentListenerWrapper = (
    listener: EventListenerOrEventListenerObject,
    capture: boolean,
  ): EventListener => {
    return (event) => {
      const eventPhase = event.currentTarget === document ? undefined : capture ? 1 : 3;
      const listenerEvent = eventForListener(event, document, eventPhase);
      if (typeof listener === "function") {
        listener.call(document, listenerEvent);
      } else {
        listener.handleEvent(listenerEvent);
      }
    };
  };

  const documentListeners = new ListenerRegistry({
    createWrapper: documentListenerWrapper,
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
    for (const record of [...(virtualListenerRecords.get(options.html) ?? [])]) {
      // A listener removed by an earlier listener in this dispatch is skipped,
      // matching the DOM inner-invoke algorithm.
      if (virtualListenerRecords.get(options.html)?.includes(record) !== true) {
        continue;
      }
      if (record.type !== event.type || record.capture !== capture) {
        continue;
      }
      record.wrapper(event);
      if (!listenerCanContinue(event)) {
        return;
      }
    }
  };

  const ensureRootEventRelay = (type: string): void => {
    if (rootEventRelays.has(type)) {
      return;
    }
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

  const removeVirtualListenerRecord = (
    target: EventTarget,
    record: ListenerRecord,
  ): void => {
    const records = virtualListenerRecords.get(target);
    const index = records?.indexOf(record) ?? -1;
    if (index !== -1) {
      records?.splice(index, 1);
    }
    nativeRemoveEventListener.call(target, record.type, record.wrapper, record.capture);
    if (record.signal !== undefined && record.abort !== undefined) {
      record.signal.removeEventListener("abort", record.abort);
    }
    if (records?.length === 0) {
      virtualListenerTargets.delete(target);
    }
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
        if (listener === null) {
          return;
        }
        if (
          typeof listenerOptions !== "boolean" &&
          listenerOptions?.signal?.aborted === true
        ) {
          return;
        }

        const capture = listenerCapture(listenerOptions);
        let records = virtualListenerRecords.get(this);
        if (records === undefined) {
          records = [];
          virtualListenerRecords.set(this, records);
        }
        if (
          records.some(
            (record) =>
              record.type === type &&
              record.listener === listener &&
              record.capture === capture,
          )
        ) {
          return;
        }

        const record: ListenerRecord = {
          type,
          listener,
          capture,
          wrapper: () => undefined,
        };
        virtualListenerTargets.add(this);
        if (this === options.html) {
          ensureRootEventRelay(type);
        }
        record.wrapper = (event) => {
          try {
            const listenerEvent = eventForListener(event, this);
            if (typeof listener === "function") {
              listener.call(this, listenerEvent);
            } else {
              listener.handleEvent(listenerEvent);
            }
          } finally {
            if (typeof listenerOptions !== "boolean" && listenerOptions?.once === true) {
              removeVirtualListenerRecord(this, record);
            }
          }
        };
        records.push(record);
        if (this !== options.html) {
          nativeAddEventListener.call(this, type, record.wrapper, listenerOptions);
        }
        if (
          typeof listenerOptions !== "boolean" &&
          listenerOptions?.signal !== undefined
        ) {
          record.signal = listenerOptions.signal;
          record.abort = () => removeVirtualListenerRecord(this, record);
          listenerOptions.signal.addEventListener("abort", record.abort, { once: true });
        }
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
        if (listener === null) {
          return;
        }
        const capture = listenerCapture(listenerOptions);
        const record = virtualListenerRecords
          .get(this)
          ?.find(
            (candidate) =>
              candidate.type === type &&
              candidate.listener === listener &&
              candidate.capture === capture,
          );
        if (record !== undefined) {
          removeVirtualListenerRecord(this, record);
        }
      },
    });
    patch(eventTargetPrototype, "dispatchEvent", {
      writable: true,
      value(this: EventTarget, event: Event): boolean {
        if (virtualNodes.has(this as Node)) {
          ensureBoundaryEventRelay(event.type);
          logicalEventTargets.delete(listenerEventSource(event));
        }
        return nativeDispatchEvent.call(this, event);
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
    for (const target of virtualListenerTargets) {
      for (const record of [...(virtualListenerRecords.get(target) ?? [])]) {
        removeVirtualListenerRecord(target, record);
      }
    }
    for (const element of elementHandlerTargets) {
      for (const eventName of [...(elementHandlerWrappers.get(element)?.keys() ?? [])]) {
        removeElementHandler(element, eventName);
      }
    }
  };

  const suppressEventDefault = (event: Event): void => {
    const source = listenerEventSource(event);
    hostDefaultsSuppressed.add(source);
    source.preventDefault();
  };

  const wasEventDefaultPrevented = (event: Event): boolean => {
    const source = listenerEventSource(event);
    return (
      virtualDefaultsPrevented.has(source) ||
      (source.defaultPrevented && !hostDefaultsSuppressed.has(source))
    );
  };

  return {
    eventAttributeName,
    eventForListener,
    setElementHandler,
    compileEventAttribute,
    ensureRootEventRelay,
    documentListeners,
    suppressEventDefault,
    wasEventDefaultPrevented,
    installHandlerProperties,
    installRelays,
    installPatches,
    dispose,
  };
}
