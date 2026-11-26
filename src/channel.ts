import { channelContext, type ChannelWindow } from "./channel-context.js";

/** A named topic shared by the host and fragments on one page. */
export interface FragmentChannel<T> {
  /** Deliver a structured-cloneable value. Retain the latest selection for late subscribers when requested. */
  publish(value: T, options?: { retain?: boolean }): void;
  /** Read a copy of the currently retained value, or `undefined` when none is retained. */
  get(): T | undefined;
  /** Clear any retained value for this topic without notifying subscribers. */
  clear(): void;
  /** Receive a separate copy of each value. Call the returned function to unsubscribe. */
  subscribe(listener: (value: T) => void, options?: { signal?: AbortSignal }): () => void;
}

const hubKey = Symbol.for("@mewhhaha/v-frame/channel-hub/1");
const MAX_PENDING_PUBLICATIONS = 1000;
type Publication = { value: unknown; retain: boolean };
type Hub = EventTarget & {
  retained: Map<string, unknown>;
  pending?: Map<string, Publication[]>;
};

function pageChannel() {
  const context = (window as ChannelWindow)[channelContext];
  if (context === null || context?.signal.aborted) return;
  const page = context?.page ?? window;
  const doc = page.document as Document & { [hubKey]?: Hub };
  // Allocate the long-lived objects in the host, even when a guest connects first.
  const hub: Hub = (doc[hubKey] ??= Object.assign(new page.EventTarget(), {
    retained: new page.Map<string, unknown>(),
  }));
  return { page, hub, context };
}

/** Declare a topic in a shared contract or independently in each participating application. */
export function channel<T = unknown>(name: string): FragmentChannel<T> {
  // Resolve the page at use time so contracts can also be imported during SSR.
  return {
    publish(value, options) {
      const connection = pageChannel();
      if (!connection) return;
      const { page, hub, context } = connection;
      const data = page.structuredClone(value);
      const message = { value: data, retain: Boolean(options?.retain) };
      if (context?.signal.aborted) return;
      // Independently bundled publishers must agree which update is delivered next.
      const pending = (hub.pending ??= new page.Map<string, Publication[]>());
      const active = pending.get(name);
      if (active) {
        if (active.length >= MAX_PENDING_PUBLICATIONS) {
          throw new RangeError(
            `v-frame channel ${JSON.stringify(name)} exceeded maximum queued publications (${MAX_PENDING_PUBLICATIONS})`,
          );
        }
        active.push(message);
        return;
      }
      const queue = [message];
      pending.set(name, queue);
      try {
        for (let index = 0; index < queue.length; index += 1) {
          const { value: entryValue, retain } = queue[index]!;
          if (retain) hub.retained.set(name, entryValue);
          else hub.retained.delete(name);
          hub.dispatchEvent(
            new page.CustomEvent(name, { detail: { value: entryValue } }),
          );
        }
      } finally {
        pending.delete(name);
      }
    },
    get() {
      const connection = pageChannel();
      if (!connection || !connection.hub.retained.has(name)) return undefined;
      return structuredClone(connection.hub.retained.get(name)) as T;
    },
    clear() {
      const connection = pageChannel();
      if (!connection) return;
      connection.hub.retained.delete(name);
    },
    subscribe(listener, options) {
      const connection = pageChannel();
      if (!connection || options?.signal?.aborted) return () => {};
      const { hub, context } = connection;
      const signal =
        context?.signal && options?.signal
          ? AbortSignal.any([context.signal, options.signal])
          : (options?.signal ?? context?.signal);
      if (hub.retained.has(name)) {
        // Deliver any retained snapshot before attaching so a synchronous
        // publish inside initial replay does not re-enter this listener.
        listener(structuredClone(hub.retained.get(name)) as T);
        if (signal?.aborted) return () => {};
      }
      const receive = (event: Event) => {
        const value = structuredClone((event as CustomEvent<{ value: T }>).detail.value);
        if (!context) {
          listener(value);
          return;
        }
        try {
          listener(value);
        } catch (error) {
          if (typeof window.reportError === "function") {
            window.reportError(error);
          } else {
            window.setTimeout(() => {
              throw error;
            });
          }
        }
      };
      const unsubscribe = () => hub.removeEventListener(name, receive);
      hub.addEventListener(name, receive, signal ? { signal } : undefined);
      return unsubscribe;
    },
  };
}
