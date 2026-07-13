import { mirrorURLToHostOrigin, resolveHistoryURL } from "./url.js";
import type {
  VFrameNavigateEventDetail,
  VFrameNavigationKind,
  VFrameWindow,
} from "./types.js";

interface HistoryEntry {
  url: string;
  state: unknown;
}

export interface VirtualHistoryOptions {
  window: VFrameWindow;
  initialURL: string;
  hostOrigin: string;
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
  readonly #hostOrigin: string;
  readonly #entries: HistoryEntry[];
  #index = 0;
  #scrollRestoration: ScrollRestoration = "auto";
  #disposed = false;

  constructor(options: VirtualHistoryOptions) {
    this.#window = options.window;
    this.#history = options.window.history;
    this.#nativeReplaceState = options.window.history.replaceState.bind(options.window.history);
    this.#onNavigate = options.onNavigate;
    this.#onURLChange = options.onURLChange;
    this.#getBaseURL = options.getBaseURL;
    this.#hostOrigin = options.hostOrigin;
    this.#entries = [{ url: options.initialURL, state: null }];
  }

  get currentURL(): string {
    return this.#entries[this.#index]?.url ?? "";
  }

  get state(): unknown {
    return this.#entries[this.#index]?.state ?? null;
  }

  install(): void {
    const controller = this;

    Object.defineProperties(this.#window.History.prototype, {
      length: {
        configurable: true,
        get(this: History) {
          controller.#assertReceiver(this);
          return controller.#entries.length;
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
          return controller.#scrollRestoration;
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
            controller.#scrollRestoration = serializedValue;
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
    this.#entries.splice(this.#index + 1);
    this.#entries.push({ url: nextURL, state: nextState });
    this.#index = this.#entries.length - 1;
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
    this.#entries[this.#index] = { url: nextURL, state: nextState };
    this.#commit("none");
    return true;
  }

  navigate(url: string, kind: VFrameNavigationKind, state: unknown = null): boolean {
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
    if (!this.#approve(nextURL, kind, nextState)) {
      return false;
    }

    const previousURL = this.currentURL;
    this.#mirrorEntry(nextURL, nextState);
    this.#entries.splice(this.#index + 1);
    this.#entries.push({ url: nextURL, state: nextState });
    this.#index = this.#entries.length - 1;
    this.#commit(kind === "fragment" ? "fragment" : "none", previousURL);
    return true;
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
    const nextIndex = this.#index + Math.trunc(delta);
    if (nextIndex < 0 || nextIndex >= this.#entries.length || nextIndex === this.#index) {
      return;
    }

    const nextEntry = this.#entries[nextIndex];
    if (nextEntry === undefined || !this.#approve(nextEntry.url, "traverse", nextEntry.state)) {
      return;
    }

    const previousURL = this.currentURL;
    this.#mirrorEntry(nextEntry.url, nextEntry.state);
    this.#index = nextIndex;
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

    if (eventType === "traverse") {
      this.#window.dispatchEvent(
        new this.#window.PopStateEvent("popstate", { state: this.state }),
      );
    }

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
    const mirrorURL = mirrorURLToHostOrigin(
      url,
      this.#hostOrigin,
    );
    this.#nativeReplaceState(state, "", mirrorURL);
  }
}
