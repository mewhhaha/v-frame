// v-frame installs several registries in front of a native addEventListener:
// the document facade, the window bridge and the native XHR patches. They all
// need the same bookkeeping — a record store keyed by (type, listener,
// capture), `once` removal before invocation, `signal` unwinding and bulk
// disposal — but they disagree on what a wrapper does and on how many targets
// a record is mirrored onto. The bookkeeping lives here; the disagreements stay
// at the call site as ListenerRegistryOptions.

export interface ListenerRecord {
  type: string;
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
  signal?: AbortSignal;
  abort?: () => void;
  wrapper: EventListener;
}

export function listenerCapture(
  options: boolean | EventListenerOptions | undefined,
): boolean {
  return typeof options === "boolean" ? options : (options?.capture ?? false);
}

export function listenerPassive(
  options: boolean | AddEventListenerOptions | undefined,
  type: string,
  defaultPassive = false,
): boolean {
  return (
    (typeof options === "boolean" ? undefined : options?.passive) ??
    (defaultPassive && ["touchstart", "touchmove", "wheel", "mousewheel"].includes(type))
  );
}

function listenerIsOnce(options: boolean | AddEventListenerOptions | undefined): boolean {
  return typeof options !== "boolean" && options?.once === true;
}

function listenerSignal(
  options: boolean | AddEventListenerOptions | undefined,
): AbortSignal | undefined {
  return typeof options === "boolean" ? undefined : options?.signal;
}

export interface ListenerRegistryOptions {
  // Builds the callback the underlying target actually receives. This is where
  // each call site's own behaviour lives: the facade's synthetic eventPhase,
  // the window bridge's realm-bound listener event, the XHR patches' teardown
  // silencing.
  createWrapper(
    listener: EventListenerOrEventListenerObject,
    capture: boolean,
    options: boolean | AddEventListenerOptions | undefined,
    type: string,
  ): EventListener;
  // Registers a wrapper on every target a record is mirrored onto, and decides
  // which of the authored options reach the native implementation.
  addToTargets(
    type: string,
    wrapper: EventListener,
    options: boolean | AddEventListenerOptions | undefined,
  ): void;
  removeFromTargets(type: string, wrapper: EventListener, capture: boolean): void;
  /** Reports errors from manually relayed dispatches; native dispatch reports its own. */
  onError?(error: unknown): void;
}

export class ListenerRegistry {
  readonly #options: ListenerRegistryOptions;
  readonly #records = new Set<ListenerRecord>();

  constructor(options: ListenerRegistryOptions) {
    this.#options = options;
  }

  #find(
    type: string,
    listener: EventListenerOrEventListenerObject,
    capture: boolean,
  ): ListenerRecord | undefined {
    for (const record of this.#records) {
      if (
        record.type === type &&
        record.listener === listener &&
        record.capture === capture
      ) {
        return record;
      }
    }
    return undefined;
  }

  #forget(record: ListenerRecord): void {
    if (!this.#records.delete(record)) {
      return;
    }
    this.#options.removeFromTargets(record.type, record.wrapper, record.capture);
    if (record.signal !== undefined && record.abort !== undefined) {
      record.signal.removeEventListener("abort", record.abort);
    }
  }

  add(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    if (listener === null) {
      return;
    }
    const signal = listenerSignal(options);
    if (signal?.aborted === true) {
      return;
    }

    const capture = listenerCapture(options);
    if (this.#find(type, listener, capture) !== undefined) {
      return;
    }

    const record: ListenerRecord = {
      type,
      listener,
      capture,
      wrapper: () => undefined,
    };
    const invokeListener = this.#options.createWrapper(listener, capture, options, type);
    const once = listenerIsOnce(options);
    record.wrapper = (event) => {
      if (once) {
        this.#forget(record);
      }
      invokeListener(event);
    };
    this.#records.add(record);
    try {
      this.#options.addToTargets(type, record.wrapper, options);
    } catch (error) {
      this.#forget(record);
      throw error;
    }
    if (signal !== undefined) {
      record.signal = signal;
      record.abort = () => this.#forget(record);
      signal.addEventListener("abort", record.abort, { once: true });
    }
  }

  // Reports whether a record was found, so a call site that shares its target
  // with the native implementation can fall back to it.
  remove(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): boolean {
    if (listener === null) {
      return false;
    }

    const record = this.#find(type, listener, listenerCapture(options));
    if (record === undefined) {
      return false;
    }

    this.#forget(record);
    return true;
  }

  invoke(event: Event, capture: boolean, shouldContinue: () => boolean): void {
    for (const record of [...this.#records]) {
      // A listener removed by an earlier listener in this dispatch is skipped,
      // matching the DOM inner-invoke algorithm.
      if (!this.#records.has(record)) {
        continue;
      }
      if (record.type === event.type && record.capture === capture) {
        try {
          record.wrapper(event);
        } catch (error) {
          if (this.#options.onError === undefined) {
            throw error;
          }
          this.#options.onError(error);
        }
        if (!shouldContinue()) {
          return;
        }
      }
    }
  }

  dispose(): void {
    for (const record of [...this.#records]) {
      this.#forget(record);
    }
  }
}
