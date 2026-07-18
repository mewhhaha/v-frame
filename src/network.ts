import { createCredentiallessXMLHttpRequest } from "./credentialless-xhr.js";
import type { VFrameCredentials, VFrameWindow } from "./types.js";

export interface NetworkPatchOptions {
  window: VFrameWindow;
  signal: AbortSignal;
  credentials: VFrameCredentials;
  getBaseURL(): string;
}

interface NativeEventListenerRegistration {
  listener: EventListenerOrEventListenerObject;
  wrapper: EventListener;
  capture: boolean;
}

function eventListenerCapture(options: boolean | EventListenerOptions | undefined): boolean {
  return typeof options === "boolean" ? options : options?.capture ?? false;
}

function resolveNetworkURL(window: VFrameWindow, value: unknown, baseURL: string): string {
  return new window.URL(String(value), baseURL).href;
}

function combinedSignal(window: VFrameWindow, left: AbortSignal, right?: AbortSignal | null): AbortSignal {
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

function eventSourceOptions(value: unknown, credentials: VFrameCredentials): EventSourceInit {
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

function sharedWorkerOptions(value: unknown, credentials: VFrameCredentials): WorkerOptions {
  if (typeof value === "string") {
    return { name: value, credentials };
  }
  return workerOptions(value, credentials);
}

export function installNetworkPatches(options: NetworkPatchOptions): () => void {
  const window = options.window;
  const nativeFetch = window.fetch.bind(window);
  const NativeRequest = window.Request;
  const nativeRequestClone = NativeRequest.prototype.clone;
  const nativeRequestURLGetter = Object.getOwnPropertyDescriptor(NativeRequest.prototype, "url")?.get;
  const NativeXMLHttpRequest = window.XMLHttpRequest;
  const nativeXHROpen = NativeXMLHttpRequest.prototype.open;
  const nativeXHRSend = NativeXMLHttpRequest.prototype.send;
  const nativeXHRAddEventListener = NativeXMLHttpRequest.prototype.addEventListener;
  const nativeXHRRemoveEventListener = NativeXMLHttpRequest.prototype.removeEventListener;
  const NativeXMLHttpRequestUpload = window.XMLHttpRequestUpload;
  const nativeXHRUploadAddEventListener = NativeXMLHttpRequestUpload.prototype.addEventListener;
  const nativeXHRUploadRemoveEventListener = NativeXMLHttpRequestUpload.prototype.removeEventListener;
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
  const nativeEventListeners = new WeakMap<EventTarget, Map<string, NativeEventListenerRegistration[]>>();
  const activeConnections = new Map<object, () => void>();
  const originals = new Map<PropertyKey, PropertyDescriptor | undefined>();

  const remember = (target: object, key: PropertyKey) => {
    originals.set(key, Object.getOwnPropertyDescriptor(target, key));
  };

  const nativeEventTargetIsSilenced = (target: EventTarget): boolean => {
    if (target instanceof NativeXMLHttpRequest) {
      return silencedNativeXHRS.has(target);
    }
    const request = nativeXHRUploads.get(target as XMLHttpRequestUpload);
    return request !== undefined && silencedNativeXHRS.has(request);
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
      const capture = eventListenerCapture(options);
      const registrations = nativeEventListeners.get(this) ?? new Map<string, NativeEventListenerRegistration[]>();
      const listeners = registrations.get(type) ?? [];
      let registration = listeners.find((registered) => registered.listener === listener && registered.capture === capture);
      if (registration === undefined) {
        const wrapper: EventListener = (event) => {
          if (nativeEventTargetIsSilenced(this)) {
            return;
          }
          if (typeof listener === "function") {
            listener.call(this, event);
            return;
          }
          listener.handleEvent(event);
        };
        registration = { listener, wrapper, capture };
        listeners.push(registration);
        registrations.set(type, listeners);
        nativeEventListeners.set(this, registrations);
      }
      nativeAddEventListener.call(this, type, registration.wrapper, options);
    };
    prototype.removeEventListener = function removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      if (listener === null) {
        nativeRemoveEventListener.call(this, type, listener, options);
        return;
      }
      const registrations = nativeEventListeners.get(this);
      const capture = eventListenerCapture(options);
      const listeners = registrations?.get(type);
      const registration = listeners?.find((registered) => registered.listener === listener && registered.capture === capture);
      if (registration === undefined) {
        nativeRemoveEventListener.call(this, type, listener, options);
        return;
      }
      nativeRemoveEventListener.call(this, type, registration.wrapper, options);
      const remaining = listeners?.filter((registered) => registered !== registration) ?? [];
      if (remaining.length === 0) {
        registrations?.delete(type);
      } else {
        registrations?.set(type, remaining);
      }
    };
  };

  const clearNativeEventHandlers = (target: XMLHttpRequest | XMLHttpRequestUpload) => {
    for (const name of ["onabort", "onerror", "onload", "onloadend", "onloadstart", "onprogress", "onreadystatechange", "ontimeout"]) {
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

  const cloneRequest = (input: Request): Request =>
    Reflect.apply(nativeRequestClone, input, []) as Request;

  // The injected init is never empty, which would reset a Request input's
  // referrer metadata to its defaults and re-attach an explicitly severed
  // signal, so both are forwarded explicitly unless the caller overrides them.
  const forwardedRequestInit = (
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    requestInput: boolean,
  ): RequestInit => {
    const forwarded: RequestInit = {
      ...init,
      credentials:
        init?.credentials ??
        (requestInput && isRequest(input) ? input.credentials : options.credentials),
      signal: combinedSignal(
        window,
        options.signal,
        init !== undefined && "signal" in init
          ? init.signal ?? undefined
          : requestInput && isRequest(input)
            ? input.signal
            : undefined,
      ),
    };
    if (requestInput && isRequest(input)) {
      if (init === undefined || !("referrer" in init)) {
        forwarded.referrer = input.referrer;
      }
      if (init === undefined || !("referrerPolicy" in init)) {
        forwarded.referrerPolicy = input.referrerPolicy;
      }
    }
    return forwarded;
  };

  class VFrameRequest extends NativeRequest {
    constructor(...argumentsList: [] | ConstructorParameters<typeof NativeRequest>) {
      if (argumentsList.length === 0) {
        super(...(argumentsList as unknown as ConstructorParameters<typeof NativeRequest>));
        return;
      }

      const [input, init] = argumentsList;
      const requestInput = isRequest(input);
      const resolvedInput = requestInput
        ? input
        : resolveNetworkURL(window, input, options.getBaseURL());
      super(resolvedInput, forwardedRequestInit(input, init, requestInput));
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
      let resolvedInput: Request | string;
      try {
        resolvedInput = requestInput
          ? cloneRequest(input)
          : resolveNetworkURL(window, input, options.getBaseURL());
      } catch (error) {
        // Native fetch never throws synchronously.
        return Promise.reject(error);
      }

      return nativeFetch(resolvedInput, forwardedRequestInit(input, init, requestInput));
    },
  });

  if (options.credentials === "omit") {
    const CredentiallessXMLHttpRequest = createCredentiallessXMLHttpRequest({
      window,
      fetch: nativeFetch,
      generationSignal: options.signal,
      getBaseURL: options.getBaseURL,
      registerActive(request) {
        activeRequests.add(request);
      },
      unregisterActive(request) {
        activeRequests.delete(request);
      },
    });
    remember(window, "XMLHttpRequest");
    Object.defineProperty(window, "XMLHttpRequest", {
      configurable: true,
      writable: true,
      value: CredentiallessXMLHttpRequest,
    });
  } else {
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
        nativeArguments[1] = resolveNetworkURL(window, argumentsList[1], options.getBaseURL());
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
      nativeXHRAsync.set(this, argumentsList[2] === undefined ? true : Boolean(argumentsList[2]));
    };

    NativeXMLHttpRequest.prototype.send = function send(body?: Document | XMLHttpRequestBodyInit | null): void {
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
      const listenForCompletion = () => this.addEventListener("loadend", unregisterRequest, { once: true });
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
  }

  const wrapConstructor = (
    key: "WebSocket" | "EventSource" | "Worker" | "SharedWorker",
    transform: (argumentsList: unknown[]) => unknown[],
    disposeConnection: (connection: object) => void,
  ) => {
    const NativeConstructor = window[key] as unknown as new (...argumentsList: never[]) => object;
    if (NativeConstructor === undefined) {
      return;
    }

    remember(window, key);
    const WrappedConstructor = new Proxy(NativeConstructor, {
      construct(target, argumentsList, newTarget) {
        const connection = Reflect.construct(target, transform(argumentsList), newTarget);
        activeConnections.set(connection, () => disposeConnection(connection));
        return connection;
      },
    });
    Object.defineProperty(window, key, {
      configurable: true,
      writable: true,
      value: WrappedConstructor,
    });
  };

  wrapConstructor("WebSocket", (argumentsList) => {
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
  }, (connection) => {
    (connection as WebSocket).close();
  });

  wrapConstructor("EventSource", (argumentsList) => {
    if (argumentsList.length === 0) {
      return argumentsList;
    }

    return [
      resolveNetworkURL(window, argumentsList[0], options.getBaseURL()),
      eventSourceOptions(argumentsList[1], options.credentials),
      ...argumentsList.slice(2),
    ];
  }, (connection) => {
    (connection as EventSource).close();
  });
  wrapConstructor("Worker", (argumentsList) => {
    if (argumentsList.length === 0) {
      return argumentsList;
    }

    return [
      resolveNetworkURL(window, argumentsList[0], options.getBaseURL()),
      workerOptions(argumentsList[1], options.credentials),
      ...argumentsList.slice(2),
    ];
  }, (connection) => {
    (connection as Worker).terminate();
  });
  wrapConstructor("SharedWorker", (argumentsList) => {
    if (argumentsList.length === 0) {
      return argumentsList;
    }

    return [
      resolveNetworkURL(window, argumentsList[0], options.getBaseURL()),
      sharedWorkerOptions(argumentsList[1], options.credentials),
      ...argumentsList.slice(2),
    ];
  }, (connection) => {
    (connection as SharedWorker).port.close();
  });

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
        nativeArguments[0] = resolveNetworkURL(window, argumentsList[0], options.getBaseURL());
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
    for (const disposeConnection of activeConnections.values()) {
      disposeConnection();
    }
    activeConnections.clear();
  };
  const disposeNetwork = () => {
    disposeRequests();
    disposeConnections();
  };
  options.signal.addEventListener("abort", disposeNetwork, { once: true });

  return () => {
    options.signal.removeEventListener("abort", disposeNetwork);
    disposeNetwork();
    if (options.credentials !== "omit") {
      NativeXMLHttpRequest.prototype.open = nativeXHROpen;
      NativeXMLHttpRequest.prototype.send = nativeXHRSend;
      NativeXMLHttpRequest.prototype.addEventListener = nativeXHRAddEventListener;
      NativeXMLHttpRequest.prototype.removeEventListener = nativeXHRRemoveEventListener;
      NativeXMLHttpRequestUpload.prototype.addEventListener = nativeXHRUploadAddEventListener;
      NativeXMLHttpRequestUpload.prototype.removeEventListener = nativeXHRUploadRemoveEventListener;
      if (nativeXHRWithCredentials !== undefined) {
        Object.defineProperty(NativeXMLHttpRequest.prototype, "withCredentials", nativeXHRWithCredentials);
      }
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
