import {
  abortError,
  connectRealmIframe,
  type ConnectedRealmIframe,
  createRealm,
  type CreateRealmOptions,
  type RealmFailure,
  type VFrameRealm,
} from "./realm/index.js";
import { type DocumentHistoryMode, VirtualHistorySession } from "./history.js";
import { parseEntryURL } from "./url.js";
import { AdoptionState } from "./realm/adoption-state.js";
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

function loadingNavigationError(method: string): DOMException {
  return new DOMException(
    `v-frame cannot ${method} while a replacement document is loading`,
    "InvalidStateError",
  );
}

function canceledNavigationError(url: string): DOMException {
  return new DOMException(`v-frame navigation to ${url} was canceled`, "AbortError");
}

interface AdoptedMarkup {
  source: string;
  previewNodes: Node[];
  state: AdoptionState;
}

/** What a staged load falls back to if it fails: the guest that was committed. */
interface PreviousGuest {
  realm: VFrameRealm | null;
  realmController: AbortController | null;
  historySession: VirtualHistorySession | null;
  url: string | null;
}

/** What `#load` learns while it runs and the realm callbacks must see. */
interface LoadProgress {
  finalURL: string;
  failureURL: string;
  // While a load is staged behind a live guest, the URL the host observes still
  // belongs to that guest; this realm owns it only once it goes live.
  staged: boolean;
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

function traversalSupersededError(): DOMException {
  return new DOMException("The v-frame traversal was superseded", "AbortError");
}

function effectiveCredentials(value: string | null): VFrameCredentials {
  return value === "omit" || value === "include" || value === "same-origin"
    ? value
    : "same-origin";
}

function effectiveNavigation(value: string | null): VFrameNavigation {
  return value === "host" ? "host" : "guest";
}

function effectiveTrustedTypesPolicyName(value: string | null): string | null {
  const name = value?.trim() ?? "";
  return name === "" ? null : name;
}

// The string form of `trusted-types-policy` only names a policy the host's CSP
// `trusted-types` directive already allows. It passes every value through
// unchanged, so it grants the guest the right to create the policy and nothing more.
function allowlistedTrustedTypesPolicy(name: string): VFrameTrustedTypesPolicyDefinition {
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
  #status: VFrameStatus = VFrameStatus.Idle;
  #currentURL: string | null = null;
  // The guest's index in its own session, or null while no realm has reported one.
  #currentPosition: number | null = null;
  #realm: VFrameRealm | null = null;
  #loadingRealm: VFrameRealm | null = null;
  #realmController: AbortController | null = null;
  #loadController: AbortController | null = null;
  #historySession: VirtualHistorySession | null = null;
  // Only ever grows, so a number identifies one load for the element's lifetime.
  #generation = 0;
  // The newest guest-initiated navigation still waiting for its microtask.
  #pendingGuestLoad: object | null = null;
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
    return effectiveCredentials(this.getAttribute("credentials"));
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
    return effectiveNavigation(this.getAttribute("navigation"));
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

  get status(): VFrameStatus {
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
    // A staged load has silenced the live guest, so delegating would surface as a
    // listener-canceled navigation; "canceled" has to keep meaning exactly that.
    if (this.#loadController !== null) {
      return Promise.reject(loadingNavigationError("navigate"));
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
    if (this.#loadController !== null) {
      throw loadingNavigationError("traverse");
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

  // A state-preserving move (`Element.prototype.moveBefore`) keeps the realm iframe
  // inside the shadow root alive, so the guest has nothing to restart. Defining this
  // is what opts out of the disconnect/connect pair; a plain remove + insert still
  // runs both and reloads the guest.
  connectedMoveCallback(): void {}

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
    // The attribute falls back to a default for values it does not recognise, so two
    // different strings can mean the same configuration. Only a real change reloads.
    if (name === "credentials") {
      if (effectiveCredentials(oldValue) === effectiveCredentials(newValue)) {
        return;
      }
    } else if (name === "navigation") {
      if (effectiveNavigation(oldValue) === effectiveNavigation(newValue)) {
        return;
      }
    } else if (name === "trusted-types-policy") {
      if (
        effectiveTrustedTypesPolicyName(oldValue) ===
        effectiveTrustedTypesPolicyName(newValue)
      ) {
        return;
      }
    }

    this.#configurationChanged(name === "src");
  }

  #configurationChanged(stageMarkup = false): void {
    if (!this.#connected) {
      return;
    }

    const source = this.#loadSource();
    if (source === null) {
      this.#resetToIdle();
      return;
    }

    this.#observeLoad(
      this.#startLoad(
        this.#frameLoad({
          source,
          stage: stageMarkup,
          boundNavigation: this.navigation === "host",
        }),
      ),
    );
  }

  reload(): Promise<void> {
    const source = this.#loadSource();
    if (!this.#connected || source === null) {
      this.#resetToIdle();
      return Promise.reject(
        new DOMException(
          "v-frame cannot reload without a connected frame that has a src",
          "InvalidStateError",
        ),
      );
    }

    return this.#startLoad(
      this.#frameLoad({
        source: this.#currentURL ?? source,
        historySession: this.#historySession?.clone() ?? null,
        boundNavigation: this.navigation === "host",
      }),
    ).then((committed) => {
      if (!committed) {
        throw abortError();
      }
    });
  }

  #loadSource(): string | null {
    return !this.hasAttribute("src") || this.src.trim() === "" ? null : this.src;
  }

  #effectiveTrustedTypesPolicy(): VFrameTrustedTypesPolicyDefinition | null {
    if (this.#trustedTypesPolicy !== null) {
      return this.#trustedTypesPolicy;
    }
    const name = effectiveTrustedTypesPolicyName(
      this.getAttribute("trusted-types-policy"),
    );
    return name === null ? null : allowlistedTrustedTypesPolicy(name);
  }

  #resetToIdle(): void {
    this.#generation += 1;
    this.#pendingGuestLoad = null;
    this.#releaseGuest(true);
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

  #observeLoad(load: Promise<unknown>): void {
    void load.catch(() => undefined);
  }

  // A load that replaces the document while a guest is live is staged behind it, so
  // the guest stays on screen until the replacement is ready.
  #frameLoad(options: {
    source: string;
    historySession?: VirtualHistorySession | null;
    navigationKind?: VFrameNavigationKind | null;
    boundNavigation?: boolean;
    stage?: boolean;
  }): FrameLoad {
    return {
      source: options.source,
      adoptedMarkup: null,
      historySession: options.historySession ?? null,
      stageMarkup: (options.stage ?? true) && this.#realm !== null,
      boundNavigation: options.boundNavigation ?? false,
      navigationKind: options.navigationKind ?? null,
    };
  }

  // A navigation the guest asked for begins on a microtask, so the guest's own call
  // stack finishes before its document is replaced. The latest request wins: another
  // guest navigation, or a host `src` change, made before the microtask runs clears
  // the token (`#startLoad` does), and the request that lost settles as superseded
  // rather than vanishing after the guest was told it was allowed.
  #deferGuestLoad(
    ownsController: () => boolean,
    load: () => FrameLoad,
    superseded: () => DOMException = abortError,
  ): Promise<void> {
    const token = {};
    this.#pendingGuestLoad = token;
    return new Promise<void>((resolve, reject) => {
      queueMicrotask(() => {
        if (this.#pendingGuestLoad !== token || !ownsController()) {
          reject(superseded());
          return;
        }
        this.#startLoad(load()).then((committed) => {
          // The load reports its own commit, so a listener that starts another load
          // from `v-frame-navigated` does not turn this navigation into a rejection.
          if (committed) {
            resolve();
          } else {
            reject(superseded());
          }
        }, reject);
      });
    });
  }

  // Resolves true when this load committed its guest, false when it was superseded or
  // released first; it rejects when the load failed.
  #startLoad(load: FrameLoad): Promise<boolean> {
    // During reveal the realm still belongs to the load being aborted below.
    // It cannot be a rollback target until the handoff has finished.
    if (this.#loadController !== null && this.#loadController === this.#realmController) {
      load = { ...load, stageMarkup: false };
    }
    this.#loadController?.abort();
    this.#loadingRealm = null;
    this.#pendingGuestLoad = null;
    const generation = this.#generation + 1;
    this.#generation = generation;
    const previous: PreviousGuest = load.stageMarkup
      ? {
          realm: this.#realm,
          realmController: this.#realmController,
          historySession: this.#historySession,
          url: this.#currentURL,
        }
      : { realm: null, realmController: null, historySession: null, url: null };
    if (!load.stageMarkup) {
      this.#releaseGuest(true);
    }
    const controller = new AbortController();
    const adoptedState = load.adoptedMarkup?.state;
    if (adoptedState) {
      controller.signal.addEventListener("abort", () => adoptedState.dispose(), {
        once: true,
      });
    }
    this.#loadController = controller;
    return this.#load(generation, controller, load, previous);
  }

  async #load(
    generation: number,
    controller: AbortController,
    load: FrameLoad,
    previous: PreviousGuest,
  ): Promise<boolean> {
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
    const progress: LoadProgress = {
      finalURL: requestedURL.href,
      failureURL: requestedURL.href,
      staged: previous.realm !== null,
    };
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
        progress.finalURL = responseURL.href;
      } else {
        connection = await connectRealm(requestedURL.href);
        source = load.adoptedMarkup.source;
      }
      entryResolved = true;
      progress.failureURL = progress.finalURL;
      if (new URL(progress.finalURL).origin !== this.ownerDocument.location.origin) {
        throw new TypeError(
          `v-frame route ${progress.finalURL} must share host origin ${this.ownerDocument.location.origin}`,
        );
      }
      if (progress.finalURL !== requestedURL.href) {
        const realmWindow = connection.iframe.contentWindow;
        if (realmWindow === null) {
          throw new Error(
            `v-frame redirect ${requestedURL.href} to ${progress.finalURL} lost its execution realm`,
          );
        }
        realmWindow.history.replaceState(null, "", progress.finalURL);
      }
      const historySession =
        load.historySession ?? new VirtualHistorySession(progress.finalURL);
      historySession.replaceCurrentURL(progress.finalURL);
      if (!progress.staged) {
        this.#currentURL = progress.finalURL;
      }

      // A load owns its callbacks while it is the load in flight, and a committed realm
      // owns them while nothing is loading behind it: a staged replacement silences the
      // live guest until it commits or fails and hands the guest back.
      const ownsController = () =>
        !controller.signal.aborted &&
        (this.#loadController === controller ||
          (this.#realmController === controller && this.#loadController === null));
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
                state: load.adoptedMarkup.state,
              },
        pageURL: progress.finalURL,
        historySession,
        boundNavigation: load.boundNavigation,
        stageMarkup: load.stageMarkup,
        restoreScroll: load.navigationKind === "traverse",
        credentials: this.credentials,
        signal: controller.signal,
        getNonce: () => this.nonce,
        fetchStylesheet: (url) => this.#fetchStylesheet(url, controller.signal),
        ...this.#realmCallbacks(
          load.boundNavigation,
          historySession,
          progress,
          ownsController,
        ),
      });
      pendingRealm.iframe = null;

      if (this.#generation !== generation || controller.signal.aborted) {
        realm.dispose();
        return false;
      }

      if (previous.realm === null) {
        this.#loadingRealm = realm;
      }

      await realm.executeInitialScripts();
      this.#assertCurrentGeneration(generation, controller.signal);
      previous.realm?.dispose();
      previous.realmController?.abort();
      // `previous.realm === null` is what tells the catch path a throw from
      // `realm.reveal()` below fails this generation instead of rolling back to a
      // guest that was just disposed.
      previous.realm = null;
      this.#realm = realm;
      this.#loadingRealm = null;
      this.#realmController = controller;
      this.#historySession = historySession;
      progress.staged = false;
      // Publish the guest URL before the handoff restores its state. Until reveal
      // returns, the realm still belongs to this load and cannot be a rollback target.
      const navigated = this.#commitURL(progress.finalURL, load.navigationKind);
      // An SSR handoff runs guest and host code while revealing: it can throw, which
      // must still fail this load, or disconnect the frame, which already released it.
      realm.reveal();
      if (this.#generation !== generation || controller.signal.aborted) {
        return false;
      }
      this.#loadController = null;
      this.#setStatus(VFrameStatus.Ready);
      // Lifecycle listeners now see a fully committed guest.
      const loadedURL = this.#currentURL ?? progress.finalURL;
      // `v-frame-navigated` still fires for a load that committed. If its listener
      // supersedes this load (removes the frame, changes `src`), the load itself
      // still counts as committed but never reports `v-frame-load`.
      this.#dispatchNavigated(navigated);
      if (this.#generation !== generation || controller.signal.aborted) {
        return true;
      }
      this.#dispatch<VFrameLoadEventDetail>("v-frame-load", { url: loadedURL });
      return true;
    } catch (error) {
      pendingRealm.iframe?.remove();
      if (
        this.#generation !== generation ||
        controller.signal.aborted ||
        isAbortError(error)
      ) {
        return false;
      }

      const failure = {
        phase:
          realmConnectionFailed || entryResolved
            ? ("bootstrap" as const)
            : ("entry" as const),
        url: progress.failureURL,
        error,
      };
      this.#finishFailedLoad(generation, controller, previous, failure);
      throw error;
    }
  }

  async #fetchStylesheet(
    url: string,
    signal: AbortSignal,
  ): Promise<{ text: string; url: string }> {
    const response = await fetch(url, { credentials: this.credentials, signal });
    if (!response.ok || response.type === "opaque") {
      throw new TypeError(
        `v-frame stylesheet ${url} returned ${response.status} ${response.statusText}`,
      );
    }
    return { text: await response.text(), url: response.url || url };
  }

  // The callbacks a realm uses to ask the host to navigate. They share the load's
  // progress and its ownership test, so a realm the host has moved past is ignored.
  #realmCallbacks(
    boundNavigation: boolean,
    historySession: VirtualHistorySession,
    progress: LoadProgress,
    ownsController: () => boolean,
  ): Pick<
    CreateRealmOptions,
    | "onURLChange"
    | "onNavigate"
    | "onDocumentNavigation"
    | "onDocumentTraversal"
    | "onShellNavigation"
    | "onNativeLocationNavigation"
    | "onError"
  > {
    return {
      onURLChange: (url, kind) => {
        progress.finalURL = url;
        progress.failureURL = url;
        if (ownsController() && !progress.staged) {
          this.#dispatchNavigated(this.#commitURL(url, kind));
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
      onDocumentNavigation: (detail, mode) => {
        if (!ownsController() || !this.#dispatchNavigate(detail) || !ownsController()) {
          return false;
        }
        historySession.captureScroll(this.scrollLeft, this.scrollTop);
        const nextSession = historySession.forkDocumentNavigation(detail.to, mode);
        this.#observeLoad(
          this.#deferGuestLoad(ownsController, () =>
            this.#frameLoad({
              source: detail.to,
              historySession: nextSession,
              navigationKind: detail.kind,
            }),
          ),
        );
        return true;
      },
      onDocumentTraversal: (nextSession) =>
        this.#deferGuestLoad(
          ownsController,
          () =>
            this.#frameLoad({
              source: nextSession.currentURL,
              historySession: nextSession,
              navigationKind: "traverse",
            }),
          traversalSupersededError,
        ),
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
        if (boundNavigation) {
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
        historySession.captureScroll(this.scrollLeft, this.scrollTop);
        const nextSession =
          mode === "reload"
            ? historySession.clone()
            : historySession.forkDocumentNavigation(detail.to, mode);
        this.#observeLoad(
          this.#deferGuestLoad(ownsController, () =>
            this.#frameLoad({
              source: nextSession.currentURL,
              historySession: nextSession,
              navigationKind: detail.kind,
            }),
          ),
        );
      },
      onError: (failure) => {
        if (ownsController()) {
          this.#dispatchError({ ...failure, fatal: false });
        }
      },
    };
  }

  #finishFailedLoad(
    generation: number,
    controller: AbortController,
    previous: PreviousGuest,
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

    // A failed replacement hands back the guest that was committed. That guest is
    // ready whatever the frame was doing when this load began, and the generation
    // stays where it is: numbers are never reused, so no dead load can match a
    // live one. The restored realm owns its callbacks again once nothing is loading.
    this.#realm = previous.realm;
    this.#realmController = previous.realmController;
    this.#historySession = previous.historySession;
    this.#currentURL = previous.url;
    this.#setStatus(VFrameStatus.Ready);
    this.#dispatchError({ ...failure, fatal: false });
  }

  #assertCurrentGeneration(generation: number, signal: AbortSignal): void {
    if (this.#generation !== generation || signal.aborted) {
      throw abortError();
    }
  }

  #failGeneration(generation: number, failure: RealmFailure): void {
    if (this.#generation !== generation) {
      return;
    }

    this.#generation = generation + 1;
    // A failed first load leaves whatever the shadow root holds, such as adopted
    // preview markup, for the host to keep showing.
    this.#releaseGuest(false);
    this.#setStatus(VFrameStatus.Error);
    this.#dispatchError({ ...failure, fatal: true });
  }

  // The one way a guest is released: every realm, controller and session goes, along
  // with the URL and, unless the caller needs the shadow root's contents, its children.
  #releaseGuest(clearRoot: boolean): void {
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
    this.#currentURL = null;
    this.#currentPosition = null;
    if (clearRoot) {
      for (const child of Array.from(this.#root.children)) {
        child.remove();
      }
    }
  }

  #setStatus(status: VFrameStatus): void {
    this.#status = status;
    this.#internals.states.clear();
    this.#internals.states.add(status);
  }

  #consumeAdoptedMarkup(): AdoptedMarkup | null {
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
      state: new AdoptionState(html as HTMLElement, this.#root),
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

  // Records the guest's new URL and returns the `v-frame-navigated` detail it implies,
  // or null when nothing moved. Dispatching is separate so a load can finish
  // committing before any listener runs.
  #commitURL(
    url: string,
    kind: VFrameNavigationKind | null,
  ): VFrameNavigatedEventDetail | null {
    const from = this.#currentURL;
    const fromPosition = this.#currentPosition;
    const position = this.#historyPosition();
    this.#currentURL = url;
    this.#currentPosition = position;
    if (kind === null || from === null) {
      return null;
    }
    // Pushing the URL the guest is already on still moves the session, and
    // `canGoBack` moves with it, so the position decides — not the URL string.
    // Until a realm has reported a position there is nothing to compare, and the
    // URL is the only signal.
    const moved =
      from !== url ||
      (fromPosition !== null && position !== null && fromPosition !== position);
    return moved ? { from, to: url, kind } : null;
  }

  // The past-tense counterpart of `v-frame-navigate`: the guest URL is already the new
  // one, so a host router can read `currentURL`, `canGoBack` and `canGoForward` here.
  #dispatchNavigated(detail: VFrameNavigatedEventDetail | null): void {
    if (detail !== null) {
      this.#dispatch<VFrameNavigatedEventDetail>("v-frame-navigated", detail);
    }
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
