import { resolveHistoryURL } from "./url.js";
import type {
  VFrameNavigateEventDetail,
  VFrameNavigationKind,
  VFrameWindow,
} from "./types.js";

interface HistoryEntry {
  url: string;
  state: unknown;
}

type HostHistoryChange = "push" | "replace";

interface HostHistoryObserver {
  callbacks: Set<(change: HostHistoryChange) => void>;
  pushStateDescriptor: PropertyDescriptor | undefined;
  replaceStateDescriptor: PropertyDescriptor | undefined;
}

const hostHistoryObservers = new WeakMap<Window, HostHistoryObserver>();

function observeHostHistory(
  hostWindow: Window,
  callback: (change: HostHistoryChange) => void,
): () => void {
  let observer = hostHistoryObservers.get(hostWindow);
  if (observer === undefined) {
    const history = hostWindow.history;
    const nativePushState = history.pushState;
    const nativeReplaceState = history.replaceState;
    observer = {
      callbacks: new Set(),
      pushStateDescriptor: Object.getOwnPropertyDescriptor(history, "pushState"),
      replaceStateDescriptor: Object.getOwnPropertyDescriptor(history, "replaceState"),
    };
    hostHistoryObservers.set(hostWindow, observer);
    const notify = (change: HostHistoryChange) => {
      for (const registeredCallback of observer?.callbacks ?? []) {
        registeredCallback(change);
      }
    };
    Object.defineProperties(history, {
      pushState: {
        configurable: true,
        writable: true,
        value: function pushState(this: History, _state: unknown, _unused: string) {
          Reflect.apply(nativePushState, this, arguments);
          if (this === history) {
            notify("push");
          }
        },
      },
      replaceState: {
        configurable: true,
        writable: true,
        value: function replaceState(this: History, _state: unknown, _unused: string) {
          Reflect.apply(nativeReplaceState, this, arguments);
          if (this === history) {
            notify("replace");
          }
        },
      },
    });
  }

  observer.callbacks.add(callback);
  return () => {
    observer?.callbacks.delete(callback);
    if (observer === undefined || observer.callbacks.size !== 0) {
      return;
    }
    const history = hostWindow.history;
    if (observer.pushStateDescriptor === undefined) {
      delete (history as unknown as Record<string, unknown>).pushState;
    } else {
      Object.defineProperty(history, "pushState", observer.pushStateDescriptor);
    }
    if (observer.replaceStateDescriptor === undefined) {
      delete (history as unknown as Record<string, unknown>).replaceState;
    } else {
      Object.defineProperty(history, "replaceState", observer.replaceStateDescriptor);
    }
    hostHistoryObservers.delete(hostWindow);
  };
}

export class VirtualHistorySession {
  readonly #entries: HistoryEntry[];
  #index: number;
  scrollRestoration: ScrollRestoration;

  constructor(
    initialURL: string,
    entries?: HistoryEntry[],
    index?: number,
    scrollRestoration?: ScrollRestoration,
  ) {
    this.#entries = entries ?? [{ url: initialURL, state: null }];
    this.#index = index ?? 0;
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
      this.scrollRestoration,
    );
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
    });
    this.#index = this.#entries.length - 1;
  }

  replaceState(url: string, state: unknown): void {
    this.#entries[this.#index] = {
      url,
      state,
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
  onNavigate(detail: VFrameNavigateEventDetail): boolean;
  onURLChange(url: string): void;
}

export interface BoundHistoryOptions {
  window: VFrameWindow;
  hostWindow: Window;
  onNavigate(detail: VFrameNavigateEventDetail): boolean;
  onURLChange(url: string): void;
}

export class BoundHistory {
  readonly #window: VFrameWindow;
  readonly #childHistory: History;
  readonly #hostWindow: Window;
  readonly #nativeChildReplaceState: History["replaceState"];
  readonly #onNavigate: BoundHistoryOptions["onNavigate"];
  readonly #onURLChange: BoundHistoryOptions["onURLChange"];
  readonly #listenerLifetime = new AbortController();
  #currentURL: string;
  #originatingHostChange = false;
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

    const stopObserving = observeHostHistory(this.#hostWindow, () => {
      this.#synchronizeFromHost(!this.#originatingHostChange);
    });
    this.#listenerLifetime.signal.addEventListener("abort", stopObserving, {
      once: true,
    });
    this.#hostWindow.addEventListener("popstate", () => {
      if (this.#disposed) {
        return;
      }
      const from = this.#currentURL;
      const to = this.#hostWindow.location.href;
      this.#onNavigate({
        from,
        to,
        kind: "traverse",
        state: this.#hostWindow.history.state,
      });
      this.#synchronizeFromHost(true);
    }, { signal: this.#listenerLifetime.signal });
    this.#synchronizeFromHost(false);
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
    this.#originatingHostChange = true;
    try {
      this.#hostWindow.history.pushState(state, "", to);
    } finally {
      this.#originatingHostChange = false;
    }
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
    change: HostHistoryChange,
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
    this.#originatingHostChange = true;
    try {
      this.#hostWindow.history[change === "push" ? "pushState" : "replaceState"](
        nextState,
        unused,
        url,
      );
    } finally {
      this.#originatingHostChange = false;
    }
  }

  #synchronizeFromHost(dispatchEvents: boolean): void {
    if (this.#disposed) {
      return;
    }
    const previousURL = this.#currentURL;
    this.#currentURL = this.#hostWindow.location.href;
    this.#mirrorHostEntry();
    this.#onURLChange(this.#currentURL);
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
    this.#window.dispatchEvent(new this.#window.PopStateEvent("popstate", {
      state: this.#hostWindow.history.state,
    }));
    const previousHash = new this.#window.URL(previousURL).hash;
    const currentHash = new this.#window.URL(this.#currentURL).hash;
    if (previousHash !== currentHash) {
      this.#window.dispatchEvent(new this.#window.HashChangeEvent("hashchange", {
        oldURL: previousURL,
        newURL: this.#currentURL,
      }));
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

export class VirtualHistory {
  readonly #window: VFrameWindow;
  readonly #history: History;
  readonly #nativeReplaceState: History["replaceState"];
  readonly #onNavigate: VirtualHistoryOptions["onNavigate"];
  readonly #onURLChange: VirtualHistoryOptions["onURLChange"];
  readonly #getBaseURL: VirtualHistoryOptions["getBaseURL"];
  readonly #session: VirtualHistorySession;
  // Stored entry state stays pristine; each activation exposes its own clone,
  // so mutations of history.state do not survive back/forward traversal.
  #activeState: unknown = null;
  #disposed = false;

  constructor(options: VirtualHistoryOptions) {
    this.#window = options.window;
    this.#history = options.window.history;
    this.#nativeReplaceState = options.window.history.replaceState.bind(options.window.history);
    this.#onNavigate = options.onNavigate;
    this.#onURLChange = options.onURLChange;
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
    this.#commit("none");
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
    this.#commit("none");
    return true;
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
    this.#commit("fragment", previousURL);
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
      throw new this.#window.TypeError("History traversal delta cannot be converted to a number");
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

  #traverse(delta: number): void {
    const nextIndex = this.#session.currentIndex + Math.trunc(delta);
    if (
      nextIndex < 0 ||
      nextIndex >= this.#session.length ||
      nextIndex === this.#session.currentIndex
    ) {
      return;
    }

    const nextEntry = this.#session.entryAt(nextIndex);
    if (nextEntry === undefined || !this.#approve(nextEntry.url, "traverse", nextEntry.state)) {
      return;
    }

    const previousURL = this.currentURL;
    this.#mirrorEntry(nextEntry.url, nextEntry.state);
    this.#session.traverse(nextIndex);
    this.#activeState = this.#cloneState(nextEntry.state);
    this.#commit("traverse", previousURL);
  }

  #approve(to: string, kind: VFrameNavigationKind, state: unknown): boolean {
    if (this.#disposed) {
      return false;
    }

    const approved = this.#onNavigate({
      from: this.currentURL,
      to,
      kind,
      state,
    });
    return approved && !this.#disposed;
  }

  #cloneState(state: unknown): unknown {
    return this.#window.structuredClone(state);
  }

  #commit(eventType: "none" | "fragment" | "traverse", previousURL = this.currentURL): void {
    this.#onURLChange(this.currentURL);

    if (eventType === "none") {
      return;
    }

    // Same-document navigations fire popstate before hashchange, per the HTML
    // spec's "update document for history step application".
    this.#window.dispatchEvent(
      new this.#window.PopStateEvent("popstate", { state: this.state }),
    );

    const previousFragmentStart = previousURL.indexOf("#");
    const currentFragmentStart = this.currentURL.indexOf("#");
    const previousFragment = previousFragmentStart === -1
      ? null
      : previousURL.slice(previousFragmentStart + 1);
    const currentFragment = currentFragmentStart === -1
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
}
