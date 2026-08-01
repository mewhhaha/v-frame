import { resolveHistoryURL } from "./url.js";
import type {
  VFrameNavigateEventDetail,
  VFrameNavigationKind,
  VFrameWindow,
} from "./types.js";

interface HistoryEntry {
  url: string;
  state: unknown;
  documentID: number;
}

export type DocumentHistoryMode = "push" | "replace";

/** The outcome of a navigation the host drove through the element's imperative API. */
export type NavigationOutcome = "applied" | "canceled" | "unavailable";

/** What `VFrameElement` drives; both history implementations satisfy it. */
export interface NavigationControls {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  navigate(url: string, mode: DocumentHistoryMode): NavigationOutcome;
  traverse(delta: number): NavigationOutcome;
}

export interface NavigateDispatchOptions {
  /** Host-initiated navigations stay cancelable whatever their kind. */
  cancelable: boolean;
}

type HostHistoryChange = "push" | "replace" | "traverse";

type HostNavigationWindow = Window & { readonly navigation: Navigation };

function hostNavigation(hostWindow: Window): Navigation {
  return (hostWindow as HostNavigationWindow).navigation;
}

/**
 * The runtime already refuses to boot without the Navigation API, so the host's
 * `navigation` object reports every same-document entry change — including
 * `pushState` and `replaceState`. Observing it keeps v-frame out of the host's
 * `history` methods, which every mainstream shell router wraps for itself.
 */
function observeHostHistory(
  hostWindow: Window,
  callback: (change: HostHistoryChange) => void,
): () => void {
  const lifetime = new AbortController();
  hostNavigation(hostWindow).addEventListener(
    "currententrychange",
    (event) => {
      const change = event.navigationType;
      // `updateCurrentEntry` reports a null type and a reload replaces the whole
      // document, so neither moves the guest.
      if (change === "push" || change === "replace" || change === "traverse") {
        callback(change);
      }
    },
    { signal: lifetime.signal },
  );
  return () => lifetime.abort();
}

export class VirtualHistorySession {
  readonly #entries: HistoryEntry[];
  #index: number;
  #nextDocumentID: number;
  scrollRestoration: ScrollRestoration;

  constructor(
    initialURL: string,
    entries?: HistoryEntry[],
    index?: number,
    nextDocumentID?: number,
    scrollRestoration?: ScrollRestoration,
  ) {
    this.#entries = entries ?? [{ url: initialURL, state: null, documentID: 0 }];
    this.#index = index ?? 0;
    this.#nextDocumentID = nextDocumentID ?? 1;
    this.scrollRestoration = scrollRestoration ?? "auto";
  }

  get length(): number {
    return this.#entries.length;
  }

  get currentURL(): string {
    return this.currentEntry.url;
  }

  get currentState(): unknown {
    return this.currentEntry.state;
  }

  get currentDocumentID(): number {
    return this.currentEntry.documentID;
  }

  get currentIndex(): number {
    return this.#index;
  }

  get currentEntry(): HistoryEntry {
    const entry = this.#entries[this.#index];
    if (entry === undefined) {
      throw new Error(`v-frame history has no entry at index ${this.#index}`);
    }
    return entry;
  }

  clone(): VirtualHistorySession {
    return new VirtualHistorySession(
      this.currentURL,
      this.#entries.map((entry) => ({ ...entry })),
      this.#index,
      this.#nextDocumentID,
      this.scrollRestoration,
    );
  }

  forkDocumentNavigation(url: string, mode: DocumentHistoryMode): VirtualHistorySession {
    const session = this.clone();
    const entry = {
      url,
      state: null,
      documentID: session.#nextDocumentID,
    };
    session.#nextDocumentID += 1;
    if (mode === "replace") {
      session.#entries[session.#index] = entry;
      return session;
    }

    session.#entries.splice(session.#index + 1);
    session.#entries.push(entry);
    session.#index = session.#entries.length - 1;
    return session;
  }

  forkTraversal(index: number): VirtualHistorySession {
    const session = this.clone();
    session.#index = index;
    return session;
  }

  entryAt(index: number): HistoryEntry | undefined {
    return this.#entries[index];
  }

  replaceCurrentURL(url: string): void {
    this.#entries[this.#index] = { ...this.currentEntry, url };
  }

  pushState(url: string, state: unknown): void {
    this.#entries.splice(this.#index + 1);
    this.#entries.push({
      url,
      state,
      documentID: this.currentDocumentID,
    });
    this.#index = this.#entries.length - 1;
  }

  replaceState(url: string, state: unknown): void {
    this.#entries[this.#index] = {
      url,
      state,
      documentID: this.currentDocumentID,
    };
  }

  navigateFragment(url: string, state: unknown): void {
    if (url === this.currentURL) {
      this.replaceState(url, state);
      return;
    }
    this.pushState(url, state);
  }

  traverse(index: number): void {
    this.#index = index;
  }
}

export interface VirtualHistoryOptions {
  window: VFrameWindow;
  session: VirtualHistorySession;
  getBaseURL(): string;
  onNavigate(
    detail: VFrameNavigateEventDetail,
    options?: NavigateDispatchOptions,
  ): boolean;
  onURLChange(url: string, kind: VFrameNavigationKind | null): void;
  onDocumentTraversal(session: VirtualHistorySession): void;
}

export interface BoundHistoryOptions {
  window: VFrameWindow;
  hostWindow: Window;
  onNavigate(
    detail: VFrameNavigateEventDetail,
    options?: NavigateDispatchOptions,
  ): boolean;
  onURLChange(url: string, kind: VFrameNavigationKind | null): void;
}

export class BoundHistory implements NavigationControls {
  readonly #window: VFrameWindow;
  readonly #childHistory: History;
  readonly #hostWindow: Window;
  readonly #nativeChildReplaceState: History["replaceState"];
  readonly #onNavigate: BoundHistoryOptions["onNavigate"];
  readonly #onURLChange: BoundHistoryOptions["onURLChange"];
  readonly #listenerLifetime = new AbortController();
  #currentURL: string;
  // Set while this frame is the one driving the host history, which both suppresses
  // the echo back into the guest and names the navigation the observer sees.
  #originatingKind: VFrameNavigationKind | null = null;
  #disposed = false;

  constructor(options: BoundHistoryOptions) {
    this.#window = options.window;
    this.#childHistory = options.window.history;
    this.#hostWindow = options.hostWindow;
    this.#nativeChildReplaceState = options.window.history.replaceState.bind(
      options.window.history,
    );
    this.#onNavigate = options.onNavigate;
    this.#onURLChange = options.onURLChange;
    this.#currentURL = options.hostWindow.location.href;
  }

  install(): void {
    const boundHistory = this;
    Object.defineProperties(this.#window.History.prototype, {
      length: {
        configurable: true,
        get(this: History) {
          boundHistory.#assertReceiver(this);
          return boundHistory.#hostWindow.history.length;
        },
      },
      state: {
        configurable: true,
        get(this: History) {
          boundHistory.#assertReceiver(this);
          return boundHistory.#hostWindow.history.state;
        },
      },
      scrollRestoration: {
        configurable: true,
        get(this: History) {
          boundHistory.#assertReceiver(this);
          return boundHistory.#hostWindow.history.scrollRestoration;
        },
        set(this: History, value: ScrollRestoration) {
          boundHistory.#assertReceiver(this);
          if (boundHistory.#disposed) {
            return;
          }
          boundHistory.#hostWindow.history.scrollRestoration = value;
        },
      },
      pushState: {
        configurable: true,
        writable: true,
        value: function pushState(this: History, state: unknown, unused: string) {
          boundHistory.#assertReceiver(this);
          boundHistory.#assertRequiredArguments("pushState", arguments.length, 2);
          boundHistory.#changeHostHistory(
            "push",
            state,
            unused,
            arguments[2] as string | URL | null | undefined,
          );
        },
      },
      replaceState: {
        configurable: true,
        writable: true,
        value: function replaceState(this: History, state: unknown, unused: string) {
          boundHistory.#assertReceiver(this);
          boundHistory.#assertRequiredArguments("replaceState", arguments.length, 2);
          boundHistory.#changeHostHistory(
            "replace",
            state,
            unused,
            arguments[2] as string | URL | null | undefined,
          );
        },
      },
      back: {
        configurable: true,
        writable: true,
        value(this: History) {
          boundHistory.#assertReceiver(this);
          if (!boundHistory.#disposed) {
            boundHistory.#hostWindow.history.back();
          }
        },
      },
      forward: {
        configurable: true,
        writable: true,
        value(this: History) {
          boundHistory.#assertReceiver(this);
          if (!boundHistory.#disposed) {
            boundHistory.#hostWindow.history.forward();
          }
        },
      },
      go: {
        configurable: true,
        writable: true,
        value(this: History, delta?: number) {
          boundHistory.#assertReceiver(this);
          if (!boundHistory.#disposed) {
            boundHistory.#hostWindow.history.go(delta);
          }
        },
      },
    });

    const stopObserving = observeHostHistory(this.#hostWindow, (change) => {
      this.#adoptHostChange(change);
    });
    this.#listenerLifetime.signal.addEventListener("abort", stopObserving, {
      once: true,
    });
    this.#synchronizeFromHost(null, false);
  }

  get canGoBack(): boolean {
    return !this.#disposed && hostNavigation(this.#hostWindow).canGoBack;
  }

  get canGoForward(): boolean {
    return !this.#disposed && hostNavigation(this.#hostWindow).canGoForward;
  }

  navigate(url: string, mode: DocumentHistoryMode): NavigationOutcome {
    if (this.#disposed) {
      return "unavailable";
    }
    const from = this.#currentURL;
    const to = new this.#window.URL(url, from).href;
    if (!this.#onNavigate({ from, to, kind: mode, state: null }, { cancelable: true })) {
      return "canceled";
    }
    if (this.#disposed) {
      return "unavailable";
    }
    this.#changeHostEntry(mode, null, to);
    this.#dispatchActivationEvents(from);
    return "applied";
  }

  traverse(delta: number): NavigationOutcome {
    if (this.#disposed) {
      return "unavailable";
    }
    // The shell owns the session, so its traversal reaches the guest through the
    // same observer a user-driven back button would.
    this.#hostWindow.history.go(delta);
    return "applied";
  }

  navigateFragment(url: string, state: unknown = null): boolean {
    if (this.#disposed) {
      return false;
    }
    const from = this.#currentURL;
    const to = new this.#window.URL(url, from).href;
    if (!this.#onNavigate({ from, to, kind: "fragment", state })) {
      return false;
    }
    this.#changeHostEntry("push", state, to, "fragment");
    this.#dispatchActivationEvents(from);
    return true;
  }

  restoreMirroredURL(): void {
    if (!this.#disposed) {
      this.#mirrorHostEntry();
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#listenerLifetime.abort();
  }

  #changeHostHistory(
    change: DocumentHistoryMode,
    state: unknown,
    unused: string,
    url?: string | URL | null,
  ): void {
    if (this.#disposed) {
      return;
    }
    const to = resolveHistoryURL(
      url,
      this.#hostWindow.location.href,
      this.#hostWindow.location.href,
      this.#window,
    );
    const nextState = this.#window.structuredClone(state);
    this.#onNavigate({
      from: this.#currentURL,
      to,
      kind: change,
      state: nextState,
    });
    if (this.#disposed) {
      return;
    }
    this.#changeHostEntry(change, nextState, url, change, unused);
  }

  // Every host history change this frame originates is tagged, so the observer can
  // mirror it without echoing a second activation back into the guest.
  #changeHostEntry(
    change: DocumentHistoryMode,
    state: unknown,
    url?: string | URL | null,
    kind: VFrameNavigationKind = change,
    unused = "",
  ): void {
    this.#originatingKind = kind;
    try {
      this.#hostWindow.history[change === "push" ? "pushState" : "replaceState"](
        state,
        unused,
        url,
      );
    } finally {
      this.#originatingKind = null;
    }
  }

  #adoptHostChange(change: HostHistoryChange): void {
    if (this.#disposed) {
      return;
    }
    const originatingKind = this.#originatingKind;
    if (originatingKind !== null) {
      this.#synchronizeFromHost(originatingKind, false);
      return;
    }
    if (change === "traverse") {
      this.#onNavigate({
        from: this.#currentURL,
        to: this.#hostWindow.location.href,
        kind: "traverse",
        state: this.#hostWindow.history.state,
      });
      if (this.#disposed) {
        return;
      }
    }
    this.#synchronizeFromHost(change, true);
  }

  #synchronizeFromHost(kind: VFrameNavigationKind | null, dispatchEvents: boolean): void {
    if (this.#disposed) {
      return;
    }
    const previousURL = this.#currentURL;
    this.#currentURL = this.#hostWindow.location.href;
    this.#mirrorHostEntry();
    this.#onURLChange(this.#currentURL, kind);
    if (dispatchEvents) {
      this.#dispatchActivationEvents(previousURL);
    }
  }

  #mirrorHostEntry(): void {
    this.#nativeChildReplaceState(
      this.#hostWindow.history.state,
      "",
      this.#hostWindow.location.href,
    );
  }

  #dispatchActivationEvents(previousURL: string): void {
    this.#window.dispatchEvent(
      new this.#window.PopStateEvent("popstate", {
        state: this.#hostWindow.history.state,
      }),
    );
    const previousHash = new this.#window.URL(previousURL).hash;
    const currentHash = new this.#window.URL(this.#currentURL).hash;
    if (previousHash !== currentHash) {
      this.#window.dispatchEvent(
        new this.#window.HashChangeEvent("hashchange", {
          oldURL: previousURL,
          newURL: this.#currentURL,
        }),
      );
    }
  }

  #assertReceiver(receiver: History): void {
    if (receiver !== this.#childHistory) {
      throw new this.#window.TypeError("Illegal invocation");
    }
  }

  #assertRequiredArguments(method: string, actual: number, required: number): void {
    if (actual < required) {
      throw new this.#window.TypeError(
        `Failed to execute '${method}' on 'History': ${required} arguments required, but only ${actual} present.`,
      );
    }
  }
}

export class VirtualHistory implements NavigationControls {
  readonly #window: VFrameWindow;
  readonly #history: History;
  readonly #nativeReplaceState: History["replaceState"];
  readonly #nativeLengthGetter: (() => number) | null;
  readonly #onNavigate: VirtualHistoryOptions["onNavigate"];
  readonly #onURLChange: VirtualHistoryOptions["onURLChange"];
  readonly #onDocumentTraversal: VirtualHistoryOptions["onDocumentTraversal"];
  readonly #getBaseURL: VirtualHistoryOptions["getBaseURL"];
  readonly #session: VirtualHistorySession;
  // Stored entry state stays pristine; each activation exposes its own clone,
  // so mutations of history.state do not survive back/forward traversal.
  #activeState: unknown = null;
  #nativeHistoryLength = 0;
  #disposed = false;

  constructor(options: VirtualHistoryOptions) {
    this.#window = options.window;
    this.#history = options.window.history;
    this.#nativeReplaceState = options.window.history.replaceState.bind(
      options.window.history,
    );
    const nativeLengthGetter = Object.getOwnPropertyDescriptor(
      options.window.History.prototype,
      "length",
    )?.get;
    this.#nativeLengthGetter =
      nativeLengthGetter === undefined
        ? null
        : () => Number(nativeLengthGetter.call(this.#history));
    this.#onNavigate = options.onNavigate;
    this.#onURLChange = options.onURLChange;
    this.#onDocumentTraversal = options.onDocumentTraversal;
    this.#getBaseURL = options.getBaseURL;
    this.#session = options.session;
    this.#activeState = this.#cloneState(options.session.currentState);
  }

  get currentURL(): string {
    return this.#session.currentURL;
  }

  get state(): unknown {
    return this.#activeState;
  }

  get canGoBack(): boolean {
    return !this.#disposed && this.#session.currentIndex > 0;
  }

  get canGoForward(): boolean {
    return !this.#disposed && this.#session.currentIndex < this.#session.length - 1;
  }

  install(): void {
    const controller = this;

    Object.defineProperties(this.#window.History.prototype, {
      length: {
        configurable: true,
        get(this: History) {
          controller.#assertReceiver(this);
          return controller.#session.length;
        },
      },
      state: {
        configurable: true,
        get(this: History) {
          controller.#assertReceiver(this);
          return controller.state;
        },
      },
      scrollRestoration: {
        configurable: true,
        get(this: History) {
          controller.#assertReceiver(this);
          return controller.#session.scrollRestoration;
        },
        set(this: History, value: ScrollRestoration) {
          controller.#assertReceiver(this);
          if (controller.#disposed) {
            return;
          }
          let serializedValue: string;
          try {
            serializedValue = `${value}`;
          } catch (cause) {
            throw new controller.#window.TypeError(
              "History scrollRestoration cannot be converted to a string",
              { cause },
            );
          }
          if (serializedValue === "auto" || serializedValue === "manual") {
            controller.#session.scrollRestoration = serializedValue;
          }
        },
      },
      pushState: {
        configurable: true,
        writable: true,
        value: function pushState(this: History, state: unknown, _unused: string) {
          controller.#assertReceiver(this);
          if (controller.#disposed) {
            return;
          }
          controller.#assertRequiredArguments("pushState", arguments.length, 2);
          const url = arguments[2] as string | URL | null | undefined;
          controller.pushState(state, url);
        },
      },
      replaceState: {
        configurable: true,
        writable: true,
        value: function replaceState(this: History, state: unknown, _unused: string) {
          controller.#assertReceiver(this);
          if (controller.#disposed) {
            return;
          }
          controller.#assertRequiredArguments("replaceState", arguments.length, 2);
          const url = arguments[2] as string | URL | null | undefined;
          controller.replaceState(state, url);
        },
      },
      back: {
        configurable: true,
        writable: true,
        value: function back(this: History) {
          controller.#assertReceiver(this);
          controller.go(-1);
        },
      },
      forward: {
        configurable: true,
        writable: true,
        value: function forward(this: History) {
          controller.#assertReceiver(this);
          controller.go(1);
        },
      },
      go: {
        configurable: true,
        writable: true,
        value: function go(this: History, delta: unknown = 0) {
          controller.#assertReceiver(this);
          if (controller.#disposed) {
            return;
          }
          controller.go(controller.#coerceDelta(delta));
        },
      },
    });

    this.#mirrorEntry(this.currentURL, this.state);
    this.#nativeHistoryLength = this.#readNativeHistoryLength();
  }

  /**
   * A host-driven route change. It carries no state and activates the guest the way a
   * traversal does, because a router only re-renders when the session tells it to.
   */
  navigate(url: string, mode: DocumentHistoryMode): NavigationOutcome {
    if (this.#disposed) {
      return "unavailable";
    }

    const nextURL = resolveHistoryURL(
      url,
      this.#getBaseURL(),
      this.currentURL,
      this.#window,
    );
    if (!this.#approve(nextURL, mode, null, true)) {
      return "canceled";
    }

    const previousURL = this.currentURL;
    this.#mirrorEntry(nextURL, null);
    if (mode === "replace") {
      this.#session.replaceState(nextURL, null);
    } else {
      this.#session.pushState(nextURL, null);
    }
    this.#activeState = null;
    this.#commit(mode, "activate", previousURL);
    return "applied";
  }

  traverse(delta: number): NavigationOutcome {
    if (this.#disposed) {
      return "unavailable";
    }
    return this.#traverse(Math.trunc(delta), true);
  }

  pushState(state: unknown, url?: string | URL | null): boolean {
    if (this.#disposed) {
      return false;
    }

    const nextURL = resolveHistoryURL(
      url,
      this.#getBaseURL(),
      this.currentURL,
      this.#window,
    );
    const nextState = this.#cloneState(state);
    if (!this.#approve(nextURL, "push", nextState)) {
      return false;
    }

    this.#mirrorEntry(nextURL, nextState);
    this.#session.pushState(nextURL, nextState);
    this.#activeState = this.#cloneState(nextState);
    this.#commit("push", "silent");
    return true;
  }

  replaceState(state: unknown, url?: string | URL | null): boolean {
    if (this.#disposed) {
      return false;
    }

    const nextURL = resolveHistoryURL(
      url,
      this.#getBaseURL(),
      this.currentURL,
      this.#window,
    );
    const nextState = this.#cloneState(state);
    if (!this.#approve(nextURL, "replace", nextState)) {
      return false;
    }

    this.#mirrorEntry(nextURL, nextState);
    this.#session.replaceState(nextURL, nextState);
    this.#activeState = this.#cloneState(nextState);
    this.#commit("replace", "silent");
    return true;
  }

  adoptNativeNavigation(url: string, mode: DocumentHistoryMode | "reload"): void {
    if (this.#disposed || mode === "reload") {
      return;
    }

    const nextURL = resolveHistoryURL(
      url,
      this.#getBaseURL(),
      this.currentURL,
      this.#window,
    );
    if (mode === "push") {
      this.#session.pushState(nextURL, null);
    } else {
      this.#session.replaceState(nextURL, null);
    }
    this.#activeState = null;
    this.#nativeHistoryLength = this.#readNativeHistoryLength();
    this.#commit(mode, "silent");
  }

  navigateFragment(url: string, state: unknown = null): boolean {
    if (this.#disposed) {
      return false;
    }

    const nextURL = resolveHistoryURL(
      url,
      this.currentURL,
      this.currentURL,
      this.#window,
    );
    const nextState = this.#cloneState(state);
    if (!this.#approve(nextURL, "fragment", nextState)) {
      return false;
    }

    const previousURL = this.currentURL;
    this.#mirrorEntry(nextURL, nextState);
    this.#session.navigateFragment(nextURL, nextState);
    this.#activeState = this.#cloneState(nextState);
    this.#commit("fragment", "activate", previousURL);
    return true;
  }

  navigateNativeFragment(url: string): boolean {
    if (this.#disposed) {
      return false;
    }

    const nextURL = resolveHistoryURL(
      url,
      this.currentURL,
      this.currentURL,
      this.#window,
    );
    const nextState = null;
    const nativeHistoryLength = this.#readNativeHistoryLength();
    const replacesCurrentEntry = nativeHistoryLength === this.#nativeHistoryLength;
    this.#nativeHistoryLength = nativeHistoryLength;
    if (!this.#approve(nextURL, "fragment", nextState)) {
      return false;
    }

    const previousURL = this.currentURL;
    this.#mirrorEntry(nextURL, nextState);
    if (replacesCurrentEntry) {
      this.#session.replaceState(nextURL, nextState);
    } else {
      this.#session.navigateFragment(nextURL, nextState);
    }
    this.#activeState = null;
    this.#commit("fragment", "activate", previousURL);
    return true;
  }

  restoreMirroredURL(): void {
    if (!this.#disposed) {
      this.#mirrorEntry(this.currentURL, this.state);
    }
  }

  go(delta = 0): void {
    if (!Number.isFinite(delta) || Math.trunc(delta) === 0 || this.#disposed) {
      return;
    }

    const traversalDelta = Math.trunc(delta);
    this.#window.setTimeout(() => {
      if (!this.#disposed) {
        this.#traverse(traversalDelta);
      }
    }, 0);
  }

  dispose(): void {
    this.#disposed = true;
  }

  #assertReceiver(receiver: History): void {
    if (receiver !== this.#history) {
      throw new this.#window.TypeError("Illegal invocation");
    }
  }

  #assertRequiredArguments(method: string, actual: number, required: number): void {
    if (actual < required) {
      throw new this.#window.TypeError(
        `Failed to execute '${method}' on 'History': ${required} arguments required, but only ${actual} present.`,
      );
    }
  }

  #coerceDelta(value: unknown): number {
    if (typeof value === "bigint" || typeof value === "symbol") {
      throw new this.#window.TypeError(
        "History traversal delta cannot be converted to a number",
      );
    }

    let number: number;
    try {
      number = +(value as number);
    } catch (cause) {
      throw new this.#window.TypeError(
        "History traversal delta cannot be converted to a number",
        { cause },
      );
    }
    return Number.isFinite(number) ? number | 0 : 0;
  }

  #traverse(delta: number, cancelable = false): NavigationOutcome {
    const nextIndex = this.#session.currentIndex + Math.trunc(delta);
    if (
      nextIndex < 0 ||
      nextIndex >= this.#session.length ||
      nextIndex === this.#session.currentIndex
    ) {
      return "unavailable";
    }

    const nextEntry = this.#session.entryAt(nextIndex);
    if (nextEntry === undefined) {
      return "unavailable";
    }
    if (!this.#approve(nextEntry.url, "traverse", nextEntry.state, cancelable)) {
      return "canceled";
    }

    if (nextEntry.documentID !== this.#session.currentDocumentID) {
      this.#onDocumentTraversal(this.#session.forkTraversal(nextIndex));
      return "applied";
    }

    const previousURL = this.currentURL;
    this.#mirrorEntry(nextEntry.url, nextEntry.state);
    this.#session.traverse(nextIndex);
    this.#activeState = this.#cloneState(nextEntry.state);
    this.#commit("traverse", "activate", previousURL);
    return "applied";
  }

  #approve(
    to: string,
    kind: VFrameNavigationKind,
    state: unknown,
    cancelable = false,
  ): boolean {
    if (this.#disposed) {
      return false;
    }

    const approved = this.#onNavigate(
      {
        from: this.currentURL,
        to,
        kind,
        state,
      },
      { cancelable },
    );
    return approved && !this.#disposed;
  }

  #cloneState(state: unknown): unknown {
    return this.#window.structuredClone(state);
  }

  #commit(
    kind: VFrameNavigationKind,
    activation: "silent" | "activate",
    previousURL = this.currentURL,
  ): void {
    this.#onURLChange(this.currentURL, kind);

    if (activation === "silent") {
      return;
    }

    // Same-document navigations fire popstate before hashchange, per the HTML
    // spec's "update document for history step application".
    this.#window.dispatchEvent(
      new this.#window.PopStateEvent("popstate", { state: this.state }),
    );

    const previousFragmentStart = previousURL.indexOf("#");
    const currentFragmentStart = this.currentURL.indexOf("#");
    const previousFragment =
      previousFragmentStart === -1 ? null : previousURL.slice(previousFragmentStart + 1);
    const currentFragment =
      currentFragmentStart === -1
        ? null
        : this.currentURL.slice(currentFragmentStart + 1);
    if (previousFragment !== currentFragment) {
      this.#window.dispatchEvent(
        new this.#window.HashChangeEvent("hashchange", {
          oldURL: previousURL,
          newURL: this.currentURL,
        }),
      );
    }
  }

  #mirrorEntry(url: string, state: unknown): void {
    this.#nativeReplaceState(state, "", url);
  }

  #readNativeHistoryLength(): number {
    return this.#nativeLengthGetter?.() ?? this.#nativeHistoryLength;
  }
}
