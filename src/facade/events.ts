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
import type { MutationObserverFacade } from "./mutation-observer.js";
import type { FacadeContext } from "./context.js";

// Handler names are read off the realm's prototypes instead of listed: the
// browser's own `on*` accessors are the authoritative set, and a hand-kept list
// silently leaves every handler it forgot attached to the hidden document.
export function eventHandlerNames(
  prototypes: readonly object[],
  eventTargetPrototype: object,
): string[] {
  const names = new Set<string>();
  for (const startingPrototype of prototypes) {
    let prototype: object | null = startingPrototype;
    while (prototype !== null && prototype !== eventTargetPrototype) {
      for (const propertyName of Object.getOwnPropertyNames(prototype)) {
        if (!propertyName.startsWith("on")) {
          continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);
        if (descriptor?.get !== undefined && descriptor.set !== undefined) {
          names.add(propertyName.slice(2));
        }
      }
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
  }
  return [...names];
}

// Events with no `on*` handler of their own that still travel the host tree.
const HANDLERLESS_UI_EVENT_TYPES = [
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  "textInput",
  "pointerrawupdate",
  "focusin",
  "focusout",
  "compositionstart",
  "compositionupdate",
  "compositionend",
];

// Body (and frameset) handler properties that reflect the window's handlers
// rather than the element's own: GlobalEventHandlers' onblur, onerror, onfocus,
// onload, onresize and onscroll, plus every WindowEventHandlers member.
export const WINDOW_REFLECTING_BODY_HANDLER_NAMES = new Set([
  "blur",
  "error",
  "focus",
  "load",
  "resize",
  "scroll",
  "afterprint",
  "beforeprint",
  "beforeunload",
  "hashchange",
  "languagechange",
  "message",
  "messageerror",
  "offline",
  "online",
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
  compileEventAttribute(
    element: Element,
    attributeName: string,
    source: string,
    allowNonce?: boolean,
  ): void;
  ensureRootEventRelay(type: string): void;
  documentListeners: ListenerRegistry;
  listenerEventSource(event: Event): Event;
  suppressEventDefault(event: Event): void;
  suppressNativeLinkDefault(event: Event, anchor: Element): void;
  wasEventDefaultPrevented(event: Event): boolean;
  installHandlerProperties(): void;
  installRelays(): void;
  installPatches(): void;
  dispose(): void;
}

// Per-host-window caches for pristine realm event metadata so later mounts
// skip full prototype/global scans while still reading each realm's descriptors.
const cachedEventConstructorNames = new WeakMap<Window, string[]>();
const cachedEventMemberNames = new WeakMap<Window, Map<string, string[]>>();
const cachedElementHandlerNames = new WeakMap<Window, Map<string, string[]>>();
const cachedDocumentHandlerNames = new WeakMap<Window, string[]>();
const MIRRORED_EVENT_NAMES = [
  "PointerEvent",
  "WheelEvent",
  "DragEvent",
  "MouseEvent",
  "KeyboardEvent",
  "InputEvent",
  "SubmitEvent",
  "FocusEvent",
  "CustomEvent",
] as const;
const CORE_EVENT_CONSTRUCTOR_NAMES = [
  "UIEvent",
  "MouseEvent",
  "PointerEvent",
  "WheelEvent",
  "DragEvent",
  "KeyboardEvent",
  "InputEvent",
  "FocusEvent",
  "SubmitEvent",
  "CustomEvent",
  "TouchEvent",
  "CompositionEvent",
  "ClipboardEvent",
  "AnimationEvent",
  "TransitionEvent",
  "ToggleEvent",
  "FormDataEvent",
  "HashChangeEvent",
  "PopStateEvent",
  "ErrorEvent",
  "MessageEvent",
  "ProgressEvent",
  "BeforeUnloadEvent",
  "PageTransitionEvent",
] as const;

export function cachedDocumentEventHandlerNames(
  window: Window,
  hostWindow: Window,
  eventTargetPrototype: object,
): readonly string[] {
  let names = cachedDocumentHandlerNames.get(hostWindow);
  if (names === undefined) {
    const documentPrototype = (window as unknown as { Document: { prototype: object } })
      .Document.prototype;
    names = eventHandlerNames([documentPrototype], eventTargetPrototype);
    cachedDocumentHandlerNames.set(hostWindow, names);
  }
  return names;
}

export function installEventFacade(
  context: FacadeContext,
  mutationObserver: MutationObserverFacade,
): EventFacade {
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
    nativeContains,
    nativeGetRootNode,
    reachesVirtualDocument,
    virtualNodes,
    logicalEventTargets,
    patch,
  } = context;
  let eventHandlerSequence = 0;
  const abortSignal = captureAbortSignalMethods(window);
  const eventPrototype = window.Event.prototype;
  const eventGetter = (name: string) =>
    Object.getOwnPropertyDescriptor(eventPrototype, name)!.get!;
  const nativeDefaultPrevented = eventGetter("defaultPrevented");
  const nativePreventDefault = eventPrototype.preventDefault;
  const nativeReturnValue = Object.getOwnPropertyDescriptor(
    eventPrototype,
    "returnValue",
  )!;
  const nativeEventTarget = eventGetter("target");
  const nativeEventCurrentTarget = eventGetter("currentTarget");
  const nativeEventPhase = eventGetter("eventPhase");
  const nativeEventType = eventGetter("type");
  const nativeEventBubbles = eventGetter("bubbles");
  const nativeEventCancelBubble = eventGetter("cancelBubble");
  const nativeEventTimeStamp = eventGetter("timeStamp");
  const nativeComposedPath = eventPrototype.composedPath;
  const nativeStopPropagation = eventPrototype.stopPropagation;
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
  const nativeEventMembers = new WeakMap<object, PropertyDescriptorMap>();
  let eventPrototypeMembers: PropertyDescriptorMap | undefined;
  const hostWindow = hostDocument.defaultView!;
  const hostEventPrototype = hostWindow.Event.prototype;
  const lazyEvents = options.lazyEvents === true;
  const emptyEventSkip = new Set<string>();
  const forwardedGuestPrototypes = new WeakSet<object>();
  const checkedGuestEventPrototypes = new WeakSet<object>();
  const checkedHostEventPrototypes = new WeakSet<object>();
  let memberNameCache = cachedEventMemberNames.get(hostWindow);
  if (memberNameCache === undefined) {
    memberNameCache = new Map();
    cachedEventMemberNames.set(hostWindow, memberNameCache);
  }
  const makeMethodForwarder = (
    name: string,
    nativeMethod: (...args: unknown[]) => unknown,
  ) => {
    const arity = nativeMethod.length;
    if (arity === 0) {
      return {
        value(this: Event) {
          return listenerEventSources.has(this)
            ? Reflect.apply((this as never)[name] as () => unknown, this, arguments)
            : Reflect.apply(nativeMethod, this, arguments);
        },
      }.value;
    }
    if (arity === 1) {
      return {
        value(this: Event, _a: unknown) {
          return listenerEventSources.has(this)
            ? Reflect.apply((this as never)[name] as () => unknown, this, arguments)
            : Reflect.apply(nativeMethod, this, arguments);
        },
      }.value;
    }
    if (arity === 2) {
      return {
        value(this: Event, _a: unknown, _b: unknown) {
          return listenerEventSources.has(this)
            ? Reflect.apply((this as never)[name] as () => unknown, this, arguments)
            : Reflect.apply(nativeMethod, this, arguments);
        },
      }.value;
    }
    return {
      value(this: Event, ...args: unknown[]) {
        return listenerEventSources.has(this)
          ? Reflect.apply((this as never)[name] as () => unknown, this, args)
          : Reflect.apply(nativeMethod, this, args);
      },
    }.value;
  };
  const forwardMembers = (
    prototype: object,
    cacheKey: string,
    skip: ReadonlySet<string>,
  ): void => {
    forwardedGuestPrototypes.add(prototype);
    const snapshot: PropertyDescriptorMap = Object.create(null);
    const cachedMembers = cacheKey !== "" ? memberNameCache.get(cacheKey) : undefined;
    const names = cachedMembers ?? Object.getOwnPropertyNames(prototype);
    const discoveredMembers =
      cacheKey !== "" && cachedMembers === undefined ? ([] as string[]) : null;
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index]!;
      if (name === "constructor" || skip.has(name)) {
        const existing = Object.getOwnPropertyDescriptor(prototype, name);
        if (existing !== undefined) snapshot[name] = existing;
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
      if (descriptor === undefined) continue;
      if (typeof descriptor.value === "function") {
        discoveredMembers?.push(name);
        const nativeMethod = descriptor.value as (...args: unknown[]) => unknown;
        const patched: PropertyDescriptor = {
          configurable: true,
          writable: true,
          value: makeMethodForwarder(name, nativeMethod),
        };
        patch(prototype, name, patched, descriptor);
        snapshot[name] = patched;
      } else if (descriptor.get !== undefined) {
        discoveredMembers?.push(name);
        const nativeGet = descriptor.get;
        const nativeSet = descriptor.set;
        const patched: PropertyDescriptor = {
          configurable: true,
          get(this: Event) {
            return listenerEventSources.has(this)
              ? (this as never)[name]
              : nativeGet.call(this);
          },
          ...(nativeSet === undefined
            ? {}
            : {
                set(this: Event, value: unknown) {
                  if (listenerEventSources.has(this)) {
                    (this as never)[name] = value as never;
                  } else {
                    nativeSet.call(this, value);
                  }
                },
              }),
        };
        patch(prototype, name, patched, descriptor);
        snapshot[name] = patched;
      } else {
        snapshot[name] = descriptor;
      }
    }
    if (discoveredMembers !== null) {
      for (const skipped of skip) {
        if (Object.hasOwn(prototype, skipped)) discoveredMembers.push(skipped);
      }
      if (Object.hasOwn(prototype, "constructor")) {
        discoveredMembers.push("constructor");
      }
      memberNameCache.set(cacheKey, discoveredMembers);
    } else if (cachedMembers !== undefined) {
      for (const name of ["NONE", "CAPTURING_PHASE", "AT_TARGET", "BUBBLING_PHASE"]) {
        const existing = Object.getOwnPropertyDescriptor(prototype, name);
        if (existing !== undefined) snapshot[name] = existing;
      }
    }
    nativeEventMembers.set(prototype, snapshot);
    if (prototype === eventPrototype) {
      eventPrototypeMembers = snapshot;
    }
  };
  const ensureLazyEventPrototypes = (mirrored: Event, source: Event): void => {
    let guestProto = Object.getPrototypeOf(mirrored) as object | null;
    while (
      guestProto !== null &&
      guestProto !== eventPrototype &&
      !forwardedGuestPrototypes.has(guestProto) &&
      !checkedGuestEventPrototypes.has(guestProto)
    ) {
      checkedGuestEventPrototypes.add(guestProto);
      if (eventPrototype.isPrototypeOf(guestProto)) {
        const ctor: unknown = Object.getOwnPropertyDescriptor(
          guestProto,
          "constructor",
        )?.value;
        const ctorName = typeof ctor === "function" ? ctor.name : "";
        if (
          ctorName !== "" &&
          Object.getOwnPropertyDescriptor(window, ctorName)?.value === ctor &&
          Function.prototype.toString.call(ctor).includes("[native code]")
        ) {
          forwardMembers(guestProto, ctorName, emptyEventSkip);
        }
      }
      guestProto = Object.getPrototypeOf(guestProto) as object | null;
    }
    if (source !== mirrored) {
      let hostProto = Object.getPrototypeOf(source) as object | null;
      while (
        hostProto !== null &&
        hostProto !== hostEventPrototype &&
        !nativeEventMembers.has(hostProto) &&
        !checkedHostEventPrototypes.has(hostProto)
      ) {
        checkedHostEventPrototypes.add(hostProto);
        if (hostEventPrototype.isPrototypeOf(hostProto)) {
          const ctor: unknown = Object.getOwnPropertyDescriptor(
            hostProto,
            "constructor",
          )?.value;
          const ctorName = typeof ctor === "function" ? ctor.name : "";
          if (
            ctorName !== "" &&
            Object.getOwnPropertyDescriptor(hostWindow, ctorName)?.value === ctor &&
            Function.prototype.toString.call(ctor).includes("[native code]")
          ) {
            nativeEventMembers.set(
              hostProto,
              Object.getOwnPropertyDescriptors(hostProto),
            );
          }
        }
        hostProto = Object.getPrototypeOf(hostProto) as object | null;
      }
    }
  };
  const nativeEventMember = (
    event: Event,
    property: PropertyKey,
  ): PropertyDescriptor | undefined => {
    if (Object.hasOwn(event, property)) {
      return undefined;
    }
    for (
      let owner = Object.getPrototypeOf(event) as object | null;
      owner !== null;
      owner = Object.getPrototypeOf(owner) as object | null
    ) {
      const map =
        owner === eventPrototype ? eventPrototypeMembers : nativeEventMembers.get(owner);
      if (map !== undefined) {
        const native = map[property];
        if (native !== undefined) {
          const descriptor = Object.getOwnPropertyDescriptor(owner, property);
          return descriptor !== undefined &&
            native.value === descriptor.value &&
            native.get === descriptor.get
            ? native
            : undefined;
        }
        if (Object.hasOwn(owner, property)) return undefined;
        continue;
      }
      if (Object.hasOwn(owner, property)) return undefined;
    }
    return undefined;
  };
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
  // Boolean latches skip empty WeakMap/WeakSet probes on the hot dispatch path.
  let hasMirroredEvents = false;
  let hasBoundaryStopped = false;
  let hasLogicalCurrentTargets = false;
  let hasLogicalEventPhases = false;
  let hasPassiveListeners = false;
  let hasImmediateStops = false;
  let hasSuppressedDefaults = false;
  let hasLinkDefaultSuppressors = false;

  const eventAttributeName = (element: Element, attributeName: string): string | null => {
    const normalizedName = attributeName.toLowerCase();
    if (!/^on[a-z]/.test(normalizedName)) {
      return null;
    }
    // Browsers compile only the fixed set of event-handler content attributes;
    // the element interface's handler properties mirror that set, so names like
    // "once" or "onboarding-step" stay plain attributes. The prototype chain is
    // consulted directly to ignore expando properties.
    if (normalizedName in Object.getPrototypeOf(element)) {
      return normalizedName;
    }
    // The shell body stands in for <body>, whose interface is the one that
    // carries the window-reflecting handlers HTMLElement does not.
    return element === options.body &&
      WINDOW_REFLECTING_BODY_HANDLER_NAMES.has(normalizedName.slice(2))
      ? normalizedName
      : null;
  };

  const dispatchedEventSource = (event: Event): Event =>
    hasMirroredEvents ? (mirroredEventSources.get(event) ?? event) : event;

  const listenerEventSource = (event: Event): Event =>
    listenerEventSources.get(event) ?? dispatchedEventSource(event);

  const isGuestVisibleTarget = (target: EventTarget): boolean => {
    if (target === document || target === window) {
      return true;
    }
    try {
      return reachesVirtualDocument(nativeGetRootNode.call(target as Node));
    } catch {
      // Not a node at all (a guest object passed as a relatedTarget).
      return true;
    }
  };

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
    let mirrored: Event | undefined;
    try {
      if (hostWindow !== null) {
        const hostRecord = hostWindow as unknown as Record<string, unknown>;
        const guestRecord = window as unknown as Record<string, unknown>;
        for (const name of MIRRORED_EVENT_NAMES) {
          const HostCtor = hostRecord[name];
          if (typeof HostCtor === "function" && source instanceof HostCtor) {
            const GuestCtor = guestRecord[name];
            if (typeof GuestCtor === "function") {
              mirrored = new (GuestCtor as new (type: string, init?: EventInit) => Event)(
                source.type,
                eventInit,
              );
              break;
            }
          }
        }
      }
      mirrored ??= new window.Event(source.type, eventInit);
    } catch {
      mirrored = new window.Event(source.type, {
        bubbles: source.bubbles,
        cancelable: source.cancelable,
        composed: source.composed,
      });
    }
    hasMirroredEvents = true;
    mirroredEvents.set(source, mirrored);
    mirroredEventSources.set(mirrored, source);
    return mirrored;
  };

  const logicalComposedPath = (source: Event): EventTarget[] => {
    const path = nativeComposedPath.call(source);
    const rootIndex = path.indexOf(options.html);
    if (rootIndex === -1) {
      return path;
    }
    return [...path.slice(0, rootIndex + 1), document, window];
  };

  interface ListenerEventState {
    readonly source: Event;
    readonly sameSource: boolean;
    proxy: Event;
    ownMethods?: Map<string, Function>;
    targetMethods?: WeakMap<Function, Function>;
    sourceMethods?: WeakMap<Function, Function>;
  }
  const listenerEventStates = new WeakMap<Event, ListenerEventState>();
  const ownEventMethod = (
    state: ListenerEventState,
    name: string,
    create: () => () => unknown,
  ): Function => {
    let method = state.ownMethods?.get(name);
    if (method === undefined) {
      method = create();
      Object.defineProperty(method, "name", { value: name });
      (state.ownMethods ??= new Map()).set(name, method);
    }
    return method;
  };
  const forwardEventMethod = (
    state: ListenerEventState,
    isSource: boolean,
    method: Function,
    receiver: Event,
  ): Function => {
    const cache = isSource
      ? (state.sourceMethods ??= new WeakMap())
      : (state.targetMethods ??= new WeakMap());
    let forwarded = cache.get(method);
    if (forwarded === undefined) {
      const listenerEvent = state.proxy;
      forwarded = new Proxy(method, {
        apply: (original, thisArgument, args) =>
          Reflect.apply(
            original,
            thisArgument === listenerEvent ? receiver : thisArgument,
            args,
          ),
      });
      cache.set(method, forwarded);
    }
    return forwarded;
  };
  const eventProxyHandler: ProxyHandler<Event> = {
    get(target, property) {
      const state = listenerEventStates.get(target)!;
      const source = state.source;
      if (property === "isTrusted") {
        // isTrusted is the browser's unforgeable instance accessor; trust belongs to source.
        return source.isTrusted;
      }
      const fromSource = !state.sameSource && !(property in target) && property in source;
      const receiver = fromSource ? source : target;
      const nativeMember = nativeEventMember(receiver, property);
      // Guest fields, getters and class methods keep their identity and see
      // the logical event as `this`. Only browser members need a raw receiver.
      if (nativeMember === undefined) {
        return Reflect.get(receiver, property, state.proxy);
      }
      switch (property) {
        case "target":
        case "srcElement":
          return logicalEventTargets.get(source) ?? nativeEventTarget.call(source);
        case "currentTarget": {
          const nativeCurrent = nativeEventCurrentTarget.call(source);
          return nativeCurrent === null
            ? null
            : hasLogicalCurrentTargets
              ? (logicalCurrentTargets.get(source) ?? nativeCurrent)
              : nativeCurrent;
        }
        case "eventPhase":
          return nativeEventCurrentTarget.call(source) === null
            ? 0
            : hasLogicalEventPhases
              ? (logicalEventPhases.get(source) ?? nativeEventPhase.call(source))
              : nativeEventPhase.call(source);
        case "view":
          // Only UIEvents have a view, and a null one stays null.
          return "view" in source ? (source.view === null ? null : window) : undefined;
        case "defaultPrevented":
          return hasSuppressedDefaults
            ? wasEventDefaultPrevented(source)
            : nativeDefaultPrevented.call(source);
        case "cancelBubble":
          return hasBoundaryStopped &&
            boundaryPropagationStopped.has(source) &&
            !virtualPropagationStopped.has(source)
            ? false
            : nativeEventCancelBubble.call(source);
        case "returnValue":
          return !(hasSuppressedDefaults
            ? wasEventDefaultPrevented(source)
            : nativeDefaultPrevented.call(source));
        case "timeStamp":
          return nativeEventTimeStamp.call(source);
        case "relatedTarget": {
          // The browser retargets relatedTarget against the current target,
          // which still leaves a node of the host page visible to a listener
          // inside the shadow tree. The guest has no such page.
          if (!(property in source)) {
            return undefined;
          }
          const related = Reflect.get(source, property, source) as EventTarget | null;
          return related === null || isGuestVisibleTarget(related) ? related : null;
        }
        case "composedPath":
          return ownEventMethod(
            state,
            "composedPath",
            () => () => logicalComposedPath(source),
          );
        case "preventDefault":
          return ownEventMethod(state, "preventDefault", () => () => {
            if (
              hasPassiveListeners &&
              passiveListeners.has(source) &&
              source.currentTarget !== null
            ) {
              return;
            }
            // preventDefault is a spec no-op on non-cancelable events.
            if (source.cancelable) {
              virtualDefaultsPrevented.add(source);
            }
            source.preventDefault();
            target.preventDefault();
          });
        case "stopPropagation":
          return ownEventMethod(state, "stopPropagation", () => () => {
            virtualPropagationStopped.add(source);
            source.stopPropagation();
            target.stopPropagation();
          });
        case "stopImmediatePropagation":
          return ownEventMethod(state, "stopImmediatePropagation", () => () => {
            virtualPropagationStopped.add(source);
            hasImmediateStops = true;
            immediatePropagationStopped.add(source);
            source.stopImmediatePropagation();
            target.stopImmediatePropagation();
          });
        default: {
          const value = Reflect.get(receiver, property, receiver);
          // `constructor` is the event's class, not a method of it.
          return typeof value === "function" &&
            nativeMember?.value === value &&
            property !== "constructor"
            ? forwardEventMethod(state, fromSource, value, receiver)
            : value;
        }
      }
    },
    set(target, property, value) {
      const state = listenerEventStates.get(target)!;
      const source = state.source;
      if (property === "cancelBubble") {
        if (value) {
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
          !(
            hasPassiveListeners &&
            passiveListeners.has(source) &&
            source.currentTarget !== null
          )
        ) {
          virtualDefaultsPrevented.add(source);
          source.preventDefault();
          target.preventDefault();
        }
        return true;
      }
      return Reflect.set(target, property, value, target);
    },
  };

  const eventForSource = (
    source: Event,
    currentTarget: EventTarget | undefined,
    eventPhase?: number,
    passive = false,
  ): Event => {
    if (hasLinkDefaultSuppressors) {
      resumedEventDefaults.get(source)?.();
    }
    if (passive) {
      hasPassiveListeners = true;
      passiveListeners.add(source);
    } else if (hasPassiveListeners) {
      passiveListeners.delete(source);
    }
    if (
      currentTarget !== undefined &&
      currentTarget !== nativeEventCurrentTarget.call(source)
    ) {
      hasLogicalCurrentTargets = true;
      logicalCurrentTargets.set(source, currentTarget);
    } else if (hasLogicalCurrentTargets) {
      logicalCurrentTargets.delete(source);
    }
    if (eventPhase !== undefined) {
      hasLogicalEventPhases = true;
      logicalEventPhases.set(source, eventPhase);
    } else if (hasLogicalEventPhases) {
      logicalEventPhases.delete(source);
    }
    const existingState = listenerEventStates.get(source);
    if (existingState !== undefined) {
      return existingState.proxy;
    }
    let mirrored: Event;
    if (Object.getPrototypeOf(source) === eventPrototype) {
      mirrored = source;
    } else {
      mirrored = source instanceof window.Event ? source : createMirroredEvent(source);
      if (mirrored !== source) {
        const mirroredState = listenerEventStates.get(mirrored);
        if (mirroredState !== undefined) {
          return mirroredState.proxy;
        }
      }
      if (lazyEvents) {
        ensureLazyEventPrototypes(mirrored, source);
      }
    }
    const state: ListenerEventState = {
      source,
      sameSource: mirrored === source,
      proxy: mirrored,
    };
    const listenerEvent: Event = new Proxy(mirrored, eventProxyHandler);
    state.proxy = listenerEvent;
    listenerEventStates.set(mirrored, state);
    listenerEventSources.set(listenerEvent, source);
    return listenerEvent;
  };

  const eventForListener = (
    event: Event,
    currentTarget: EventTarget,
    eventPhase?: number,
    passive = false,
  ): Event =>
    eventForSource(listenerEventSource(event), currentTarget, eventPhase, passive);

  const finishDispatchedEventListener = (source: Event): void => {
    if (
      nativeEventCancelBubble.call(source) ||
      (nativeEventCurrentTarget.call(source) === options.shadowRoot &&
        nativeEventPhase.call(source) === 3)
    )
      stoppedEventDefaults.get(source)?.();
  };

  const finishEventListener = (event: Event): void => {
    if (!hasLinkDefaultSuppressors) {
      return;
    }
    finishDispatchedEventListener(listenerEventSource(event));
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
    const phase = capture ? 1 : 3;
    if (typeof listener === "function") {
      return (event) => {
        const source = dispatchedEventSource(event);
        const eventPhase =
          nativeEventCurrentTarget.call(source) === document ? undefined : phase;
        const listenerEvent = eventForSource(source, document, eventPhase, passive);
        try {
          listener.call(document, listenerEvent);
        } finally {
          if (hasLinkDefaultSuppressors) finishDispatchedEventListener(source);
        }
      };
    }
    return (event) => {
      const source = dispatchedEventSource(event);
      const eventPhase =
        nativeEventCurrentTarget.call(source) === document ? undefined : phase;
      const listenerEvent = eventForSource(source, document, eventPhase, passive);
      try {
        listener.handleEvent(listenerEvent);
      } finally {
        if (hasLinkDefaultSuppressors) finishDispatchedEventListener(source);
      }
    };
  };

  const documentListeners = new ListenerRegistry({
    abortSignal,
    createWrapper: documentListenerWrapper,
    onError: (error) => window.reportError(error),
    TypeError: window.TypeError,
    addToTargets: (type, wrapper, listenerOptions) => {
      ensureBoundaryEventRelay(type);
      nativeAddEventListener.call(document, type, wrapper, listenerOptions);
    },
    removeFromTargets: (type, wrapper, capture) => {
      nativeRemoveEventListener.call(document, type, wrapper, capture);
    },
  });

  // Window-reflecting handlers on the shell body are the window's own handlers:
  // `body.onresize` and `window.onresize` are one slot, so the body just reads
  // and writes the window's property (native or bridged, whichever the realm
  // has) instead of keeping a second copy that could drift or double-fire.
  const handlerOnWindow = (element: Element, eventName: string): boolean =>
    element === options.body && WINDOW_REFLECTING_BODY_HANDLER_NAMES.has(eventName);

  const removeElementHandler = (element: Element, eventName: string): void => {
    const wrapper = elementHandlerWrappers.get(element)?.get(eventName);
    if (wrapper !== undefined) {
      nativeRemoveEventListener.call(element, eventName, wrapper);
      elementHandlerWrappers.get(element)?.delete(eventName);
      if (elementHandlerWrappers.get(element)?.size === 0) {
        elementHandlerTargets.delete(element);
      }
    }
  };

  // One wrapper per (element, type) reads the handler's current value when the
  // event arrives, so assigning a new function replaces the callback without
  // moving it in the listener list. Only null deactivates the handler, and
  // activating it again registers a fresh listener at the end, as the spec says.
  const windowHandlers = window as unknown as Record<string, EventListener | null>;
  const setElementHandler = (
    element: Element,
    eventName: string,
    listener: EventListener | null,
  ): void => {
    if (handlerOnWindow(element, eventName)) {
      windowHandlers[`on${eventName}`] = listener;
      return;
    }
    let handlers = elementHandlerValues.get(element);
    if (handlers === undefined) {
      handlers = new Map();
      elementHandlerValues.set(element, handlers);
    }
    handlers.set(eventName, listener);
    if (listener === null) {
      removeElementHandler(element, eventName);
      return;
    }
    if (elementHandlerWrappers.get(element)?.has(eventName) === true) {
      return;
    }

    const wrapper: EventListener = (event) => {
      const current = elementHandlerValues.get(element)?.get(eventName);
      if (current === null || current === undefined) {
        return;
      }
      const source = dispatchedEventSource(event);
      const listenerEvent = eventForSource(source, undefined);
      try {
        const result = (current as (this: unknown, event: Event) => unknown).call(
          element,
          listenerEvent,
        );
        if (result === false) {
          listenerEvent.preventDefault();
        }
      } catch (error) {
        options.onEventHandlerError(error);
      } finally {
        if (hasLinkDefaultSuppressors) finishDispatchedEventListener(source);
      }
    };
    let wrappers = elementHandlerWrappers.get(element);
    if (wrappers === undefined) {
      wrappers = new Map();
      elementHandlerWrappers.set(element, wrappers);
    }
    wrappers.set(eventName, wrapper);
    elementHandlerTargets.add(element);
    ensureBoundaryEventRelay(eventName);
    nativeAddEventListener.call(element, eventName, wrapper);
  };

  const compileEventAttribute = (
    element: Element,
    attributeName: string,
    source: string,
    allowNonce = true,
  ): void => {
    const eventName = attributeName.slice(2);
    // On the window, onerror is called with ErrorEvent's fields spread out.
    const parameters =
      handlerOnWindow(element, eventName) && eventName === "error"
        ? "event, source, lineno, colno, error"
        : "event";
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
    if (allowNonce && nonce !== "") {
      companion.nonce = nonce;
    }
    companion.text = options.createScript(
      `globalThis[${JSON.stringify(completionName)}](function(${parameters}) {\n${source}\n});`,
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
  const boundaryEventRelayTypes = new Set<string>();
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

  // One shared boundary listener serves every relayed event type.
  const boundaryRelay: EventListener = (event) => {
    const target = nativeEventTarget.call(event) as Node | null;
    if (
      (target !== null &&
        (target === options.html ||
          ("nodeType" in target && nativeContains.call(options.html, target)))) ||
      nativeComposedPath.call(event).includes(options.html)
    ) {
      hasBoundaryStopped = true;
      boundaryPropagationStopped.add(dispatchedEventSource(event));
      nativeStopPropagation.call(event);
    }
  };

  const ensureBoundaryEventRelay = (type: string): void => {
    if (boundaryEventRelayTypes.has(type)) {
      return;
    }
    boundaryEventRelayTypes.add(type);
    options.shadowRoot.addEventListener(type, boundaryRelay);
  };

  const listenerCanContinue = (event: Event): boolean =>
    !hasImmediateStops || !immediatePropagationStopped.has(dispatchedEventSource(event));

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
      if (hasImmediateStops) {
        immediatePropagationStopped.delete(dispatchedEventSource(event));
      }
      documentListeners.invoke(event, true, () => listenerCanContinue(event));
      if (nativeEventCancelBubble.call(event) || !listenerCanContinue(event)) {
        return;
      }
      invokeRootListeners(event, true);
    };
    const bubble: EventListener = (event) => {
      invokeRootListeners(event, false);
      if (
        !nativeEventBubbles.call(event) ||
        nativeEventCancelBubble.call(event) ||
        !listenerCanContinue(event)
      ) {
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
          if (typeof listener === "function") {
            return (event) => {
              const source = dispatchedEventSource(event);
              const listenerEvent = eventForSource(source, undefined, undefined, passive);
              try {
                listener.call(target, listenerEvent);
              } finally {
                if (hasLinkDefaultSuppressors) finishDispatchedEventListener(source);
              }
            };
          }
          return (event) => {
            const source = dispatchedEventSource(event);
            const listenerEvent = eventForSource(source, undefined, undefined, passive);
            try {
              listener.handleEvent(listenerEvent);
            } finally {
              if (hasLinkDefaultSuppressors) finishDispatchedEventListener(source);
            }
          };
        },
        addToTargets: (type, wrapper, listenerOptions) => {
          ensureBoundaryEventRelay(type);
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
        TypeError: window.TypeError,
      });
      virtualListeners.set(target, registry);
      virtualListenerTargets.add(target);
    }
    return registry;
  };

  const discoveredHandlerTypes = new Set<string>();
  const installHandlerProperties = (): void => {
    // The window-reflecting handlers HTMLElement lacks only exist on the body
    // interface; the shell body gets them as properties of its own.
    for (const eventName of WINDOW_REFLECTING_BODY_HANDLER_NAMES) {
      if (
        `on${eventName}` in window.HTMLElement.prototype ||
        !(`on${eventName}` in window)
      ) {
        continue;
      }
      patch(options.body, `on${eventName}`, {
        enumerable: true,
        get(): EventListener | null {
          return windowHandlers[`on${eventName}`] ?? null;
        },
        set(value: EventListener | null) {
          setElementHandler(
            options.body,
            eventName,
            typeof value === "function" ? value : null,
          );
        },
      });
    }
    const patchHandlerOnPrototype = (
      prototype: object,
      propertyName: string,
      descriptor: PropertyDescriptor,
    ): void => {
      const eventName = propertyName.slice(2);
      discoveredHandlerTypes.add(eventName);
      patch(
        prototype,
        propertyName,
        {
          get(this: Element) {
            if (!virtualNodes.has(this)) {
              return descriptor.get?.call(this) ?? null;
            }
            if (handlerOnWindow(this, eventName)) {
              return windowHandlers[`on${eventName}`] ?? null;
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
        },
        descriptor,
      );
    };
    const cachedPlan = cachedElementHandlerNames.get(hostWindow);
    const planToStore = cachedPlan === undefined ? new Map<string, string[]>() : null;
    const patchedPrototypes = new Set<object>();
    for (const startingPrototype of [
      window.HTMLElement.prototype,
      window.SVGElement.prototype,
    ]) {
      let prototype: object | null = startingPrototype;
      while (prototype !== null && prototype !== eventTargetPrototype) {
        if (!patchedPrototypes.has(prototype)) {
          patchedPrototypes.add(prototype);
          const ctorName =
            typeof (prototype as { constructor?: { name?: string } }).constructor
              ?.name === "string"
              ? (prototype as { constructor: { name: string } }).constructor.name
              : "";
          const cachedNames =
            cachedPlan !== undefined && ctorName !== ""
              ? cachedPlan.get(ctorName)
              : undefined;
          if (cachedNames !== undefined) {
            for (let index = 0; index < cachedNames.length; index += 1) {
              const propertyName = cachedNames[index]!;
              const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);
              if (descriptor?.get !== undefined && descriptor.set !== undefined) {
                patchHandlerOnPrototype(prototype, propertyName, descriptor);
              }
            }
          } else {
            const found: string[] = [];
            for (const propertyName of Object.getOwnPropertyNames(prototype)) {
              if (!propertyName.startsWith("on")) {
                continue;
              }
              const descriptor = Object.getOwnPropertyDescriptor(prototype, propertyName);
              if (descriptor?.get === undefined || descriptor.set === undefined) {
                continue;
              }
              found.push(propertyName);
              patchHandlerOnPrototype(prototype, propertyName, descriptor);
            }
            if (planToStore !== null && ctorName !== "") {
              planToStore.set(ctorName, found);
            }
          }
        }
        prototype = Object.getPrototypeOf(prototype) as object | null;
      }
    }
    if (planToStore !== null) {
      cachedElementHandlerNames.set(hostWindow, planToStore);
    }
  };

  // The shadow root is where a guest event stops, so every type the browser can
  // route through it needs a relay there: the handler-bearing types come from
  // the same prototypes the handler properties do. Types outside both lists are
  // covered the first time the guest listens for or dispatches them.
  const installRelays = (): void => {
    for (const eventType of discoveredHandlerTypes) {
      ensureBoundaryEventRelay(eventType);
    }
    for (const eventType of cachedDocumentEventHandlerNames(
      window,
      hostWindow,
      eventTargetPrototype,
    )) {
      ensureBoundaryEventRelay(eventType);
    }
    for (const eventType of HANDLERLESS_UI_EVENT_TYPES) {
      ensureBoundaryEventRelay(eventType);
    }
  };

  const installPatches = (): void => {
    patch(eventPrototype, "defaultPrevented", {
      get(this: Event) {
        return wasEventDefaultPrevented(this);
      },
    });
    // Listeners hold a proxy of the event, which the native methods refuse as a
    // receiver, so a call through the prototype (`Event.prototype.preventDefault
    // .call(event)`) has to reach the event the proxy stands for.
    patch(eventPrototype, "preventDefault", {
      writable: true,
      value(this: Event) {
        const source = listenerEventSource(this);
        if (passiveListeners.has(source) && source.currentTarget !== null) return;
        if (source.cancelable) virtualDefaultsPrevented.add(source);
        nativePreventDefault.call(source);
      },
    });
    patch(eventPrototype, "returnValue", {
      get(this: Event) {
        return !wasEventDefaultPrevented(this);
      },
      set(this: Event, value: boolean) {
        const source = listenerEventSource(this);
        if (passiveListeners.has(source) && source.currentTarget !== null) return;
        if (!value && source.cancelable) virtualDefaultsPrevented.add(source);
        nativeReturnValue.set!.call(source, value);
      },
    });
    // Every other member is forwarded to the proxy itself, whose traps already
    // answer with the logical target, phase and path. The subclasses' own
    // accessors (MouseEvent.clientX, KeyboardEvent.key) refuse the proxy just the
    // same, so every Event interface of the realm gets the forwarding (or only
    // core UI subclasses eagerly when `lazyEvents` is opted into).
    forwardMembers(
      eventPrototype,
      "Event",
      new Set(["preventDefault", "returnValue", "defaultPrevented"]),
    );
    if (lazyEvents) {
      for (const name of CORE_EVENT_CONSTRUCTOR_NAMES) {
        const member: unknown = Object.getOwnPropertyDescriptor(window, name)?.value;
        const prototype =
          typeof member === "function" ? (member.prototype as unknown) : null;
        if (
          typeof prototype === "object" &&
          prototype !== null &&
          prototype !== eventPrototype &&
          eventPrototype.isPrototypeOf(prototype)
        ) {
          forwardMembers(prototype, name, emptyEventSkip);
        }
      }
      nativeEventMembers.set(
        hostEventPrototype,
        Object.getOwnPropertyDescriptors(hostEventPrototype),
      );
    } else {
      // The window is still pristine here, so every Event subclass on it is one
      // of the browser's own. Cache the list of constructor names across mounts
      // in the same host window so subsequent mounts avoid scanning all globals.
      const cachedNames = cachedEventConstructorNames.get(hostWindow);
      const discovered = cachedNames === undefined ? ([] as string[]) : undefined;
      for (const name of cachedNames ?? Object.getOwnPropertyNames(window)) {
        const member: unknown = Object.getOwnPropertyDescriptor(window, name)?.value;
        const prototype =
          typeof member === "function" ? (member.prototype as unknown) : null;
        if (
          typeof prototype === "object" &&
          prototype !== null &&
          prototype !== eventPrototype &&
          eventPrototype.isPrototypeOf(prototype)
        ) {
          discovered?.push(name);
          forwardMembers(prototype, name, emptyEventSkip);
        }
      }
      if (discovered !== undefined) {
        cachedEventConstructorNames.set(hostWindow, discovered);
      }
      // A host event may expose an interface that the mirrored event does not.
      // Its native members also require the original receiver; snapshotting per
      // mount lets later mounts see new host subclasses while properties added
      // after mount still receive the logical event proxy.
      nativeEventMembers.set(
        hostEventPrototype,
        Object.getOwnPropertyDescriptors(hostEventPrototype),
      );
      for (const name of Object.getOwnPropertyNames(hostWindow)) {
        const member: unknown = Object.getOwnPropertyDescriptor(hostWindow, name)?.value;
        const prototype = typeof member === "function" ? member.prototype : null;
        if (
          typeof prototype === "object" &&
          prototype !== null &&
          hostEventPrototype.isPrototypeOf(prototype)
        ) {
          nativeEventMembers.set(prototype, Object.getOwnPropertyDescriptors(prototype));
        }
      }
    }
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
        // Native dispatch rejects a non-event, or one already being dispatched,
        // and the bookkeeping must not outlive that rejection: it would change
        // the target of the dispatch that is still in flight.
        // A listener holds a proxy of the event; the browser only dispatches the
        // event itself, so a saved or re-dispatched one is unwrapped first.
        const isObject = typeof event === "object" && event !== null;
        const unwrapped = isObject ? listenerEventSource(event) : event;
        const source = virtual && isObject ? unwrapped : null;
        const previousTarget =
          source === null ? undefined : logicalEventTargets.get(source);
        if (source !== null) {
          ensureBoundaryEventRelay(nativeEventType.call(source));
          if (previousTarget !== undefined) {
            logicalEventTargets.delete(source);
          }
        }
        let result: boolean;
        try {
          result = nativeDispatchEvent.call(this, unwrapped);
        } catch (error) {
          if (source !== null && previousTarget !== undefined) {
            logicalEventTargets.set(source, previousTarget);
          }
          throw error;
        }
        // The browser's activation has finished, but the virtual default action
        // is still queued. Restore any temporarily inert link before returning.
        if (hasLinkDefaultSuppressors) {
          dispatchFinalizers.get(unwrapped)?.();
        }
        return virtual && hasSuppressedDefaults
          ? !wasEventDefaultPrevented(unwrapped)
          : result;
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
    for (const type of boundaryEventRelayTypes) {
      options.shadowRoot.removeEventListener(type, boundaryRelay);
    }
    boundaryEventRelayTypes.clear();
    for (const [type, relay] of outsideEventRelays) {
      hostDocument.removeEventListener(type, relay, true);
    }
    outsideEventRelays.clear();
    virtualListenerTargets.drain((target) => {
      virtualListeners.get(target)?.dispose();
    });
    elementHandlerTargets.drain((element) => {
      const wrappers = elementHandlerWrappers.get(element);
      if (wrappers === undefined) return;
      for (const [eventName, wrapper] of wrappers) {
        nativeRemoveEventListener.call(element, eventName, wrapper);
      }
      wrappers.clear();
    });
  };

  const suppressEventDefault = (event: Event): void => {
    const source = listenerEventSource(event);
    if (wasEventDefaultPrevented(source)) {
      virtualDefaultsPrevented.add(source);
    }
    hasSuppressedDefaults = true;
    hostDefaultsSuppressed.add(source);
    nativePreventDefault.call(source);
  };

  const wasEventDefaultPrevented = (event: Event): boolean => {
    const source = listenerEventSource(event);
    if (!nativeDefaultPrevented.call(source)) {
      if (!hasSuppressedDefaults) {
        return false;
      }
      // Legacy event initializers reset the native canceled flag. Do not let
      // bookkeeping from an earlier dispatch outlive that reset.
      virtualDefaultsPrevented.delete(source);
      hostDefaultsSuppressed.delete(source);
      return false;
    }
    if (!hasSuppressedDefaults) {
      return true;
    }
    return virtualDefaultsPrevented.has(source) || !hostDefaultsSuppressed.has(source);
  };

  const suppressNativeLinkDefault = (event: Event, anchor: Element): void => {
    const source = listenerEventSource(event);
    if (source.cancelable || dispatchFinalizers.has(source)) return;
    hasLinkDefaultSuppressors = true;
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
      mutationObserver.mutateInternally(() => {
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
      mutationObserver.mutateInternally(() => {
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
    listenerEventSource,
    suppressEventDefault,
    suppressNativeLinkDefault,
    wasEventDefaultPrevented,
    installHandlerProperties,
    installRelays,
    installPatches,
    dispose,
  };
}
