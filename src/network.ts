import { ListenerRegistry, captureAbortSignalMethods } from "./listener-registry.js";
import { EnumerableWeakMap } from "./enumerable-weak.js";
import type { VFrameCredentials, VFrameWindow } from "./types.js";

export interface NetworkPatchOptions {
  window: VFrameWindow;
  signal: AbortSignal;
  credentials: VFrameCredentials;
  getBaseURL(): string;
  /** Also catches custom-element teardown reactions deferred by the engine. */
  isActive?(): boolean;
}

function resolveNetworkURL(
  window: VFrameWindow,
  value: unknown,
  baseURL: string,
): string {
  return new window.URL(String(value), baseURL).href;
}

function combinedSignal(
  window: VFrameWindow,
  left: AbortSignal,
  right?: AbortSignal | null,
): AbortSignal {
  if (right === undefined || right === null || right === left) {
    return left;
  }

  const abortSignal = window.AbortSignal as typeof AbortSignal & {
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (abortSignal.any !== undefined) {
    return abortSignal.any([left, right]);
  }

  const controller = new window.AbortController();
  const abort = (event: Event) => {
    const source = event.target as AbortSignal;
    controller.abort(source.reason);
  };
  left.addEventListener("abort", abort, { once: true });
  right.addEventListener("abort", abort, { once: true });
  if (left.aborted) {
    controller.abort(left.reason);
  } else if (right.aborted) {
    controller.abort(right.reason);
  }
  return controller.signal;
}

function eventSourceOptions(
  value: unknown,
  credentials: VFrameCredentials,
): EventSourceInit {
  const suppliedOptions = value as EventSourceInit | null | undefined;
  return {
    ...suppliedOptions,
    withCredentials: suppliedOptions?.withCredentials ?? credentials === "include",
  };
}

function workerOptions(value: unknown, credentials: VFrameCredentials): WorkerOptions {
  const suppliedOptions = value as WorkerOptions | null | undefined;
  return {
    ...suppliedOptions,
    credentials: suppliedOptions?.credentials ?? credentials,
  };
}

function sharedWorkerOptions(
  value: unknown,
  credentials: VFrameCredentials,
): WorkerOptions {
  if (typeof value === "string") {
    return { name: value, credentials };
  }
  return workerOptions(value, credentials);
}

export function installNetworkPatches(options: NetworkPatchOptions): () => void {
  const window = options.window;
  const abortSignal = captureAbortSignalMethods(window);
  const nativeFetch = window.fetch.bind(window);
  const NativeRequest = window.Request;
  const nativeRequestURLGetter = Object.getOwnPropertyDescriptor(
    NativeRequest.prototype,
    "url",
  )?.get;
  const NativeXMLHttpRequest = window.XMLHttpRequest;
  const nativeXHROpen = NativeXMLHttpRequest.prototype.open;
  const nativeXHRSend = NativeXMLHttpRequest.prototype.send;
  const nativeXHRAbort = NativeXMLHttpRequest.prototype.abort;
  const nativeXHRAddEventListener = NativeXMLHttpRequest.prototype.addEventListener;
  const nativeXHRRemoveEventListener = NativeXMLHttpRequest.prototype.removeEventListener;
  const NativeXMLHttpRequestUpload = window.XMLHttpRequestUpload;
  const nativeXHRUploadAddEventListener =
    NativeXMLHttpRequestUpload.prototype.addEventListener;
  const nativeXHRUploadRemoveEventListener =
    NativeXMLHttpRequestUpload.prototype.removeEventListener;
  const nativeXHRWithCredentials = Object.getOwnPropertyDescriptor(
    NativeXMLHttpRequest.prototype,
    "withCredentials",
  );
  const nativeXHRWithCredentialsSetter = nativeXHRWithCredentials?.set;
  const activeRequests = new Set<{ dispose(): void }>();
  const activeXHRSends = new WeakMap<XMLHttpRequest, { dispose(): void }>();
  const nativeXHRAsync = new WeakMap<XMLHttpRequest, boolean>();
  const nativeXHRCredentialsAssigned = new WeakSet<XMLHttpRequest>();
  const nativeXHRUploads = new WeakMap<XMLHttpRequestUpload, XMLHttpRequest>();
  const silencedNativeXHRS = new WeakSet<XMLHttpRequest>();
  const nativeEventRegistries = new WeakMap<EventTarget, ListenerRegistry>();
  const activeConnections = new EnumerableWeakMap<object, () => void>();
  const originals = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const explicitAborts = new WeakSet<XMLHttpRequest>();
  let disposed = false;

  const remember = (target: object, key: PropertyKey) => {
    originals.set(key, Object.getOwnPropertyDescriptor(target, key));
  };

  const nativeEventTargetIsSilenced = (target: EventTarget): boolean => {
    if (disposed || options.signal.aborted || options.isActive?.() === false) return true;
    if (target instanceof NativeXMLHttpRequest) {
      return silencedNativeXHRS.has(target);
    }
    const request = nativeXHRUploads.get(target as XMLHttpRequestUpload);
    return request !== undefined && silencedNativeXHRS.has(request);
  };

  const invokeNativeListener = (
    target: EventTarget,
    listener: EventListenerOrEventListenerObject,
    event: Event,
  ): void => {
    if (nativeEventTargetIsSilenced(target)) return;
    const request =
      target instanceof NativeXMLHttpRequest
        ? target
        : nativeXHRUploads.get(target as XMLHttpRequestUpload);
    const invoke = () => {
      if (nativeEventTargetIsSilenced(target)) return;
      if (typeof listener === "function") listener.call(target, event);
      else listener.handleEvent(event);
    };
    // WebKit emits terminal XHR events during iframe removal, before the host
    // disconnects. Recheck failing async requests after native DOM reactions;
    // explicit abort() and synchronous XHR retain synchronous event delivery.
    if (
      request &&
      request.readyState === 4 &&
      request.status === 0 &&
      nativeXHRAsync.get(request) !== false &&
      !explicitAborts.has(request)
    ) {
      queueMicrotask(() => {
        try {
          invoke();
        } catch (error) {
          window.dispatchEvent(
            new window.ErrorEvent("error", {
              error,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
    } else invoke();
  };

  const handlerDescriptors: Array<{
    prototype: object;
    name: string;
    descriptor: PropertyDescriptor | undefined;
  }> = [];
  const handlers = new WeakMap<
    EventTarget,
    Map<string, { listener: EventListener; wrapper: EventListener }>
  >();
  for (const prototype of [
    NativeXMLHttpRequest.prototype,
    NativeXMLHttpRequestUpload.prototype,
  ]) {
    for (const name of [
      "onabort",
      "onerror",
      "onload",
      "onloadend",
      "onloadstart",
      "onprogress",
      "onreadystatechange",
      "ontimeout",
    ]) {
      let owner: object | null = prototype;
      let native: PropertyDescriptor | undefined;
      while (owner && !native) {
        native = Object.getOwnPropertyDescriptor(owner, name);
        owner = Object.getPrototypeOf(owner) as object | null;
      }
      if (!native?.get || !native.set) continue;
      const descriptor = native;
      handlerDescriptors.push({
        prototype,
        name,
        descriptor: Object.getOwnPropertyDescriptor(prototype, name),
      });
      Object.defineProperty(prototype, name, {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        get(this: EventTarget) {
          return handlers.get(this)?.get(name)?.listener ?? descriptor.get!.call(this);
        },
        set(this: EventTarget, value: EventListener | null) {
          let values = handlers.get(this);
          if (!values) {
            values = new Map();
            handlers.set(this, values);
          }
          if (typeof value !== "function") {
            values.delete(name);
            descriptor.set!.call(this, value);
            return;
          }
          const target = this;
          const wrapper: EventListener = (event) => {
            invokeNativeListener(target, value, event);
          };
          values.set(name, { listener: value, wrapper });
          descriptor.set!.call(this, wrapper);
        },
      });
    }
  }

  // Every listener goes through a wrapper so that teardown can mute a request
  // the guest still holds a reference to, without unregistering its listeners.
  const nativeEventRegistry = (
    target: EventTarget,
    nativeAddEventListener: typeof EventTarget.prototype.addEventListener,
    nativeRemoveEventListener: typeof EventTarget.prototype.removeEventListener,
  ): ListenerRegistry => {
    const existing = nativeEventRegistries.get(target);
    if (existing !== undefined) {
      return existing;
    }

    const registry = new ListenerRegistry({
      abortSignal,
      createWrapper: (listener) => (event) => {
        invokeNativeListener(target, listener, event);
      },
      addToTargets: (type, wrapper, options) => {
        nativeAddEventListener.call(target, type, wrapper, options);
      },
      removeFromTargets: (type, wrapper, capture) => {
        nativeRemoveEventListener.call(target, type, wrapper, capture);
      },
    });
    nativeEventRegistries.set(target, registry);
    return registry;
  };

  const patchNativeEventTarget = (
    prototype: EventTarget,
    nativeAddEventListener: typeof EventTarget.prototype.addEventListener,
    nativeRemoveEventListener: typeof EventTarget.prototype.removeEventListener,
  ) => {
    prototype.addEventListener = function addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      if (listener === null) {
        nativeAddEventListener.call(this, type, listener, options);
        return;
      }
      nativeEventRegistry(this, nativeAddEventListener, nativeRemoveEventListener).add(
        type,
        listener,
        options,
      );
    };
    prototype.removeEventListener = function removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      // A listener this registry never saw was registered natively — before
      // the patch, or on a target the patch does not own — so the native
      // implementation is still the one holding it.
      if (nativeEventRegistries.get(this)?.remove(type, listener, options) !== true) {
        nativeRemoveEventListener.call(this, type, listener, options);
      }
    };
  };

  const clearNativeEventHandlers = (target: XMLHttpRequest | XMLHttpRequestUpload) => {
    for (const name of [
      "onabort",
      "onerror",
      "onload",
      "onloadend",
      "onloadstart",
      "onprogress",
      "onreadystatechange",
      "ontimeout",
    ]) {
      (target as unknown as Record<string, unknown>)[name] = null;
    }
  };

  const disposeNativeXHR = (request: XMLHttpRequest) => {
    if (silencedNativeXHRS.has(request)) {
      return;
    }
    silencedNativeXHRS.add(request);
    clearNativeEventHandlers(request);
    clearNativeEventHandlers(request.upload);
    request.abort();
  };

  const registerNativeXHR = (request: XMLHttpRequest) => {
    const activeRequest = { dispose: () => disposeNativeXHR(request) };
    activeRequests.add(activeRequest);
    activeXHRSends.set(request, activeRequest);
    return activeRequest;
  };

  const isRequest = (input: unknown): input is Request => {
    if (nativeRequestURLGetter === undefined) {
      return false;
    }
    try {
      Reflect.apply(nativeRequestURLGetter, input, []);
      return true;
    } catch {
      return false;
    }
  };

  const forwardedRequestArguments = (
    input: Request | string,
    init: RequestInit | null | undefined,
    requestInput: boolean,
  ): [Request | string, RequestInit] => {
    // Normalize a Request's caller-supplied options before injecting ours:
    // native conversion decides whether an empty dictionary inherits referrer
    // metadata, or a nonempty one resets it, and whether signal:null severs it.
    const normalizeInput = requestInput && init != null;
    const request = requestInput
      ? normalizeInput
        ? new NativeRequest(input, init)
        : (input as Request)
      : undefined;
    const suppliedInit = normalizeInput ? undefined : init;
    // Let native dictionary conversion read inherited/non-enumerable fields in
    // its usual order, with getters bound to the original options object. A
    // spread would drop those fields and evaluate unrelated enumerable getters.
    // An empty target also avoids Proxy invariants on frozen init properties.
    const forwarded = new window.Proxy(
      window.Object.create(suppliedInit ?? null) as RequestInit,
      {
        get(_target, key) {
          const value: unknown =
            suppliedInit == null ? undefined : Reflect.get(suppliedInit, key);
          if (key === "credentials") {
            return value === undefined
              ? (request?.credentials ?? options.credentials)
              : value;
          }
          if (key === "signal") {
            return combinedSignal(
              window,
              options.signal,
              (value === undefined ? request?.signal : value) as
                | AbortSignal
                | null
                | undefined,
            );
          }
          if ((key === "referrer" || key === "referrerPolicy") && value === undefined) {
            return request?.[key];
          }
          return value;
        },
      },
    );
    return [request ?? input, forwarded];
  };

  class VFrameRequest extends NativeRequest {
    constructor(...argumentsList: [] | ConstructorParameters<typeof NativeRequest>) {
      if (argumentsList.length === 0) {
        super(
          ...(argumentsList as unknown as ConstructorParameters<typeof NativeRequest>),
        );
        return;
      }

      const [input, init] = argumentsList;
      const requestInput = isRequest(input);
      const resolvedInput = requestInput
        ? input
        : resolveNetworkURL(window, input, options.getBaseURL());
      super(...forwardedRequestArguments(resolvedInput, init, requestInput));
    }
  }

  Object.defineProperty(VFrameRequest, "name", { value: "Request" });

  remember(window, "Request");
  Object.defineProperty(window, "Request", {
    configurable: true,
    writable: true,
    value: VFrameRequest,
  });

  remember(window, "fetch");
  Object.defineProperty(window, "fetch", {
    configurable: true,
    writable: true,
    value(...argumentsList: [] | Parameters<typeof window.fetch>) {
      if (argumentsList.length === 0) {
        return Reflect.apply(nativeFetch, window, argumentsList);
      }

      const [input, init] = argumentsList;
      const requestInput = isRequest(input);
      try {
        const resolvedInput = requestInput
          ? input
          : resolveNetworkURL(window, input, options.getBaseURL());
        return nativeFetch(
          ...forwardedRequestArguments(resolvedInput, init, requestInput),
        );
      } catch (error) {
        // Native fetch never throws synchronously.
        return window.Promise.reject(error);
      }
    },
  });

  if (options.credentials === "include" && nativeXHRWithCredentialsSetter !== undefined) {
    Object.defineProperty(NativeXMLHttpRequest.prototype, "withCredentials", {
      ...nativeXHRWithCredentials,
      set(value: boolean) {
        Reflect.apply(nativeXHRWithCredentialsSetter, this, [value]);
        nativeXHRCredentialsAssigned.add(this);
      },
    });
  }
  patchNativeEventTarget(
    NativeXMLHttpRequest.prototype,
    nativeXHRAddEventListener,
    nativeXHRRemoveEventListener,
  );
  patchNativeEventTarget(
    NativeXMLHttpRequestUpload.prototype,
    nativeXHRUploadAddEventListener,
    nativeXHRUploadRemoveEventListener,
  );
  NativeXMLHttpRequest.prototype.open = function open(...argumentsList: unknown[]): void {
    if (argumentsList.length < 2) {
      throw new window.TypeError("XMLHttpRequest.open requires method and URL arguments");
    }

    const previousRequest = activeXHRSends.get(this);
    const nativeArguments = [...argumentsList];
    try {
      nativeArguments[1] = resolveNetworkURL(
        window,
        argumentsList[1],
        options.getBaseURL(),
      );
    } catch {
      throw new window.DOMException(
        `XMLHttpRequest could not resolve URL ${JSON.stringify(String(argumentsList[1]))} against ${JSON.stringify(options.getBaseURL())}`,
        "SyntaxError",
      );
    }
    Reflect.apply(nativeXHROpen, this, nativeArguments);
    if (previousRequest !== undefined) {
      activeRequests.delete(previousRequest);
      if (activeXHRSends.get(this) === previousRequest) {
        activeXHRSends.delete(this);
      }
    }
    registerNativeXHR(this);
    nativeXHRAsync.set(
      this,
      argumentsList[2] === undefined ? true : Boolean(argumentsList[2]),
    );
  };

  NativeXMLHttpRequest.prototype.send = function send(
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    if (
      options.credentials === "include" &&
      nativeXHRWithCredentialsSetter !== undefined &&
      !nativeXHRCredentialsAssigned.has(this)
    ) {
      Reflect.apply(nativeXHRWithCredentialsSetter, this, [true]);
    }
    nativeXHRUploads.set(this.upload, this);
    const inFlightRequest = activeXHRSends.get(this);
    const request = inFlightRequest ?? registerNativeXHR(this);
    const unregisterRequest = () => {
      this.removeEventListener("loadstart", listenForLoadStart);
      activeRequests.delete(request);
      if (activeXHRSends.get(this) === request) {
        activeXHRSends.delete(this);
      }
    };
    const listenForCompletion = () =>
      this.addEventListener("loadend", unregisterRequest, { once: true });
    const listenForLoadStart = () => {
      if (activeXHRSends.get(this) === request) {
        listenForCompletion();
      }
    };
    if (nativeXHRAsync.get(this) === false) {
      listenForCompletion();
    } else {
      this.addEventListener("loadstart", listenForLoadStart, { once: true });
    }
    try {
      nativeXHRSend.call(this, body);
    } catch (error) {
      // A send() rejected mid-flight (InvalidStateError) must not strip the
      // live request's teardown tracking.
      if (inFlightRequest === undefined) {
        unregisterRequest();
      } else {
        this.removeEventListener("loadstart", listenForLoadStart);
      }
      throw error;
    }
  };

  NativeXMLHttpRequest.prototype.abort = function abort(): void {
    explicitAborts.add(this);
    try {
      nativeXHRAbort.call(this);
    } finally {
      explicitAborts.delete(this);
    }
  };

  const wrapConstructor = (
    key: "WebSocket" | "EventSource" | "Worker" | "SharedWorker",
    transform: (argumentsList: unknown[]) => unknown[],
    disposeConnection: (connection: object) => void,
  ) => {
    const NativeConstructor = window[key] as unknown as new (
      ...argumentsList: never[]
    ) => object;
    if (NativeConstructor === undefined) {
      return;
    }

    remember(window, key);
    const WrappedConstructor = new Proxy(NativeConstructor, {
      construct(target, argumentsList, newTarget) {
        const connection = Reflect.construct(target, transform(argumentsList), newTarget);
        activeConnections.set(connection, () => disposeConnection(connection));
        const completionTarget = key === "SharedWorker" ? connection.port : connection;
        const completionMethod = key === "Worker" ? "terminate" : "close";
        const complete = completionTarget[completionMethod] as (
          ...args: unknown[]
        ) => unknown;
        Object.defineProperty(completionTarget, completionMethod, {
          configurable: true,
          writable: true,
          value(this: object, ...args: unknown[]) {
            const result = Reflect.apply(complete, this, args);
            if (this === completionTarget) {
              activeConnections.delete(connection);
            }
            return result;
          },
        });
        if (key === "WebSocket") {
          connection.addEventListener(
            "close",
            () => activeConnections.delete(connection),
            { once: true },
          );
        } else if (key === "EventSource") {
          connection.addEventListener("error", () => {
            if (connection.readyState === window.EventSource.CLOSED) {
              activeConnections.delete(connection);
            }
          });
        }
        return connection;
      },
    });
    Object.defineProperty(window, key, {
      configurable: true,
      writable: true,
      value: WrappedConstructor,
    });
  };

  wrapConstructor(
    "WebSocket",
    (argumentsList) => {
      if (argumentsList.length === 0) {
        return argumentsList;
      }

      const url = new window.URL(String(argumentsList[0]), options.getBaseURL());
      if (url.protocol === "http:") {
        url.protocol = "ws:";
      } else if (url.protocol === "https:") {
        url.protocol = "wss:";
      }
      return [url.href, ...argumentsList.slice(1)];
    },
    (connection) => {
      (connection as WebSocket).close();
    },
  );

  wrapConstructor(
    "EventSource",
    (argumentsList) => {
      if (argumentsList.length === 0) {
        return argumentsList;
      }

      return [
        resolveNetworkURL(window, argumentsList[0], options.getBaseURL()),
        eventSourceOptions(argumentsList[1], options.credentials),
        ...argumentsList.slice(2),
      ];
    },
    (connection) => {
      (connection as EventSource).close();
    },
  );
  wrapConstructor(
    "Worker",
    (argumentsList) => {
      if (argumentsList.length === 0) {
        return argumentsList;
      }

      return [
        resolveNetworkURL(window, argumentsList[0], options.getBaseURL()),
        workerOptions(argumentsList[1], options.credentials),
        ...argumentsList.slice(2),
      ];
    },
    (connection) => {
      (connection as Worker).terminate();
    },
  );
  wrapConstructor(
    "SharedWorker",
    (argumentsList) => {
      if (argumentsList.length === 0) {
        return argumentsList;
      }

      return [
        resolveNetworkURL(window, argumentsList[0], options.getBaseURL()),
        sharedWorkerOptions(argumentsList[1], options.credentials),
        ...argumentsList.slice(2),
      ];
    },
    (connection) => {
      (connection as SharedWorker).port.close();
    },
  );

  const navigator = window.navigator;
  const nativeSendBeacon = navigator.sendBeacon?.bind(navigator);
  if (nativeSendBeacon !== undefined) {
    remember(navigator, "sendBeacon");
    Object.defineProperty(navigator, "sendBeacon", {
      configurable: true,
      writable: true,
      value(...argumentsList: unknown[]) {
        if (argumentsList.length === 0) {
          return Reflect.apply(nativeSendBeacon, navigator, argumentsList);
        }

        const nativeArguments = [...argumentsList];
        nativeArguments[0] = resolveNetworkURL(
          window,
          argumentsList[0],
          options.getBaseURL(),
        );
        return Reflect.apply(nativeSendBeacon, navigator, nativeArguments);
      },
    });
  }

  const disposeRequests = () => {
    while (activeRequests.size > 0) {
      const request = activeRequests.values().next().value;
      if (request === undefined) {
        return;
      }
      activeRequests.delete(request);
      request.dispose();
    }
  };
  const disposeConnections = () => {
    for (const [, disposeConnection] of activeConnections) {
      disposeConnection();
    }
    activeConnections.clear();
  };
  const disposeNetwork = () => {
    disposed = true;
    disposeRequests();
    disposeConnections();
  };
  options.signal.addEventListener("abort", disposeNetwork, { once: true });

  return () => {
    options.signal.removeEventListener("abort", disposeNetwork);
    disposeNetwork();
    for (const { prototype, name, descriptor } of handlerDescriptors) {
      if (descriptor) Object.defineProperty(prototype, name, descriptor);
      else delete (prototype as Record<string, unknown>)[name];
    }
    NativeXMLHttpRequest.prototype.open = nativeXHROpen;
    NativeXMLHttpRequest.prototype.send = nativeXHRSend;
    NativeXMLHttpRequest.prototype.abort = nativeXHRAbort;
    NativeXMLHttpRequest.prototype.addEventListener = nativeXHRAddEventListener;
    NativeXMLHttpRequest.prototype.removeEventListener = nativeXHRRemoveEventListener;
    NativeXMLHttpRequestUpload.prototype.addEventListener =
      nativeXHRUploadAddEventListener;
    NativeXMLHttpRequestUpload.prototype.removeEventListener =
      nativeXHRUploadRemoveEventListener;
    if (nativeXHRWithCredentials !== undefined) {
      Object.defineProperty(
        NativeXMLHttpRequest.prototype,
        "withCredentials",
        nativeXHRWithCredentials,
      );
    }

    for (const [key, descriptor] of originals) {
      const target = key === "sendBeacon" ? navigator : window;
      if (descriptor === undefined) {
        delete (target as unknown as Record<PropertyKey, unknown>)[key];
      } else {
        Object.defineProperty(target, key, descriptor);
      }
    }
  };
}
