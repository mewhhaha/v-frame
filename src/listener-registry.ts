// v-frame installs several registries in front of a native addEventListener:
// the document facade, the window bridge and the native XHR patches. They all
// need the same bookkeeping — a record store keyed by (type, listener,
// capture), `once` removal before invocation, `signal` unwinding and bulk
// disposal — but they disagree on what a wrapper does and on how many targets
// a record is mirrored onto. The bookkeeping lives here; the disagreements stay
// at the call site as ListenerRegistryOptions.

export function captureAbortSignalMethods(
  window: Pick<typeof globalThis, "AbortSignal">,
) {
  const prototype = window.AbortSignal.prototype;
  return {
    aborted: Object.getOwnPropertyDescriptor(prototype, "aborted")!.get! as (
      this: AbortSignal,
    ) => boolean,
    addEventListener: prototype.addEventListener,
    removeEventListener: prototype.removeEventListener,
    any: window.AbortSignal.any.bind(window.AbortSignal),
  };
}

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
  return Boolean(isListenerDictionary(options) ? options.capture : options);
}

function isListenerDictionary(
  options: boolean | EventListenerOptions | undefined,
): options is AddEventListenerOptions {
  return (
    options !== null && (typeof options === "object" || typeof options === "function")
  );
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

function normalizeListenerOptions(
  options: boolean | AddEventListenerOptions | undefined,
): AddEventListenerOptions & { capture: boolean } {
  const normalized: AddEventListenerOptions & { capture: boolean } = {
    capture: listenerCapture(options),
  };
  if (isListenerDictionary(options)) {
    normalized.once = Boolean(options.once);
    const passive = options.passive;
    if (passive !== undefined) normalized.passive = Boolean(passive);
    const signal = options.signal;
    if (signal !== undefined) normalized.signal = signal;
  }
  return normalized;
}

export interface ListenerRegistryOptions {
  abortSignal: ReturnType<typeof captureAbortSignalMethods>;
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
  /** The realm whose TypeError a rejected listener argument should throw. */
  TypeError?: new (message?: string) => Error;
}

export class ListenerRegistry {
  readonly #options: ListenerRegistryOptions;
  // Indexed by type: dispatch and lookup only ever concern one type, and a
  // registry with many types should not scan the others. Each set keeps
  // registration order, which is the order listeners must run in.
  readonly #records = new Map<string, Set<ListenerRecord>>();

  constructor(options: ListenerRegistryOptions) {
    this.#options = options;
  }

  #find(
    type: string,
    listener: EventListenerOrEventListenerObject,
    capture: boolean,
  ): ListenerRecord | undefined {
    for (const record of this.#records.get(type) ?? []) {
      if (record.listener === listener && record.capture === capture) {
        if (
          record.signal !== undefined &&
          this.#options.abortSignal.aborted.call(record.signal)
        ) {
          this.#forget(record);
          continue;
        }
        return record;
      }
    }
    return undefined;
  }

  #forget(record: ListenerRecord): void {
    const sameType = this.#records.get(record.type);
    if (sameType === undefined || !sameType.delete(record)) {
      return;
    }
    if (sameType.size === 0) {
      this.#records.delete(record.type);
    }
    try {
      this.#options.removeFromTargets(record.type, record.wrapper, record.capture);
    } finally {
      if (record.signal !== undefined && record.abort !== undefined) {
        this.#options.abortSignal.removeEventListener.call(
          record.signal,
          "abort",
          record.abort,
        );
      }
    }
  }

  add(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    type = `${type}`;
    const normalized = normalizeListenerOptions(options);
    const signal = normalized.signal;
    // The intrinsic getter both brands the signal (including cross-realm
    // signals) and reads its native state. Validate even for null or duplicate
    // callbacks, without consulting guest-overridden signal properties.
    const aborted =
      signal !== undefined && this.#options.abortSignal.aborted.call(signal);
    // A nullable callback interface still rejects primitives at registration;
    // waiting until dispatch would hide the mistake from the caller.
    if (
      listener != null &&
      typeof listener !== "object" &&
      typeof listener !== "function"
    ) {
      throw new (this.#options.TypeError ?? TypeError)(
        "Failed to execute 'addEventListener': parameter 2 is not of type 'Object'.",
      );
    }
    if (listener == null || aborted) {
      return;
    }

    const capture = normalized.capture;
    if (this.#find(type, listener, capture) !== undefined) {
      return;
    }

    const record: ListenerRecord = {
      type,
      listener,
      capture,
      wrapper: () => undefined,
    };
    const invokeListener = this.#options.createWrapper(
      listener,
      capture,
      normalized,
      type,
    );
    const once = normalized.once;
    record.wrapper = (event) => {
      if (
        record.signal !== undefined &&
        this.#options.abortSignal.aborted.call(record.signal)
      ) {
        this.#forget(record);
        return;
      }
      if (once) {
        this.#forget(record);
      }
      invokeListener(event);
    };
    let sameType = this.#records.get(type);
    if (sameType === undefined) {
      sameType = new Set();
      this.#records.set(type, sameType);
    }
    sameType.add(record);
    try {
      this.#options.addToTargets(type, record.wrapper, normalized);
      if (signal !== undefined) {
        // Observe native cancellation on a private dependent signal, not the
        // authored signal's dispatchable, stoppable public abort event.
        record.signal = this.#options.abortSignal.any([signal]);
        record.abort = () => this.#forget(record);
        this.#options.abortSignal.addEventListener.call(
          record.signal,
          "abort",
          record.abort,
          {
            once: true,
          },
        );
        if (this.#options.abortSignal.aborted.call(record.signal)) {
          this.#forget(record);
        }
      }
    } catch (error) {
      this.#forget(record);
      throw error;
    }
  }

  // Reports whether a record was found, so a call site that shares its target
  // with the native implementation can fall back to it.
  remove(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ): boolean {
    type = `${type}`;
    const capture = listenerCapture(options);
    if (listener == null) {
      return false;
    }

    const record = this.#find(type, listener, capture);
    if (record === undefined) {
      return false;
    }

    this.#forget(record);
    return true;
  }

  invoke(event: Event, capture: boolean, shouldContinue: () => boolean): void {
    const sameType = this.#records.get(event.type);
    if (sameType === undefined) {
      return;
    }
    for (const record of [...sameType]) {
      // A listener removed by an earlier listener in this dispatch is skipped,
      // matching the DOM inner-invoke algorithm.
      if (!sameType.has(record)) {
        continue;
      }
      if (record.capture === capture) {
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
    for (const sameType of [...this.#records.values()]) {
      for (const record of [...sameType]) {
        this.#forget(record);
      }
    }
  }
}
