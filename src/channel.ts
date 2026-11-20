import { channelContext, type ChannelWindow } from "./channel-context.js";

/** A named topic shared by the host and fragments on one page. */
export interface FragmentChannel<T> {
  /** Deliver a structured-cloneable value. Retain the latest selection for late subscribers when requested. */
  publish(value: T, options?: { retain?: boolean }): void;
  /** Receive a separate copy of each value. Call the returned function to unsubscribe. */
  subscribe(listener: (value: T) => void): () => void;
}

const hubKey = Symbol.for("@mewhhaha/v-frame/channel-hub/1");
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
        active.push(message);
        return;
      }
      const queue = [message];
      pending.set(name, queue);
      try {
        for (const { value, retain } of queue) {
          if (retain) hub.retained.set(name, value);
          else hub.retained.delete(name);
          hub.dispatchEvent(new page.CustomEvent(name, { detail: { value } }));
        }
      } finally {
        pending.delete(name);
      }
    },
    subscribe(listener) {
      const connection = pageChannel();
      if (!connection) return () => {};
      const { hub, context } = connection;
      const receive = (event: Event) =>
        listener(structuredClone((event as CustomEvent<{ value: T }>).detail.value));
      const unsubscribe = () => hub.removeEventListener(name, receive);
      hub.addEventListener(name, receive, context);
      if (hub.retained.has(name)) {
        try {
          listener(structuredClone(hub.retained.get(name)) as T);
        } catch (error) {
          unsubscribe();
          throw error;
        }
      }
      return unsubscribe;
    },
  };
}
