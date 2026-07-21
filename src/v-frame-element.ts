import {
  connectRealmIframe,
  createRealm,
  type RealmFailure,
  type VFrameRealm,
} from "./realm.js";
import { VirtualHistorySession } from "./history.js";
import { parseEntryURL } from "./url.js";
import { VFrameStatus } from "./types.js";
import type {
  VFrameCredentials,
  VFrameErrorEventDetail,
  VFrameEventMap,
  VFrameLoadEventDetail,
  VFrameNavigateEventDetail,
  VFrameStatus as VFrameStatusValue,
} from "./types.js";

const HTMLElementBase = (
  globalThis.HTMLElement ?? class HTMLElementFallback {}
) as typeof HTMLElement;
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
}

export class VFrameElement extends HTMLElementBase {
  static readonly observedAttributes = ["src", "credentials", "nonce"];

  readonly #root: ShadowRoot;
  #status: VFrameStatusValue = VFrameStatus.Idle;
  #currentURL: string | null = null;
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

  constructor() {
    super();
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

  get nonce(): string {
    return this.#nonce;
  }

  set nonce(value: string) {
    this.setAttribute("nonce", String(value));
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

  connectedCallback(): void {
    this.#upgradeProperty("adopt");
    this.#upgradeProperty("credentials");
    this.#upgradeProperty("src");
    this.#connected = true;
    const source = this.#loadSource();
    if (source === null) {
      return;
    }
    const adoptedMarkup = this.#consumeAdoptedMarkup();
    this.#observeLoad(this.#startLoad({
      source,
      adoptedMarkup,
      historySession: null,
      stageMarkup: adoptedMarkup !== null,
      boundNavigation: !this.hasAttribute("src"),
    }));
  }

  // Own properties assigned before upgrade shadow the prototype accessors;
  // re-applying them through the setters restores reflection and validation.
  #upgradeProperty(property: "src" | "adopt" | "credentials"): void {
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
    if (oldValue === newValue || !this.#connected) {
      return;
    }

    const source = this.#loadSource();
    if (source === null) {
      this.#resetToIdle();
      return;
    }

    this.#observeLoad(this.#startLoad({
      source,
      adoptedMarkup: null,
      historySession: null,
      stageMarkup: false,
      boundNavigation: !this.hasAttribute("src"),
    }));
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
      boundNavigation: !this.hasAttribute("src"),
    });
  }

  #loadSource(): string | null {
    if (!this.hasAttribute("src")) {
      return this.ownerDocument.location.href;
    }
    return this.src.trim() === "" ? null : this.src;
  }

  #resetToIdle(): void {
    this.#generation += 1;
    this.#destroyRealm();
    this.#currentURL = null;
    this.#historySession = null;
    this.#status = VFrameStatus.Idle;
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
    this.#status = VFrameStatus.Loading;

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

    let fatalRealmFailure: RealmFailure | null = null;
    let entryResolved = false;
    let failureURL = requestedURL.href;
    let rejectFatalRealm: (error: unknown) => void = () => undefined;
    const fatalRealm = new Promise<never>((_resolve, reject) => {
      rejectFatalRealm = reject;
    });
    const pendingRealm = { iframe: null as HTMLIFrameElement | null };
    let realmConnectionFailed = false;
    const connectRealm = (url: string) => connectRealmIframe(
      this.#root,
      controller.signal,
      url,
    ).then((iframe) => {
      pendingRealm.iframe = iframe;
      return iframe;
    }).catch((error: unknown) => {
      realmConnectionFailed = true;
      throw error;
    });

    try {
      let source: string;
      let finalURL: string;
      let iframe: HTMLIFrameElement;
      if (load.adoptedMarkup === null) {
        const entryResponse = fetch(requestedURL, {
          credentials: this.credentials,
          signal: controller.signal,
        });
        const [response, connectedIframe] = await Promise.all([
          entryResponse,
          connectRealm(requestedURL.href),
        ]);
        iframe = connectedIframe;
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
        iframe = await connectRealm(requestedURL.href);
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
        iframe.remove();
        pendingRealm.iframe = null;
        iframe = await connectRealm(finalURL);
      }
      const historySession = load.historySession ?? new VirtualHistorySession(finalURL);
      historySession.replaceCurrentURL(finalURL);
      if (previous.realm === null) {
        this.#currentURL = finalURL;
      }

      let activated = false;
      let candidateRealm: VFrameRealm | null = null;
      const ownsController = () =>
        this.#generation === generation &&
        (this.#loadController === controller || this.#realmController === controller) &&
        !controller.signal.aborted;
      const realm = await createRealm({
        host: this,
        shadowRoot: this.#root,
        iframe,
        markup: load.adoptedMarkup === null
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
          return stylesheetResponse.text();
        },
        onURLChange: (url) => {
          finalURL = url;
          failureURL = url;
          if (ownsController() && previous.realm === null) {
            this.#currentURL = url;
          }
        },
        onNavigate: (detail) => {
          if (!ownsController()) {
            return false;
          }

          const allowed = this.#dispatchNavigate(detail);
          return allowed && ownsController();
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
        onNativeLocationNavigation: (detail) => {
          if (!ownsController()) {
            return;
          }
          if (this.#dispatchNavigate(detail) && ownsController()) {
            this.ownerDocument.defaultView?.location.assign(detail.to);
            return;
          }
          const nextSession = historySession.clone();
          queueMicrotask(() => {
            if (!ownsController()) {
              return;
            }
            this.#observeLoad(this.#startLoad({
              source: nextSession.currentURL,
              adoptedMarkup: null,
              historySession: nextSession,
              stageMarkup: this.#realm !== null,
              boundNavigation: load.boundNavigation,
            }));
          });
        },
        onError: (failure) => {
          if (ownsController()) {
            this.#dispatchError({ ...failure, fatal: false });
          }
        },
        onFatal: (failure) => {
          if (!ownsController()) {
            return;
          }
          fatalRealmFailure = failure;
          if (activated && this.#realm === candidateRealm) {
            this.#failGeneration(generation, failure);
          }
          rejectFatalRealm(failure.error);
        },
      });
      pendingRealm.iframe = null;
      candidateRealm = realm;

      if (this.#generation !== generation || controller.signal.aborted) {
        realm.dispose();
        return;
      }

      if (previous.realm === null) {
        this.#loadingRealm = realm;
      }

      await Promise.race([realm.executeInitialScripts(), fatalRealm]);
      this.#assertCurrentGeneration(generation, controller.signal);
      previous.realm?.dispose();
      previous.realmController?.abort();
      this.#realm = realm;
      this.#loadingRealm = null;
      this.#realmController = controller;
      this.#loadController = null;
      this.#historySession = historySession;
      this.#realmGeneration = generation;
      this.#currentURL = finalURL;
      activated = true;
      realm.reveal();
      this.#status = VFrameStatus.Ready;
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

      const failure = fatalRealmFailure ?? {
        phase: realmConnectionFailed || entryResolved
          ? "bootstrap" as const
          : "entry" as const,
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
    this.#status = previous.status;
    this.#dispatchError({ ...failure, fatal: false });
  }

  #assertCurrentGeneration(generation: number, signal: AbortSignal): void {
    if (this.#generation !== generation || signal.aborted) {
      throw new DOMException("The v-frame load was superseded", "AbortError");
    }
  }

  #failGeneration(
    generation: number,
    failure: RealmFailure,
  ): void {
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
    this.#status = VFrameStatus.Error;
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

  #dispatchNavigate(detail: VFrameNavigateEventDetail): boolean {
    const cancelable =
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
