import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ListenerRegistry,
  captureAbortSignalMethods,
} from "../../src/listener-registry.js";

test("rolls back partial mirrored registration and permits a clean retry", () => {
  const first = new EventTarget();
  const second = new EventTarget();
  const controller = new AbortController();
  const registrationError = new Error("second target rejected registration");
  let failing = true;
  const registry = new ListenerRegistry({
    abortSignal: captureAbortSignalMethods(globalThis),
    createWrapper: (listener) => listener as EventListener,
    addToTargets(type, wrapper) {
      first.addEventListener(type, wrapper);
      if (failing) throw registrationError;
      second.addEventListener(type, wrapper);
    },
    removeFromTargets(type, wrapper, capture) {
      first.removeEventListener(type, wrapper, capture);
      second.removeEventListener(type, wrapper, capture);
    },
  });
  let calls = 0;
  const listener = () => calls++;
  assert.throws(
    () => registry.add("test", listener, { signal: controller.signal }),
    (error) => error === registrationError,
  );
  first.dispatchEvent(new Event("test"));
  second.dispatchEvent(new Event("test"));
  assert.equal(calls, 0);
  failing = false;
  registry.add("test", listener, { signal: controller.signal, once: true });
  second.dispatchEvent(new Event("test"));
  first.dispatchEvent(new Event("test"));
  assert.equal(calls, 1);
  registry.add("test", listener, { signal: controller.signal });
  controller.abort();
  first.dispatchEvent(new Event("test"));
  second.dispatchEvent(new Event("test"));
  assert.equal(calls, 1);
  registry.dispose();
});

test("rolls back targets and the abort callback when signal hookup fails", () => {
  const target = new EventTarget();
  const controller = new AbortController();
  const methods = captureAbortSignalMethods(globalThis);
  const registrationError = new Error("abort registration failed");
  let failing = true;
  let removals = 0;
  const registry = new ListenerRegistry({
    abortSignal: {
      ...methods,
      addEventListener(
        this: AbortSignal,
        ...args: Parameters<typeof methods.addEventListener>
      ) {
        methods.addEventListener.apply(this, args);
        if (failing) throw registrationError;
      },
    },
    createWrapper: (listener) => listener as EventListener,
    addToTargets(type, wrapper) {
      target.addEventListener(type, wrapper);
    },
    removeFromTargets(type, wrapper, capture) {
      removals++;
      target.removeEventListener(type, wrapper, capture);
    },
  });
  let calls = 0;
  const listener = () => calls++;
  assert.throws(
    () => registry.add("test", listener, { signal: controller.signal }),
    (error) => error === registrationError,
  );
  target.dispatchEvent(new Event("test"));
  assert.equal(calls, 0);
  assert.equal(removals, 1);
  failing = false;
  registry.add("test", listener, { signal: controller.signal });
  target.dispatchEvent(new Event("test"));
  assert.equal(calls, 1);
  registry.dispose();
  controller.abort();
  target.dispatchEvent(new Event("test"));
  assert.equal(calls, 1);
  assert.equal(removals, 2);
});
