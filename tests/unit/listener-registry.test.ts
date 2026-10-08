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

function indexedRegistry() {
  const target = new EventTarget();
  return new ListenerRegistry({
    abortSignal: captureAbortSignalMethods(globalThis),
    createWrapper: (listener) => listener as EventListener,
    addToTargets: (type, wrapper) => target.addEventListener(type, wrapper),
    removeFromTargets: (type, wrapper) => target.removeEventListener(type, wrapper),
  });
}

test("invokes only the dispatched type, in registration order, skipping removals", () => {
  const calls: string[] = [];
  const registry = indexedRegistry();
  const second = () => calls.push("second");
  registry.add("a", () => {
    calls.push("first");
    registry.remove("a", second);
    registry.add("a", () => calls.push("late"));
  });
  registry.add("b", () => calls.push("other-type"));
  registry.add("a", second);
  registry.add("a", () => calls.push("third"));
  registry.invoke(new Event("a"), false, () => true);
  assert.deepEqual(calls, ["first", "third"]);
  registry.dispose();
  registry.invoke(new Event("a"), false, () => true);
  assert.deepEqual(calls, ["first", "third"]);
});

test("deduplicates per type and capture and rejects non-object callbacks", () => {
  const registry = indexedRegistry();
  const listener = () => undefined;
  registry.add("a", listener);
  registry.add("a", listener);
  registry.add("a", listener, true);
  assert.equal(registry.remove("a", listener), true);
  assert.equal(registry.remove("a", listener), false);
  assert.equal(registry.remove("a", listener, { capture: true }), true);
  assert.equal(registry.remove("b", listener), false);
  for (const bad of ["notAFunction", 1, true]) {
    assert.throws(
      () => registry.add("a", bad as never),
      (error) => error instanceof TypeError,
    );
  }
  registry.add("a", null);
  registry.add("a", undefined as never);
  registry.add("a", { handleEvent() {} });
  registry.dispose();
});
