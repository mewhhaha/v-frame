import { createRealm, type RealmFailure, type VFrameRealm } from "./realm.js";
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

export class VFrameElement extends HTMLElementBase {
  static readonly observedAttributes = ["src", "credentials", "nonce", "adopt"];

  readonly #root: ShadowRoot;
  #status: VFrameStatusValue = VFrameStatus.Idle;
  #currentURL: string | null = null;
  #realm: VFrameRealm | null = null;
  #controller: AbortController | null = null;
  #generation = 0;
  #connected = false;
  #adoptionAvailable = false;
  #adoptionConsumed = false;
  #nonce = "";

  constructor() {
    super();
    const declarativeRoot = this.shadowRoot;
    this.#root = declarativeRoot ?? this.attachShadow({ mode: "open" });
    this.#adoptionAvailable = declarativeRoot !== null;
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
    return this.#realm?.window ?? null;
  }

  connectedCallback(): void {
    this.#connected = true;
    if (this.src.trim() !== "") {
      this.#observeLoad(this.#startLoad(this.#consumeAdoptedMarkup()));
    }
  }

  disconnectedCallback(): void {
    this.#connected = false;
    this.#generation += 1;
    this.#destroyRealm();
    this.#currentURL = null;
    this.#status = VFrameStatus.Idle;
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
    if (name === "adopt") {
      return;
    }
    if (oldValue === newValue || !this.#connected) {
      return;
    }

    if (this.src.trim() === "") {
      this.#generation += 1;
      this.#destroyRealm();
      this.#currentURL = null;
      this.#status = VFrameStatus.Idle;
      return;
    }

    this.#observeLoad(this.#startLoad());
  }

  reload(): Promise<void> {
    if (!this.isConnected || this.src.trim() === "") {
      this.#generation += 1;
      this.#destroyRealm();
      this.#currentURL = null;
      this.#status = VFrameStatus.Idle;
      return Promise.resolve();
    }

    return this.#startLoad();
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

  #startLoad(
    adoptedMarkup: { source: string; previewNodes: readonly Node[] } | null = null,
  ): Promise<void> {
    const generation = this.#generation + 1;
    this.#generation = generation;
    if (adoptedMarkup === null) {
      this.#destroyRealm();
    } else {
      this.#realm?.dispose();
      this.#realm = null;
      this.#controller?.abort();
      this.#controller = null;
    }
    return this.#load(generation, adoptedMarkup);
  }

  async #load(
    generation: number,
    adoptedMarkup: { source: string; previewNodes: readonly Node[] } | null,
  ): Promise<void> {
    const controller = new AbortController();
    this.#controller = controller;
    this.#status = VFrameStatus.Loading;
    this.#currentURL = null;

    let requestedURL: URL;
    try {
      requestedURL = parseEntryURL(this.src, this.ownerDocument.baseURI);
    } catch (error) {
      this.#failGeneration(generation, {
        phase: "entry",
        url: this.src,
        error,
      });
      throw error;
    }

    this.#dispatch<VFrameLoadEventDetail>("v-frame-loadstart", {
      url: requestedURL.href,
    });

    let fatalRealmFailure: RealmFailure | null = null;
    let rejectFatalRealm: (error: unknown) => void = () => undefined;
    const fatalRealm = new Promise<never>((_resolve, reject) => {
      rejectFatalRealm = reject;
    });

    try {
      let source: string;
      let finalURL: string;
      if (adoptedMarkup === null) {
        const response = await fetch(requestedURL, {
          credentials: this.credentials,
          signal: controller.signal,
        });
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
        source = adoptedMarkup.source;
        finalURL = requestedURL.href;
      }
      this.#currentURL = finalURL;

      const realm = await createRealm({
        host: this,
        shadowRoot: this.#root,
        markup: adoptedMarkup === null
          ? { kind: "document", source }
          : { kind: "adopted", source, previewNodes: adoptedMarkup.previewNodes },
        pageURL: finalURL,
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
          if (this.#generation === generation) {
            this.#currentURL = url;
          }
        },
        onNavigate: (detail) => {
          if (
            this.#generation !== generation ||
            this.#controller !== controller ||
            controller.signal.aborted
          ) {
            return false;
          }

          const allowed = this.#dispatchNavigate(detail);
          return allowed &&
            this.#generation === generation &&
            this.#controller === controller &&
            !controller.signal.aborted;
        },
        onError: (failure) => {
          if (this.#generation === generation) {
            this.#dispatchError({ ...failure, fatal: false });
          }
        },
        onFatal: (failure) => {
          if (
            this.#generation !== generation ||
            this.#controller !== controller
          ) {
            return;
          }
          fatalRealmFailure = failure;
          this.#failGeneration(generation, failure);
          rejectFatalRealm(failure.error);
        },
      });

      if (this.#generation !== generation || controller.signal.aborted) {
        realm.dispose();
        return;
      }

      this.#realm = realm;
      await Promise.race([realm.executeInitialScripts(), fatalRealm]);
      this.#assertCurrentGeneration(generation, controller.signal);
      const revealSettlement = realm.reveal();
      if (revealSettlement !== undefined) {
        await Promise.race([revealSettlement, fatalRealm]);
      }
      this.#assertCurrentGeneration(generation, controller.signal);
      this.#status = VFrameStatus.Ready;
      this.#dispatch<VFrameLoadEventDetail>("v-frame-load", {
        url: this.#currentURL ?? finalURL,
      });
    } catch (error) {
      if (fatalRealmFailure !== null) {
        throw error;
      }
      if (
        this.#generation !== generation ||
        controller.signal.aborted ||
        isAbortError(error)
      ) {
        return;
      }

      const phase = this.#currentURL === null ? "entry" : "bootstrap";
      const url = this.#currentURL ?? requestedURL.href;
      this.#failGeneration(generation, { phase, url, error });
      throw error;
    }
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
    this.#controller?.abort();
    this.#controller = null;
    this.#currentURL = null;
    this.#status = VFrameStatus.Error;
    this.#dispatchError({ ...failure, fatal: true });
  }

  #destroyRealm(): void {
    const realm = this.#realm;
    this.#realm = null;
    realm?.dispose();
    this.#controller?.abort();
    this.#controller = null;
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
      source: this.#root.innerHTML,
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
