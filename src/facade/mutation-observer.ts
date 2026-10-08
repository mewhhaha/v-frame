// The realm's MutationObserver, with two differences from the native one. The
// facade's own temporary writes (native-activation guards) must not look like
// guest mutations, and an observer on the guest's document has to watch the
// shell instead, since the document itself is not in the tree.

import { EnumerableWeakSet } from "../enumerable-weak.js";
import type { FacadeContext } from "./context.js";

export interface MutationObserverFacade {
  mutateInternally(mutation: () => void): void;
  installPatches(): void;
}

export function createMutationObserverFacade(
  context: FacadeContext,
): MutationObserverFacade {
  const options = context.options;
  const { window, document, NativeMutationObserver, patch } = context;

  const observers = new EnumerableWeakSet<VFrameMutationObserver>();
  const queueMicrotask = window.queueMicrotask.bind(window);
  let mutateInternally!: (mutation: () => void) => void;
  class VFrameMutationObserver extends NativeMutationObserver {
    readonly #callback: MutationCallback;
    #pending: MutationRecord[] = [];
    #queued = false;

    constructor(callback: MutationCallback) {
      super(
        typeof callback === "function" ? (records) => this.#deliver(records) : callback,
      );
      this.#callback = callback;
      observers.add(this);
    }

    #deliver(records: MutationRecord[]): void {
      const delivered = [...this.#pending, ...records];
      this.#pending = [];
      this.#queued = false;
      if (delivered.length !== 0) this.#callback.call(this, delivered, this);
    }

    // Temporary native-activation guards must not look like guest mutations.
    // Retain earlier records, discard only the synchronous internal writes,
    // and deliver preserved records at the original microtask boundary. A
    // static block rather than a static method: the guest can reach every
    // static of the class it is handed, and this one hides writes from observers.
    static {
      mutateInternally = (mutation) => {
        const nativeTakeRecords = NativeMutationObserver.prototype.takeRecords;
        for (const observer of observers) {
          observer.#pending.push(...nativeTakeRecords.call(observer));
        }
        try {
          mutation();
        } finally {
          for (const observer of observers) {
            nativeTakeRecords.call(observer);
            if (observer.#pending.length !== 0 && !observer.#queued) {
              observer.#queued = true;
              queueMicrotask(() => observer.#deliver(nativeTakeRecords.call(observer)));
            }
          }
        }
      };
    }

    takeRecords(): MutationRecord[] {
      const records = [...this.#pending, ...super.takeRecords()];
      this.#pending = [];
      return records;
    }

    disconnect(): void {
      this.#pending = [];
      super.disconnect();
    }

    observe(target: Node, observerOptions?: MutationObserverInit): void {
      const observedTarget =
        target === document && observerOptions?.subtree === true ? options.html : target;
      super.observe(observedTarget, observerOptions);
    }
  }

  // The class name is an implementation detail the guest could read.
  Object.defineProperty(VFrameMutationObserver, "name", { value: "MutationObserver" });

  const installPatches = (): void => {
    patch(window, "MutationObserver", {
      writable: true,
      value: VFrameMutationObserver,
    });
  };

  return { mutateInternally, installPatches };
}
