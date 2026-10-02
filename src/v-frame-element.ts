import {
  connectRealmIframe,
  type ConnectedRealmIframe,
  createRealm,
  type RealmFailure,
  type VFrameRealm,
} from "./realm/index.js";
import { type DocumentHistoryMode, VirtualHistorySession } from "./history.js";
import { parseEntryURL } from "./url.js";
import { VFrameStatus } from "./types.js";
import type {
  VFrameCredentials,
  VFrameErrorEventDetail,
  VFrameEventMap,
  VFrameLoadEventDetail,
  VFrameNavigatedEventDetail,
  VFrameNavigateEventDetail,
  VFrameNavigateOptions,
  VFrameNavigation,
  VFrameNavigationKind,
  VFrameStatus as VFrameStatusValue,
  VFrameTrustedTypesPolicy,
  VFrameTrustedTypesPolicyDefinition,
} from "./types.js";

const HTMLElementBase = (globalThis.HTMLElement ??
  class HTMLElementFallback {}) as typeof HTMLElement;
const nativeNonceDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElementBase.prototype,
  "nonce",
);

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function entryFetchError(url: string, response: Response): TypeError {
  return new TypeError(
    `v-frame entry ${url} returned ${response.status} ${response.statusText || "without a successful status"}`,
  );
}

function idleNavigationError(method: string): DOMException {
  return new DOMException(
    `v-frame cannot ${method} without an active guest`,
    "InvalidStateError",
  );
}

function canceledNavigationError(url: string): DOMException {
  return new DOMException(`v-frame navigation to ${url} was canceled`, "AbortError");
}

interface AdoptedMarkup {
  source: string;
  previewNodes: readonly Node[];
}

interface FrameLoad {
  source: string;
  adoptedMarkup: AdoptedMarkup | null;
  historySession: VirtualHistorySession | null;
  stageMarkup: boolean;
  boundNavigation: boolean;
  /** The navigation that asked for this document, or null when the host set `src`. */
  navigationKind: VFrameNavigationKind | null;
}

function identityTrustedTypesPolicy(name: string): VFrameTrustedTypesPolicyDefinition {
  return {
    name,
    createHTML: (source) => source,
    createScript: (source) => source,
    createScriptURL: (source) => source,
  };
}

export class VFrameElement extends HTMLElementBase {
  static readonly observedAttributes = [
    "src",
    "credentials",
    "navigation",
    "nonce",
    "trusted-types-policy",
  ];

  readonly #root: ShadowRoot;
  readonly #internals: ElementInternals;
  #status: VFrameStatusValue = VFrameStatus.Idle;
  #currentURL: string | null = null;
  // The guest's index in its own session, or null while no realm has reported one.
  #currentPosition: number | null = null;
  #realm: VFrameRealm | null = null;
  #loadingRealm: VFrameRealm | null = null;
  #realmController: AbortController | null = null;
  #loadController: AbortController | null = null;
  #historySession: VirtualHistorySession | null = null;
  #generation = 0;
  #realmGeneration = 0;
  #connected = false;
  #adoptionAvailable = false;
  #adoptionConsumed = false;
  #nonce = "";
  #trustedTypesPolicy: VFrameTrustedTypesPolicyDefinition | null = null;

  constructor() {
    super();
    this.#internals = this.attachInternals();
    this.#internals.states.add(this.#status);
    const declarativeRoot = this.shadowRoot;
    this.#root = declarativeRoot ?? this.attachShadow({ mode: "open" });
    this.#adoptionAvailable = declarativeRoot !== null;
    // A nonce assigned before upgrade lands in the native [[CryptographicNonce]]
    // slot rather than an own property, so it must be read back explicitly.
    this.#nonce = nativeNonceDescriptor?.get?.call(this) ?? "";
  }

  get src(): string {
    return this.getAttribute("src") ?? "";
  }

  set src(value: string) {
    this.setAttribute("src", String(value));
  }

  get adopt(): boolean {
    return this.hasAttribute("adopt");
  }

  set adopt(value: boolean) {
    this.toggleAttribute("adopt", Boolean(value));
  }

  get credentials(): VFrameCredentials {
    const value = this.getAttribute("credentials");
    if (value === "omit" || value === "include" || value === "same-origin") {
      return value;
    }
    return "same-origin";
  }

  set credentials(value: VFrameCredentials) {
    if (value !== "omit" && value !== "include" && value !== "same-origin") {
      throw new TypeError(
        `v-frame credentials must be "omit", "same-origin", or "include", received ${JSON.stringify(value)}`,
      );
    }
    this.setAttribute("credentials", value);
  }

  get navigation(): VFrameNavigation {
    return this.getAttribute("navigation") === "host" ? "host" : "guest";
  }

  set navigation(value: VFrameNavigation) {
    if (value !== "guest" && value !== "host") {
      throw new TypeError(
        `v-frame navigation must be "guest" or "host", received ${JSON.stringify(value)}`,
      );
    }
    this.setAttribute("navigation", value);
  }

  get nonce(): string {
    return this.#nonce;
  }

  set nonce(value: string) {
    this.setAttribute("nonce", String(value));
  }

  get trustedTypesPolicy(): VFrameTrustedTypesPolicy | null {
    return this.#trustedTypesPolicy ?? this.getAttribute("trusted-types-policy");
  }

  set trustedTypesPolicy(value: VFrameTrustedTypesPolicy | null) {
    if (value === null) {
      const hadPolicy = this.#trustedTypesPolicy !== null;
      const hadAttribute = this.hasAttribute("trusted-types-policy");
      this.#trustedTypesPolicy = null;
      this.removeAttribute("trusted-types-policy");
      if (hadPolicy && !hadAttribute) {
        this.#configurationChanged();
      }
      return;
    }
    if (typeof value === "string") {
      if (value.trim() === "") {
        throw new TypeError("v-frame trustedTypesPolicy must not be an empty string");
      }
      const hadPolicy = this.#trustedTypesPolicy !== null;
      const oldAttribute = this.getAttribute("trusted-types-policy");
      this.#trustedTypesPolicy = null;
      this.setAttribute("trusted-types-policy", value);
      if (hadPolicy && oldAttribute === value) {
        this.#configurationChanged();
      }
      return;
    }
    if (typeof value !== "object") {
      throw new TypeError(
        `v-frame trustedTypesPolicy must be null or an object, received ${String(value)}`,
      );
    }
    if (typeof value.name !== "string" || value.name.trim() === "") {
      throw new TypeError(
        `v-frame trustedTypesPolicy.name must be a non-empty string, received ${JSON.stringify(value.name)}`,
      );
    }
    for (const method of ["createHTML", "createScript", "createScriptURL"] as const) {
      if (typeof value[method] !== "function") {
        throw new TypeError(
          `v-frame trustedTypesPolicy.${method} must be a function, received ${typeof value[method]}`,
        );
      }
    }
    const changed = this.trustedTypesPolicy !== value;
    this.#trustedTypesPolicy = value;
    this.removeAttribute("trusted-types-policy");
    if (changed) {
      this.#configurationChanged();
    }
  }

  get status(): VFrameStatusValue {
    return this.#status;
  }

  get currentURL(): string | null {
    return this.#currentURL;
  }

  get contentWindow(): Window | null {
    return this.#realm?.window ?? this.#loadingRealm?.window ?? null;
  }

  get canGoBack(): boolean {
    return this.#realm?.navigation.canGoBack ?? false;
  }

  get canGoForward(): boolean {
    return this.#realm?.navigation.canGoForward ?? false;
  }

  /**
   * Moves the live guest to another same-origin route without reloading its document.
   * The guest sees the new URL and a `popstate`, which is what a client-side router
   * listens for. Replacing the document is `src` or `reload()`.
   */
  navigate(url: string | URL, options: VFrameNavigateOptions = {}): Promise<void> {
    const navigation = this.#realm?.navigation ?? null;
    if (navigation === null) {
      return Promise.reject(idleNavigationError("navigate"));
    }

    let route: URL;
    try {
      route = this.#resolveRoute(url);
    } catch (error) {
      return Promise.reject(error);
    }

    const mode: DocumentHistoryMode = options.replace === true ? "replace" : "push";
    const outcome = navigation.navigate(route.href, mode);
    if (outcome === "canceled") {
      return Promise.reject(canceledNavigationError(route.href));
    }
    if (outcome === "unavailable") {
      return Promise.reject(idleNavigationError("navigate"));
    }
    return Promise.resolve();
  }

  back(): Promise<void> {
    return this.#traverse(-1);
  }

  forward(): Promise<void> {
    return this.#traverse(1);
  }

  go(delta = 0): Promise<void> {
    return this.#traverse(delta);
  }

  // Traversal past either end of the guest session is a no-op, exactly as
  // `history.go` is; `canGoBack` and `canGoForward` are how a host checks first.
  // The promise settles once the guest has moved, in either navigation mode.
  async #traverse(delta: number): Promise<void> {
    const navigation = this.#realm?.navigation ?? null;
    if (navigation === null) {
      throw idleNavigationError("traverse");
    }

    const steps = Number.isFinite(delta) ? Math.trunc(delta) : 0;
    if (steps === 0) {
      return;
    }
    const result = await navigation.traverse(steps);
    if (result.outcome === "canceled") {
      throw canceledNavigationError(result.destination);
    }
  }

  // Imperative routes resolve against the live guest URL and are held to the
  // same-origin rule the entry path enforces.
  #resolveRoute(url: string | URL): URL {
    const route = parseEntryURL(
      String(url),
      this.#currentURL ?? this.ownerDocument.baseURI,
      "route",
    );
    if (route.origin !== this.ownerDocument.location.origin) {
      throw new TypeError(
        `v-frame route ${route.href} must share host origin ${this.ownerDocument.location.origin}`,
      );
    }
    return route;
  }

  connectedCallback(): void {
    this.#upgradeProperty("adopt");
    this.#upgradeProperty("credentials");
    this.#upgradeProperty("navigation");
    this.#upgradeProperty("src");
    this.#upgradeProperty("trustedTypesPolicy");
    this.#connected = true;
    const source = this.#loadSource();
    if (source === null) {
      return;
    }
    const adoptedMarkup = this.#consumeAdoptedMarkup();
    this.#observeLoad(
      this.#startLoad({
        source,
        adoptedMarkup,
        historySession: null,
        stageMarkup: adoptedMarkup !== null,
        boundNavigation: this.navigation === "host",
        navigationKind: null,
      }),
    );
  }

  // Own properties assigned before upgrade shadow the prototype accessors;
  // re-applying them through the setters restores reflection and validation.
  #upgradeProperty(
    property: "src" | "adopt" | "credentials" | "navigation" | "trustedTypesPolicy",
  ): void {
    if (!Object.prototype.hasOwnProperty.call(this, property)) {
      return;
    }
    const record = this as unknown as Record<string, unknown>;
    const value = record[property];
    delete record[property];
    record[property] = value;
  }

  disconnectedCallback(): void {
    this.#connected = false;
    this.#resetToIdle();
  }

  attributeChangedCallback(
    name: string,
    oldValue: string | null,
    newValue: string | null,
  ): void {
    if (name === "nonce") {
      this.#nonce = nativeNonceDescriptor?.get?.call(this) ?? newValue ?? "";
      return;
    }
    if (name === "trusted-types-policy" && this.#trustedTypesPolicy !== null) {
      return;
    }
    if (oldValue === newValue || !this.#connected) {
      return;
    }

    this.#configurationChanged();
  }

  #configurationChanged(): void {
    if (!this.#connected) {
      return;
    }

    const source = this.#loadSource();
    if (source === null) {
      this.#resetToIdle();
      return;
    }

    this.#observeLoad(
      this.#startLoad({
        source,
        adoptedMarkup: null,
        historySession: null,
        stageMarkup: false,
        boundNavigation: this.navigation === "host",
        navigationKind: null,
      }),
    );
  }

  reload(): Promise<void> {
    const source = this.#loadSource();
    if (!this.isConnected || source === null) {
      this.#resetToIdle();
      return Promise.resolve();
    }

    return this.#startLoad({
      source: this.#currentURL ?? source,
      adoptedMarkup: null,
      historySession: this.#historySession?.clone() ?? null,
      stageMarkup: this.#realm !== null,
      boundNavigation: this.navigation === "host",
      navigationKind: null,
    });
  }

  #loadSource(): string | null {
    return !this.hasAttribute("src") || this.src.trim() === "" ? null : this.src;
  }

  #effectiveTrustedTypesPolicy(): VFrameTrustedTypesPolicyDefinition | null {
    if (this.#trustedTypesPolicy !== null) {
      return this.#trustedTypesPolicy;
    }
    const name = this.getAttribute("trusted-types-policy")?.trim() ?? "";
    return name === "" ? null : identityTrustedTypesPolicy(name);
  }

  #resetToIdle(): void {
    this.#generation += 1;
    this.#destroyRealm();
    this.#currentURL = null;
    this.#currentPosition = null;
    this.#historySession = null;
    this.#setStatus(VFrameStatus.Idle);
  }

  addEventListener<K extends keyof VFrameEventMap>(
    type: K,
    listener: (this: VFrameElement, event: VFrameEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (listener === null) {
      return;
    }
    super.addEventListener(type, listener, options);
  }

  removeEventListener<K extends keyof VFrameEventMap>(
    type: K,
    listener: (this: VFrameElement, event: VFrameEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    super.removeEventListener(type, listener, options);
  }

  #observeLoad(load: Promise<void>): void {
    void load.catch(() => undefined);
  }

  #startLoad(load: FrameLoad): Promise<void> {
    this.#loadController?.abort();
    this.#loadingRealm = null;
    const generation = this.#generation + 1;
    this.#generation = generation;
    const previousRealm = this.#realm;
    const previousRealmController = this.#realmController;
    const previousHistorySession = this.#historySession;
    const previousURL = this.#currentURL;
    const previousStatus = this.#status;
    if (!load.stageMarkup) {
      previousRealm?.dispose();
      this.#realm = null;
      previousRealmController?.abort();
      this.#realmController = null;
      this.#historySession = null;
      this.#currentURL = null;
      this.#currentPosition = null;
      for (const child of Array.from(this.#root.children)) {
        child.remove();
      }
    }
    const controller = new AbortController();
    this.#loadController = controller;
    return this.#load(generation, controller, load, {
      realm: load.stageMarkup ? previousRealm : null,
      realmController: load.stageMarkup ? previousRealmController : null,
      historySession: load.stageMarkup ? previousHistorySession : null,
      url: load.stageMarkup ? previousURL : null,
      status: load.stageMarkup ? previousStatus : VFrameStatus.Idle,
    });
  }

  async #load(
    generation: number,
    controller: AbortController,
    load: FrameLoad,
    previous: {
      realm: VFrameRealm | null;
      realmController: AbortController | null;
      historySession: VirtualHistorySession | null;
      url: string | null;
      status: VFrameStatusValue;
    },
  ): Promise<void> {
    this.#setStatus(VFrameStatus.Loading);

    let requestedURL: URL;
    try {
      requestedURL = parseEntryURL(load.source, this.ownerDocument.baseURI);
    } catch (error) {
      this.#finishFailedLoad(generation, controller, previous, {
        phase: "entry",
        url: load.source,
        error,
      });
      throw error;
    }

    this.#dispatch<VFrameLoadEventDetail>("v-frame-loadstart", {
      url: requestedURL.href,
    });

    if (requestedURL.origin !== this.ownerDocument.location.origin) {
      const error = new TypeError(
        `v-frame route ${requestedURL.href} must share host origin ${this.ownerDocument.location.origin}`,
      );
      this.#finishFailedLoad(generation, controller, previous, {
        phase: "entry",
        url: requestedURL.href,
        error,
      });
      throw error;
    }

    let entryResolved = false;
    let failureURL = requestedURL.href;
    const pendingRealm = { iframe: null as HTMLIFrameElement | null };
    let realmConnectionFailed = false;
    const connectRealm = (url: string) =>
      connectRealmIframe(
        this.#root,
        controller.signal,
        url,
        this.#effectiveTrustedTypesPolicy(),
      )
        .then((connection) => {
          pendingRealm.iframe = connection.iframe;
          return connection;
        })
        .catch((error: unknown) => {
          realmConnectionFailed = true;
          throw error;
        });

    try {
      let source: string;
      let finalURL: string;
      let connection: ConnectedRealmIframe;
      if (load.adoptedMarkup === null) {
        const entryResponse = fetch(requestedURL, {
          credentials: this.credentials,
          signal: controller.signal,
        });
        const [response, connectedRealm] = await Promise.all([
          entryResponse,
          connectRealm(requestedURL.href),
        ]);
        connection = connectedRealm;
        if (!response.ok || response.type === "opaque") {
          throw entryFetchError(requestedURL.href, response);
        }
        source = await response.text();
        this.#assertCurrentGeneration(generation, controller.signal);
        const responseURL = parseEntryURL(
          response.url || requestedURL.href,
          requestedURL.href,
        );
        if (responseURL.hash === "") {
          responseURL.hash = requestedURL.hash;
        }
        finalURL = responseURL.href;
      } else {
        connection = await connectRealm(requestedURL.href);
        source = load.adoptedMarkup.source;
        finalURL = requestedURL.href;
      }
      entryResolved = true;
      failureURL = finalURL;
      if (new URL(finalURL).origin !== this.ownerDocument.location.origin) {
        throw new TypeError(
          `v-frame route ${finalURL} must share host origin ${this.ownerDocument.location.origin}`,
        );
      }
      if (finalURL !== requestedURL.href) {
        const realmWindow = connection.iframe.contentWindow;
        if (realmWindow === null) {
          throw new Error(
            `v-frame redirect ${requestedURL.href} to ${finalURL} lost its execution realm`,
          );
        }
        realmWindow.history.replaceState(null, "", finalURL);
      }
      const historySession = load.historySession ?? new VirtualHistorySession(finalURL);
      historySession.replaceCurrentURL(finalURL);
      // While this load is staged behind a live guest, the URL the host observes still
      // belongs to that guest; this realm owns it only once it goes live.
      let staged = previous.realm !== null;
      if (!staged) {
        this.#currentURL = finalURL;
      }

      const ownsController = () =>
        this.#generation === generation &&
        (this.#loadController === controller || this.#realmController === controller) &&
        !controller.signal.aborted;
      const realm = await createRealm({
        host: this,
        shadowRoot: this.#root,
        iframe: connection.iframe,
        trustedTypes: connection.trustedTypes,
        markup:
          load.adoptedMarkup === null
            ? { kind: "document", source }
            : {
                kind: "adopted",
                source,
                previewNodes: load.adoptedMarkup.previewNodes,
              },
        pageURL: finalURL,
        historySession,
        boundNavigation: load.boundNavigation,
        stageMarkup: load.stageMarkup,
        credentials: this.credentials,
        signal: controller.signal,
        getNonce: () => this.nonce,
        fetchStylesheet: async (url) => {
          const stylesheetResponse = await fetch(url, {
            credentials: this.credentials,
            signal: controller.signal,
          });
          if (!stylesheetResponse.ok || stylesheetResponse.type === "opaque") {
            throw new TypeError(
              `v-frame stylesheet ${url} returned ${stylesheetResponse.status} ${stylesheetResponse.statusText}`,
            );
          }
          return {
            text: await stylesheetResponse.text(),
            url: stylesheetResponse.url || url,
          };
        },
        onURLChange: (url, kind) => {
          finalURL = url;
          failureURL = url;
          if (ownsController() && !staged) {
            this.#setCurrentURL(url, kind);
          }
        },
        onNavigate: (detail, dispatchOptions) => {
          if (!ownsController()) {
            return false;
          }

          const allowed = this.#dispatchNavigate(
            detail,
            dispatchOptions?.cancelable === true,
          );
          return allowed && ownsController();
        },
        onDocumentNavigation: (
          detail: VFrameNavigateEventDetail,
          mode: DocumentHistoryMode,
        ) => {
          if (!ownsController() || !this.#dispatchNavigate(detail) || !ownsController()) {
            return false;
          }
          const nextSession = historySession.forkDocumentNavigation(detail.to, mode);
          queueMicrotask(() => {
            if (!ownsController()) {
              return;
            }
            this.#observeLoad(
              this.#startLoad({
                source: detail.to,
                adoptedMarkup: null,
                historySession: nextSession,
                stageMarkup: this.#realm !== null,
                boundNavigation: false,
                navigationKind: detail.kind,
              }),
            );
          });
          return true;
        },
        onDocumentTraversal: (nextSession) => {
          return new Promise<void>((resolve, reject) => {
            queueMicrotask(() => {
              if (!ownsController()) {
                reject(
                  new DOMException("The v-frame traversal was superseded", "AbortError"),
                );
                return;
              }
              const traversalGeneration = this.#generation + 1;
              void this.#startLoad({
                source: nextSession.currentURL,
                adoptedMarkup: null,
                historySession: nextSession,
                stageMarkup: this.#realm !== null,
                boundNavigation: false,
                navigationKind: "traverse",
              }).then(() => {
                if (
                  this.#realmGeneration !== traversalGeneration ||
                  this.#generation !== traversalGeneration
                ) {
                  reject(
                    new DOMException(
                      "The v-frame traversal was superseded",
                      "AbortError",
                    ),
                  );
                } else {
                  resolve();
                }
              }, reject);
            });
          });
        },
        onShellNavigation: (detail) => {
          if (!ownsController()) {
            return false;
          }
          const allowed = this.#dispatchNavigate(detail) && ownsController();
          if (allowed) {
            this.ownerDocument.defaultView?.location.assign(detail.to);
          }
          return allowed;
        },
        onNativeLocationNavigation: (detail, mode) => {
          if (!ownsController()) {
            return;
          }
          if (load.boundNavigation) {
            const hostLocation = this.ownerDocument.defaultView?.location;
            if (mode === "replace") {
              hostLocation?.replace(detail.to);
            } else if (mode === "reload") {
              hostLocation?.reload();
            } else {
              hostLocation?.assign(detail.to);
            }
            return;
          }
          const nextSession =
            mode === "reload"
              ? historySession.clone()
              : historySession.forkDocumentNavigation(detail.to, mode);
          queueMicrotask(() => {
            if (!ownsController()) {
              return;
            }
            this.#observeLoad(
              this.#startLoad({
                source: nextSession.currentURL,
                adoptedMarkup: null,
                historySession: nextSession,
                stageMarkup: this.#realm !== null,
                boundNavigation: load.boundNavigation,
                navigationKind: detail.kind,
              }),
            );
          });
        },
        onError: (failure) => {
          if (ownsController()) {
            this.#dispatchError({ ...failure, fatal: false });
          }
        },
      });
      pendingRealm.iframe = null;

      if (this.#generation !== generation || controller.signal.aborted) {
        realm.dispose();
        return;
      }

      if (previous.realm === null) {
        this.#loadingRealm = realm;
      }

      await realm.executeInitialScripts();
      this.#assertCurrentGeneration(generation, controller.signal);
      previous.realm?.dispose();
      previous.realmController?.abort();
      this.#realm = realm;
      this.#loadingRealm = null;
      this.#realmController = controller;
      this.#loadController = null;
      this.#historySession = historySession;
      this.#realmGeneration = generation;
      staged = false;
      this.#setCurrentURL(finalURL, load.navigationKind);
      realm.reveal();
      this.#setStatus(VFrameStatus.Ready);
      this.#dispatch<VFrameLoadEventDetail>("v-frame-load", {
        url: this.#currentURL ?? finalURL,
      });
    } catch (error) {
      pendingRealm.iframe?.remove();
      if (
        this.#generation !== generation ||
        controller.signal.aborted ||
        isAbortError(error)
      ) {
        return;
      }

      const failure = {
        phase:
          realmConnectionFailed || entryResolved
            ? ("bootstrap" as const)
            : ("entry" as const),
        url: failureURL,
        error,
      };
      this.#finishFailedLoad(generation, controller, previous, failure);
      throw error;
    }
  }

  #finishFailedLoad(
    generation: number,
    controller: AbortController,
    previous: {
      realm: VFrameRealm | null;
      realmController: AbortController | null;
      historySession: VirtualHistorySession | null;
      url: string | null;
      status: VFrameStatusValue;
    },
    failure: RealmFailure,
  ): void {
    if (this.#generation !== generation || this.#loadController !== controller) {
      return;
    }

    this.#loadController = null;
    this.#loadingRealm = null;
    controller.abort();
    if (previous.realm === null) {
      this.#failGeneration(generation, failure);
      return;
    }

    this.#generation = this.#realmGeneration;
    this.#realm = previous.realm;
    this.#realmController = previous.realmController;
    this.#historySession = previous.historySession;
    this.#currentURL = previous.url;
    this.#setStatus(previous.status);
    this.#dispatchError({ ...failure, fatal: false });
  }

  #assertCurrentGeneration(generation: number, signal: AbortSignal): void {
    if (this.#generation !== generation || signal.aborted) {
      throw new DOMException("The v-frame load was superseded", "AbortError");
    }
  }

  #failGeneration(generation: number, failure: RealmFailure): void {
    if (this.#generation !== generation) {
      return;
    }

    this.#generation = generation + 1;
    const realm = this.#realm;
    this.#realm = null;
    realm?.dispose();
    this.#loadingRealm?.dispose();
    this.#loadingRealm = null;
    this.#realmController?.abort();
    this.#realmController = null;
    this.#loadController?.abort();
    this.#loadController = null;
    this.#historySession = null;
    this.#realmGeneration = 0;
    this.#currentURL = null;
    this.#setStatus(VFrameStatus.Error);
    this.#dispatchError({ ...failure, fatal: true });
  }

  #destroyRealm(): void {
    const realm = this.#realm;
    this.#realm = null;
    realm?.dispose();
    this.#loadingRealm?.dispose();
    this.#loadingRealm = null;
    this.#realmController?.abort();
    this.#realmController = null;
    this.#loadController?.abort();
    this.#loadController = null;
    this.#historySession = null;
    this.#realmGeneration = 0;
    for (const child of Array.from(this.#root.children)) {
      child.remove();
    }
  }

  #setStatus(status: VFrameStatusValue): void {
    this.#status = status;
    this.#internals.states.clear();
    this.#internals.states.add(status);
  }

  #consumeAdoptedMarkup(): { source: string; previewNodes: readonly Node[] } | null {
    if (!this.adopt || !this.#adoptionAvailable || this.#adoptionConsumed) {
      return null;
    }
    this.#adoptionConsumed = true;

    const html = Array.from(this.#root.children).find(
      (element) => element.localName === "v-html",
    );
    if (
      html === undefined ||
      html.querySelector(":scope > v-head") === null ||
      html.querySelector(":scope > v-body") === null
    ) {
      return null;
    }

    return {
      source: this.#root.getHTML({ serializableShadowRoots: true }),
      previewNodes: Array.from(this.#root.childNodes),
    };
  }

  #dispatchError(detail: VFrameErrorEventDetail): void {
    this.#dispatch<VFrameErrorEventDetail>("v-frame-error", detail);
  }

  // The position comes from whichever realm is reporting, including one still loading
  // its first document — that realm owns the session the URL change belongs to.
  #historyPosition(): number | null {
    return (this.#realm ?? this.#loadingRealm)?.navigation.position ?? null;
  }

  // The past-tense counterpart of `v-frame-navigate`: the guest URL is already the new
  // one, so a host router can read `currentURL`, `canGoBack` and `canGoForward` here.
  #setCurrentURL(url: string, kind: VFrameNavigationKind | null): void {
    const from = this.#currentURL;
    const fromPosition = this.#currentPosition;
    const position = this.#historyPosition();
    this.#currentURL = url;
    this.#currentPosition = position;
    if (kind === null || from === null) {
      return;
    }
    // Pushing the URL the guest is already on still moves the session, and
    // `canGoBack` moves with it, so the position decides — not the URL string.
    // Until a realm has reported a position there is nothing to compare, and the
    // URL is the only signal.
    const moved =
      from !== url ||
      (fromPosition !== null && position !== null && fromPosition !== position);
    if (!moved) {
      return;
    }
    this.#dispatch<VFrameNavigatedEventDetail>("v-frame-navigated", {
      from,
      to: url,
      kind,
    });
  }

  #dispatchNavigate(detail: VFrameNavigateEventDetail, hostInitiated = false): boolean {
    // A host-initiated navigation is always cancelable; a guest History call is not,
    // because the platform gives the page no way to refuse one.
    const cancelable =
      hostInitiated ||
      detail.kind === "link" ||
      detail.kind === "fragment" ||
      detail.kind === "form" ||
      detail.kind === "window";
    return this.dispatchEvent(
      new CustomEvent<VFrameNavigateEventDetail>("v-frame-navigate", {
        detail,
        bubbles: true,
        composed: true,
        cancelable,
      }),
    );
  }

  #dispatch<T>(type: string, detail: T): boolean {
    return this.dispatchEvent(
      new CustomEvent<T>(type, {
        detail,
        bubbles: true,
        composed: true,
      }),
    );
  }
}
