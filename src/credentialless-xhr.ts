import type { VFrameWindow } from "./types.js";

interface DisposableRequest {
  dispose(): void;
}

interface RegisteredEventListener {
  listener: EventListenerOrEventListenerObject;
  options: boolean | AddEventListenerOptions | undefined;
}

interface RequestBody {
  body: BodyInit | null;
  contentType: string | null;
  uploadSize: number | null;
}

interface ProgressValues {
  lengthComputable: boolean;
  loaded: number;
  total: number;
}

export interface CredentiallessXMLHttpRequestOptions {
  window: VFrameWindow;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  generationSignal: AbortSignal;
  getBaseURL(): string;
  createHTML(source: string): string;
  registerActive(request: DisposableRequest): void;
  unregisterActive(request: DisposableRequest): void;
}

type ResponseType = "" | "text" | "json" | "arraybuffer" | "blob" | "document";
type EventHandler = ((this: XMLHttpRequest, event: Event) => unknown) | null;
type UploadEventHandler = ((this: XMLHttpRequestUpload, event: Event) => unknown) | null;

function isXMLMimeType(mimeType: string): boolean {
  return /(?:^|\/)xml(?:;|$)|\+xml(?:;|$)/iu.test(mimeType);
}

function isHTMLMimeType(mimeType: string): boolean {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() === "text/html";
}

function responseCharset(mimeType: string): string | undefined {
  const match = /charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/iu.exec(mimeType);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function decodeResponseBody(
  window: VFrameWindow,
  body: ArrayBuffer,
  mimeType: string,
): string {
  const charset = responseCharset(mimeType);
  if (charset === undefined) {
    return new window.TextDecoder().decode(body);
  }

  try {
    return new window.TextDecoder(charset).decode(body);
  } catch {
    return new window.TextDecoder().decode(body);
  }
}

function uploadSize(window: VFrameWindow, body: BodyInit): number | null {
  if (typeof body === "string") {
    return new window.TextEncoder().encode(body).byteLength;
  }
  if (body instanceof window.Blob) {
    return body.size;
  }
  if (body instanceof window.ArrayBuffer) {
    return body.byteLength;
  }
  if (ArrayBuffer.isView(body)) {
    return body.byteLength;
  }
  if (body instanceof window.URLSearchParams) {
    return new window.TextEncoder().encode(body.toString()).byteLength;
  }
  return null;
}

function requestBodyForFetch(
  window: VFrameWindow,
  body: Document | XMLHttpRequestBodyInit | null | undefined,
): RequestBody {
  if (body === undefined || body === null) {
    return { body: null, contentType: null, uploadSize: null };
  }
  if (body instanceof window.Document) {
    const source = new window.XMLSerializer().serializeToString(body);
    return {
      body: source,
      contentType:
        body.contentType === "text/html"
          ? "text/html;charset=UTF-8"
          : "application/xml;charset=UTF-8",
      uploadSize: new window.TextEncoder().encode(source).byteLength,
    };
  }
  return { body, contentType: null, uploadSize: uploadSize(window, body) };
}

function normalizedRequestMethod(window: VFrameWindow, method: string): string {
  const suppliedMethod = String(method);
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(suppliedMethod)) {
    throw new window.DOMException(
      `XMLHttpRequest method ${JSON.stringify(suppliedMethod)} is not a valid HTTP token`,
      "SyntaxError",
    );
  }

  const uppercaseMethod = suppliedMethod.toUpperCase();
  if (["DELETE", "GET", "HEAD", "OPTIONS", "POST", "PUT"].includes(uppercaseMethod)) {
    return uppercaseMethod;
  }
  return suppliedMethod;
}

function progressValues(loaded: number, total: number | null): ProgressValues {
  // The spec computes length only when it is known AND not zero.
  return total === null || total === 0
    ? { lengthComputable: false, loaded, total: 0 }
    : { lengthComputable: true, loaded, total };
}

function responseProgress(response: Response, bodySize: number): ProgressValues {
  const contentLength = response.headers.get("content-length");
  if (contentLength === null || !/^\d+$/u.test(contentLength)) {
    return progressValues(bodySize, null);
  }
  const total = Number(contentLength);
  return Number.isSafeInteger(total)
    ? progressValues(bodySize, total)
    : progressValues(bodySize, null);
}

/**
 * Builds the XHR replacement used in an `omit` realm. Native same-origin XHR
 * always includes ambient cookies, so this intentionally routes every request
 * through fetch with `credentials: "omit"`.
 */
export function createCredentiallessXMLHttpRequest(
  options: CredentiallessXMLHttpRequestOptions,
): typeof XMLHttpRequest {
  const { window } = options;
  const EventTargetBase = window.EventTarget;

  class CredentiallessXMLHttpRequestUpload extends EventTargetBase {
    #eventHandlers = new Map<string, EventListener>();
    #eventHandlerValues = new Map<string, UploadEventHandler>();
    #eventListeners = new Map<string, RegisteredEventListener[]>();

    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      super.addEventListener(type, listener, options);
      if (listener === null) {
        return;
      }
      const listeners = this.#eventListeners.get(type) ?? [];
      listeners.push({ listener, options });
      this.#eventListeners.set(type, listeners);
    }

    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      super.removeEventListener(type, listener, options);
      if (listener === null) {
        return;
      }
      const listeners = this.#eventListeners.get(type);
      if (listeners === undefined) {
        return;
      }
      const capture =
        typeof options === "boolean" ? options : (options?.capture ?? false);
      const remaining = listeners.filter(
        (registered) =>
          registered.listener !== listener ||
          (typeof registered.options === "boolean"
            ? registered.options
            : (registered.options?.capture ?? false)) !== capture,
      );
      if (remaining.length === 0) {
        this.#eventListeners.delete(type);
        return;
      }
      this.#eventListeners.set(type, remaining);
    }

    get onloadstart(): UploadEventHandler {
      return this.#eventHandlerValues.get("loadstart") ?? null;
    }

    set onloadstart(listener: UploadEventHandler) {
      this.#setEventHandler("loadstart", listener);
    }

    get onprogress(): UploadEventHandler {
      return this.#eventHandlerValues.get("progress") ?? null;
    }

    set onprogress(listener: UploadEventHandler) {
      this.#setEventHandler("progress", listener);
    }

    get onabort(): UploadEventHandler {
      return this.#eventHandlerValues.get("abort") ?? null;
    }

    set onabort(listener: UploadEventHandler) {
      this.#setEventHandler("abort", listener);
    }

    get onerror(): UploadEventHandler {
      return this.#eventHandlerValues.get("error") ?? null;
    }

    set onerror(listener: UploadEventHandler) {
      this.#setEventHandler("error", listener);
    }

    get onload(): UploadEventHandler {
      return this.#eventHandlerValues.get("load") ?? null;
    }

    set onload(listener: UploadEventHandler) {
      this.#setEventHandler("load", listener);
    }

    get ontimeout(): UploadEventHandler {
      return this.#eventHandlerValues.get("timeout") ?? null;
    }

    set ontimeout(listener: UploadEventHandler) {
      this.#setEventHandler("timeout", listener);
    }

    get onloadend(): UploadEventHandler {
      return this.#eventHandlerValues.get("loadend") ?? null;
    }

    set onloadend(listener: UploadEventHandler) {
      this.#setEventHandler("loadend", listener);
    }

    #setEventHandler(type: string, listener: UploadEventHandler): void {
      const previous = this.#eventHandlers.get(type);
      if (previous !== undefined) {
        this.removeEventListener(type, previous);
        this.#eventHandlers.delete(type);
      }

      if (typeof listener !== "function") {
        this.#eventHandlerValues.set(type, null);
        return;
      }

      const registered: EventListener = (event) =>
        listener.call(this as unknown as XMLHttpRequestUpload, event);
      this.#eventHandlers.set(type, registered);
      this.#eventHandlerValues.set(type, listener);
      this.addEventListener(type, registered);
    }

    dispose(): void {
      for (const [type, listeners] of this.#eventListeners) {
        for (const { listener, options } of listeners) {
          super.removeEventListener(type, listener, options);
        }
      }
      this.#eventListeners.clear();
      this.#eventHandlers.clear();
      this.#eventHandlerValues.clear();
    }
  }

  class CredentiallessXMLHttpRequest extends EventTargetBase {
    static readonly UNSENT = 0;
    static readonly OPENED = 1;
    static readonly HEADERS_RECEIVED = 2;
    static readonly LOADING = 3;
    static readonly DONE = 4;

    readonly UNSENT = CredentiallessXMLHttpRequest.UNSENT;
    readonly OPENED = CredentiallessXMLHttpRequest.OPENED;
    readonly HEADERS_RECEIVED = CredentiallessXMLHttpRequest.HEADERS_RECEIVED;
    readonly LOADING = CredentiallessXMLHttpRequest.LOADING;
    readonly DONE = CredentiallessXMLHttpRequest.DONE;

    #readyState = CredentiallessXMLHttpRequest.UNSENT;
    #requestMethod = "";
    #requestURL = "";
    #requestHeaders = new window.Headers();
    #responseHeaders: Headers | null = null;
    #responseType: ResponseType = "";
    #responseValue: unknown = null;
    #responseText = "";
    #responseXML: Document | null = null;
    #responseURL = "";
    #status = 0;
    #statusText = "";
    #timeout = 0;
    #timeoutID: number | null = null;
    #requestStartedAt: number | null = null;
    #sendInProgress = false;
    #requestHasBody = false;
    #requestGeneration = 0;
    #abortController: AbortController | null = null;
    #activeRequest: DisposableRequest | null = null;
    #overrideMimeType: string | null = null;
    #withCredentials = false;
    #eventHandlers = new Map<string, EventListener>();
    #eventHandlerValues = new Map<string, EventHandler>();
    #eventListeners = new Map<string, RegisteredEventListener[]>();
    #upload = new CredentiallessXMLHttpRequestUpload();

    get readyState(): number {
      return this.#readyState;
    }

    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ): void {
      super.addEventListener(type, listener, options);
      if (listener === null) {
        return;
      }
      const listeners = this.#eventListeners.get(type) ?? [];
      listeners.push({ listener, options });
      this.#eventListeners.set(type, listeners);
    }

    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions,
    ): void {
      super.removeEventListener(type, listener, options);
      if (listener === null) {
        return;
      }
      const listeners = this.#eventListeners.get(type);
      if (listeners === undefined) {
        return;
      }
      const capture =
        typeof options === "boolean" ? options : (options?.capture ?? false);
      const remaining = listeners.filter(
        (registered) =>
          registered.listener !== listener ||
          (typeof registered.options === "boolean"
            ? registered.options
            : (registered.options?.capture ?? false)) !== capture,
      );
      if (remaining.length === 0) {
        this.#eventListeners.delete(type);
        return;
      }
      this.#eventListeners.set(type, remaining);
    }

    get responseType(): XMLHttpRequestResponseType {
      return this.#responseType;
    }

    set responseType(value: XMLHttpRequestResponseType) {
      if (
        this.#readyState === CredentiallessXMLHttpRequest.LOADING ||
        this.#readyState === CredentiallessXMLHttpRequest.DONE
      ) {
        throw this.#invalidState(
          "responseType cannot change after response loading begins",
        );
      }
      if (!["", "text", "json", "arraybuffer", "blob", "document"].includes(value)) {
        throw new window.TypeError(
          `XMLHttpRequest responseType ${JSON.stringify(value)} is not supported`,
        );
      }
      this.#responseType = value as ResponseType;
    }

    get response(): unknown {
      if (
        this.#readyState !== CredentiallessXMLHttpRequest.LOADING &&
        this.#readyState !== CredentiallessXMLHttpRequest.DONE
      ) {
        return null;
      }
      return this.#responseValue;
    }

    get responseText(): string {
      if (this.#responseType !== "" && this.#responseType !== "text") {
        throw this.#invalidState(
          `responseText is unavailable when responseType is ${JSON.stringify(this.#responseType)}`,
        );
      }
      if (
        this.#readyState !== CredentiallessXMLHttpRequest.LOADING &&
        this.#readyState !== CredentiallessXMLHttpRequest.DONE
      ) {
        return "";
      }
      return this.#responseText;
    }

    get responseXML(): Document | null {
      if (this.#responseType !== "" && this.#responseType !== "document") {
        throw this.#invalidState(
          `responseXML is unavailable when responseType is ${JSON.stringify(this.#responseType)}`,
        );
      }
      if (this.#readyState !== CredentiallessXMLHttpRequest.DONE) {
        return null;
      }
      return this.#responseXML;
    }

    get status(): number {
      return this.#status;
    }

    get statusText(): string {
      return this.#statusText;
    }

    get responseURL(): string {
      return this.#responseURL;
    }

    get timeout(): number {
      return this.#timeout;
    }

    set timeout(value: number) {
      if (!Number.isFinite(value) || value < 0) {
        throw new window.TypeError(
          `XMLHttpRequest timeout must be a non-negative finite number, received ${String(value)}`,
        );
      }
      this.#timeout = Math.floor(value);
      if (this.#sendInProgress) {
        this.#scheduleTimeout(this.#requestGeneration);
      }
    }

    get withCredentials(): boolean {
      return this.#withCredentials;
    }

    set withCredentials(value: boolean) {
      if (this.#sendInProgress) {
        throw this.#invalidState(
          "withCredentials cannot change while a request is in progress",
        );
      }
      // Keep the observable setting for compatibility, but never let it weaken
      // the component's `credentials="omit"` boundary.
      this.#withCredentials = Boolean(value);
    }

    get upload(): XMLHttpRequestUpload {
      return this.#upload as unknown as XMLHttpRequestUpload;
    }

    get onreadystatechange(): EventHandler {
      return this.#eventHandlerValues.get("readystatechange") ?? null;
    }

    set onreadystatechange(listener: EventHandler) {
      this.#setEventHandler("readystatechange", listener);
    }

    get onloadstart(): EventHandler {
      return this.#eventHandlerValues.get("loadstart") ?? null;
    }

    set onloadstart(listener: EventHandler) {
      this.#setEventHandler("loadstart", listener);
    }

    get onprogress(): EventHandler {
      return this.#eventHandlerValues.get("progress") ?? null;
    }

    set onprogress(listener: EventHandler) {
      this.#setEventHandler("progress", listener);
    }

    get onabort(): EventHandler {
      return this.#eventHandlerValues.get("abort") ?? null;
    }

    set onabort(listener: EventHandler) {
      this.#setEventHandler("abort", listener);
    }

    get onerror(): EventHandler {
      return this.#eventHandlerValues.get("error") ?? null;
    }

    set onerror(listener: EventHandler) {
      this.#setEventHandler("error", listener);
    }

    get onload(): EventHandler {
      return this.#eventHandlerValues.get("load") ?? null;
    }

    set onload(listener: EventHandler) {
      this.#setEventHandler("load", listener);
    }

    get ontimeout(): EventHandler {
      return this.#eventHandlerValues.get("timeout") ?? null;
    }

    set ontimeout(listener: EventHandler) {
      this.#setEventHandler("timeout", listener);
    }

    get onloadend(): EventHandler {
      return this.#eventHandlerValues.get("loadend") ?? null;
    }

    set onloadend(listener: EventHandler) {
      this.#setEventHandler("loadend", listener);
    }

    open(...argumentsList: unknown[]): void {
      if (argumentsList.length < 2) {
        throw new window.TypeError(
          "XMLHttpRequest.open requires method and URL arguments",
        );
      }

      const [method, url, suppliedAsync, username, password] = argumentsList;
      const async = suppliedAsync === undefined ? true : Boolean(suppliedAsync);
      if (!async) {
        throw new window.DOMException(
          "Synchronous XMLHttpRequest is not supported when component credentials are omitted",
          "NotSupportedError",
        );
      }
      if (username !== undefined || password !== undefined) {
        throw new window.DOMException(
          "XMLHttpRequest username and password are not supported by the credentialless transport",
          "NotSupportedError",
        );
      }

      const requestMethod = normalizedRequestMethod(window, String(method));
      if (["CONNECT", "TRACE", "TRACK"].includes(requestMethod.toUpperCase())) {
        throw new window.DOMException(
          `XMLHttpRequest method ${JSON.stringify(requestMethod)} is not permitted`,
          "SecurityError",
        );
      }

      let requestURL: string;
      try {
        requestURL = new window.URL(String(url), options.getBaseURL()).href;
      } catch {
        throw new window.DOMException(
          `XMLHttpRequest could not resolve URL ${JSON.stringify(String(url))} against ${JSON.stringify(options.getBaseURL())}`,
          "SyntaxError",
        );
      }

      const wasOpened = this.#readyState === CredentiallessXMLHttpRequest.OPENED;
      this.#terminateActiveRequest();
      this.#requestMethod = requestMethod;
      this.#requestURL = requestURL;
      this.#requestHeaders = new window.Headers();
      this.#overrideMimeType = null;
      this.#resetResponse();
      this.#readyState = CredentiallessXMLHttpRequest.OPENED;
      // Reopening an already-opened request keeps its state, so no event fires.
      if (!wasOpened) {
        this.#dispatch("readystatechange");
      }
    }

    setRequestHeader(name: string, value: string): void {
      if (
        this.#readyState !== CredentiallessXMLHttpRequest.OPENED ||
        this.#sendInProgress
      ) {
        throw this.#invalidState(
          "setRequestHeader requires an opened request before send()",
        );
      }
      try {
        this.#requestHeaders.append(name, value);
      } catch {
        throw new window.DOMException(
          `XMLHttpRequest request header ${JSON.stringify(name)} is invalid`,
          "SyntaxError",
        );
      }
    }

    overrideMimeType(mimeType: string): void {
      if (
        this.#readyState === CredentiallessXMLHttpRequest.LOADING ||
        this.#readyState === CredentiallessXMLHttpRequest.DONE
      ) {
        throw this.#invalidState(
          "overrideMimeType cannot run after response loading begins",
        );
      }
      this.#overrideMimeType = String(mimeType);
    }

    getResponseHeader(name: string): string | null {
      if (this.#responseHeaders === null) {
        return null;
      }
      try {
        return this.#responseHeaders.get(name);
      } catch {
        return null;
      }
    }

    getAllResponseHeaders(): string {
      if (this.#responseHeaders === null) {
        return "";
      }
      let headers = "";
      this.#responseHeaders.forEach((value, name) => {
        headers += `${name}: ${value}\r\n`;
      });
      return headers;
    }

    send(body?: Document | XMLHttpRequestBodyInit | null): void {
      if (this.#readyState !== CredentiallessXMLHttpRequest.OPENED) {
        throw this.#invalidState("send() requires open() to run first");
      }
      if (this.#sendInProgress) {
        throw this.#invalidState(
          "send() cannot run more than once for the same opened request",
        );
      }

      const request = /^(GET|HEAD)$/u.test(this.#requestMethod)
        ? { body: null, contentType: null, uploadSize: null }
        : requestBodyForFetch(window, body);
      if (request.contentType !== null && !this.#requestHeaders.has("content-type")) {
        this.#requestHeaders.set("content-type", request.contentType);
      }
      this.#sendInProgress = true;
      this.#requestHasBody = request.body !== null;
      const requestGeneration = ++this.#requestGeneration;
      const abortController = new window.AbortController();
      this.#abortController = abortController;
      this.#requestStartedAt = window.performance.now();
      const activeRequest: DisposableRequest = {
        dispose: () => this.#disposeRequest(requestGeneration),
      };
      this.#activeRequest = activeRequest;
      options.registerActive(activeRequest);

      this.#dispatch("loadstart");
      if (this.#requestHasBody) {
        this.#dispatchUpload("loadstart", progressValues(0, request.uploadSize));
      }

      if (options.generationSignal.aborted) {
        this.abort();
        return;
      }

      this.#scheduleTimeout(requestGeneration);

      void this.#sendRequest(
        requestGeneration,
        request.body,
        request.uploadSize,
        abortController.signal,
      );
    }

    abort(): void {
      if (this.#sendInProgress) {
        this.#abortRequest(this.#requestGeneration);
        return;
      }
      if (this.#readyState === CredentiallessXMLHttpRequest.DONE) {
        this.#resetResponse();
        this.#readyState = CredentiallessXMLHttpRequest.UNSENT;
      }
    }

    #setEventHandler(type: string, listener: EventHandler): void {
      const previous = this.#eventHandlers.get(type);
      if (previous !== undefined) {
        this.removeEventListener(type, previous);
        this.#eventHandlers.delete(type);
      }

      if (typeof listener !== "function") {
        this.#eventHandlerValues.set(type, null);
        return;
      }

      const registered: EventListener = (event) =>
        listener.call(this as unknown as XMLHttpRequest, event);
      this.#eventHandlers.set(type, registered);
      this.#eventHandlerValues.set(type, listener);
      this.addEventListener(type, registered);
    }

    async #sendRequest(
      requestGeneration: number,
      body: BodyInit | null,
      requestUploadSize: number | null,
      signal: AbortSignal,
    ): Promise<void> {
      try {
        const response = await options.fetch(this.#requestURL, {
          method: this.#requestMethod,
          headers: this.#requestHeaders,
          body,
          credentials: "omit",
          signal,
        });
        if (!this.#isCurrentRequest(requestGeneration)) {
          return;
        }

        // The request body is fully transmitted once the response arrives, so
        // upload events complete before HEADERS_RECEIVED, matching native XHR.
        if (this.#requestHasBody) {
          // The upload-complete flag is set before the terminal upload events,
          // so a later failure cannot re-fire them via the request-error steps.
          this.#requestHasBody = false;
          const completedUpload = progressValues(
            requestUploadSize ?? 0,
            requestUploadSize,
          );
          this.#dispatchUpload("progress", completedUpload);
          if (!this.#isCurrentRequest(requestGeneration)) {
            return;
          }
          this.#dispatchUpload("load", completedUpload);
          if (!this.#isCurrentRequest(requestGeneration)) {
            return;
          }
          this.#dispatchUpload("loadend", completedUpload);
          if (!this.#isCurrentRequest(requestGeneration)) {
            return;
          }
        }

        this.#responseHeaders = response.headers;
        this.#responseURL = response.url;
        this.#status = response.status;
        this.#statusText = response.statusText;
        this.#readyState = CredentiallessXMLHttpRequest.HEADERS_RECEIVED;
        this.#dispatch("readystatechange");
        if (!this.#isCurrentRequest(requestGeneration)) {
          return;
        }

        const responseBody = await response.arrayBuffer();
        if (!this.#isCurrentRequest(requestGeneration)) {
          return;
        }
        this.#readResponse(response, responseBody);
        this.#readyState = CredentiallessXMLHttpRequest.LOADING;
        this.#dispatch("readystatechange");
        if (!this.#isCurrentRequest(requestGeneration)) {
          return;
        }

        const completedDownload = responseProgress(response, responseBody.byteLength);
        this.#dispatch("progress", completedDownload);
        if (!this.#isCurrentRequest(requestGeneration)) {
          return;
        }
        this.#finish(requestGeneration, "load", completedDownload);
      } catch {
        if (this.#isCurrentRequest(requestGeneration)) {
          this.#finish(requestGeneration, "error");
        }
      }
    }

    #readResponse(response: Response, responseBody: ArrayBuffer): void {
      const mimeType =
        this.#overrideMimeType ?? response.headers.get("content-type") ?? "";
      const text = decodeResponseBody(window, responseBody, mimeType);
      const responseIsDocument = isXMLMimeType(mimeType) || isHTMLMimeType(mimeType);

      this.#responseText = text;
      if (responseIsDocument) {
        const xmlResponse = isXMLMimeType(mimeType);
        // The spec restricts HTML parsing to responseType "document"; the
        // legacy default mode only ever exposes XML documents.
        if (this.#responseType === "document" || xmlResponse) {
          const documentMimeType: DOMParserSupportedType = xmlResponse
            ? "application/xml"
            : "text/html";
          const source = xmlResponse ? text : options.createHTML(text);
          let document: Document | null = new window.DOMParser().parseFromString(
            source,
            documentMimeType,
          );
          if (xmlResponse && document.querySelector("parsererror") !== null) {
            // A failed XML parse yields null, not the parser's error markup.
            document = null;
          }
          this.#responseXML = document;
          if (this.#responseType === "document") {
            this.#responseValue = document;
            return;
          }
        }
      }

      if (this.#responseType === "document") {
        this.#responseValue = null;
        return;
      }

      switch (this.#responseType) {
        case "":
        case "text":
          this.#responseValue = text;
          return;
        case "json":
          try {
            this.#responseValue = text === "" ? null : window.JSON.parse(text);
          } catch {
            this.#responseValue = null;
          }
          return;
        case "arraybuffer":
          this.#responseValue = responseBody;
          return;
        case "blob":
          this.#responseValue = new window.Blob([responseBody], { type: mimeType });
          return;
      }
    }

    #scheduleTimeout(requestGeneration: number): void {
      if (this.#timeoutID !== null) {
        window.clearTimeout(this.#timeoutID);
        this.#timeoutID = null;
      }
      if (
        !this.#isCurrentRequest(requestGeneration) ||
        this.#timeout === 0 ||
        this.#requestStartedAt === null
      ) {
        return;
      }

      const remaining =
        this.#timeout - (window.performance.now() - this.#requestStartedAt);
      if (remaining <= 0) {
        this.#timedOut(requestGeneration);
        return;
      }
      this.#timeoutID = window.setTimeout(
        () => this.#timedOut(requestGeneration),
        remaining,
      );
    }

    #timedOut(requestGeneration: number): void {
      if (!this.#isCurrentRequest(requestGeneration)) {
        return;
      }
      this.#abortController?.abort();
      this.#finish(requestGeneration, "timeout");
    }

    #abortRequest(requestGeneration: number): void {
      if (!this.#isCurrentRequest(requestGeneration)) {
        return;
      }
      this.#abortController?.abort();
      this.#finish(requestGeneration, "abort");
    }

    #terminateActiveRequest(): void {
      if (!this.#sendInProgress) {
        return;
      }
      if (this.#timeoutID !== null) {
        window.clearTimeout(this.#timeoutID);
        this.#timeoutID = null;
      }
      this.#sendInProgress = false;
      this.#requestStartedAt = null;
      this.#requestHasBody = false;
      this.#abortController?.abort();
      this.#abortController = null;

      const activeRequest = this.#activeRequest;
      this.#activeRequest = null;
      if (activeRequest !== null) {
        options.unregisterActive(activeRequest);
      }
    }

    #disposeRequest(requestGeneration: number): void {
      if (!this.#isCurrentRequest(requestGeneration)) {
        return;
      }
      this.#terminateActiveRequest();
      this.#resetResponse();
      this.#readyState = CredentiallessXMLHttpRequest.UNSENT;
      this.#clearEventListeners();
      this.#upload.dispose();
    }

    #isCurrentRequest(requestGeneration: number): boolean {
      return this.#sendInProgress && this.#requestGeneration === requestGeneration;
    }

    #finish(
      requestGeneration: number,
      result: "load" | "error" | "abort" | "timeout",
      completedDownload: ProgressValues = progressValues(0, null),
    ): void {
      if (!this.#isCurrentRequest(requestGeneration)) {
        return;
      }
      if (this.#timeoutID !== null) {
        window.clearTimeout(this.#timeoutID);
        this.#timeoutID = null;
      }
      this.#sendInProgress = false;
      this.#requestStartedAt = null;
      const requestHasBody = this.#requestHasBody;
      this.#requestHasBody = false;
      this.#abortController = null;
      const activeRequest = this.#activeRequest;
      this.#activeRequest = null;

      if (result !== "load") {
        this.#resetResponse();
      }
      this.#readyState = CredentiallessXMLHttpRequest.DONE;
      this.#dispatch("readystatechange");

      if (result !== "load" && requestHasBody) {
        this.#dispatchUpload(result);
        this.#dispatchUpload("loadend");
      }
      this.#dispatch(result, completedDownload);
      this.#dispatch("loadend", completedDownload);
      if (activeRequest !== null) {
        options.unregisterActive(activeRequest);
      }

      if (
        result === "abort" &&
        !this.#sendInProgress &&
        this.#requestGeneration === requestGeneration
      ) {
        this.#resetResponse();
        this.#readyState = CredentiallessXMLHttpRequest.UNSENT;
      }
    }

    #resetResponse(): void {
      this.#responseHeaders = null;
      this.#responseValue = null;
      this.#responseText = "";
      this.#responseXML = null;
      this.#responseURL = "";
      this.#status = 0;
      this.#statusText = "";
    }

    #clearEventListeners(): void {
      for (const [type, listeners] of this.#eventListeners) {
        for (const { listener, options } of listeners) {
          super.removeEventListener(type, listener, options);
        }
      }
      this.#eventListeners.clear();
      this.#eventHandlers.clear();
      this.#eventHandlerValues.clear();
    }

    #invalidState(message: string): DOMException {
      return new window.DOMException(`XMLHttpRequest ${message}`, "InvalidStateError");
    }

    #dispatch(type: string, progress: ProgressValues = progressValues(0, null)): void {
      const event =
        type === "readystatechange"
          ? new window.Event(type)
          : new window.ProgressEvent(type, progress);
      this.dispatchEvent(event);
    }

    #dispatchUpload(
      type: string,
      progress: ProgressValues = progressValues(0, null),
    ): void {
      this.#upload.dispatchEvent(new window.ProgressEvent(type, progress));
    }
  }

  Object.defineProperty(CredentiallessXMLHttpRequest, "name", {
    value: "XMLHttpRequest",
  });
  return CredentiallessXMLHttpRequest as unknown as typeof XMLHttpRequest;
}
