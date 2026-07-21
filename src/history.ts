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
