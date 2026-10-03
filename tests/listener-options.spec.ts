import { expect, test } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import {
  startContractFixtureServers,
  type ContractFixtureServers,
} from "./support/fixture-server";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: ContractFixtureServers;

test.beforeAll(async () => {
  fixture = await startContractFixtureServers();
});

test.afterAll(async () => {
  await fixture.close();
});

test("matches native option coercion, listener deduplication, removal and rearming", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/documents/dom.html", id: "frame" });
  const result = await page.evaluate(() => {
    const child = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    function exercise(view: Window & typeof globalThis) {
      const element = view.document.createElement("button");
      view.document.body.append(element);
      const xhr = new view.XMLHttpRequest();
      const results = [];
      for (const [scope, target] of Object.entries({
        window: view,
        document: view.document,
        html: view.document.documentElement,
        element,
        xhr,
      })) {
        const source = scope === "xhr" ? xhr : element;
        const dispatch = (type: string) =>
          source.dispatchEvent(new view.Event(type, { bubbles: true, cancelable: true }));
        let onceCount = 0;
        const once = () => onceCount++;
        const onceType = "once-" + scope;
        target.addEventListener(onceType, once, {
          once: 1,
        } as unknown as AddEventListenerOptions);
        dispatch(onceType);
        dispatch(onceType);
        const firstOnceCount = onceCount;
        target.addEventListener(onceType, once, {
          once: "false",
        } as unknown as AddEventListenerOptions);
        dispatch(onceType);
        dispatch(onceType);
        target.removeEventListener(onceType, once);

        let captured = 0;
        const capture = () => captured++;
        const captureType = "capture-" + scope;
        target.addEventListener(captureType, capture, {
          capture: 1,
        } as unknown as AddEventListenerOptions);
        target.addEventListener(captureType, capture, true);
        dispatch(captureType);
        const firstCaptured = captured;
        target.removeEventListener(captureType, capture, true);
        dispatch(captureType);

        let primitiveCount = 0;
        const primitive = () => primitiveCount++;
        target.addEventListener("primitive-" + scope, primitive, 1 as unknown as boolean);
        target.removeEventListener("primitive-" + scope, primitive, true);
        dispatch("primitive-" + scope);

        let numericTypeCount = 0;
        const numericType = () => numericTypeCount++;
        target.addEventListener(17 as unknown as string, numericType);
        dispatch("17");
        target.removeEventListener("17", numericType);
        dispatch("17");
        results.push({
          scope,
          firstOnceCount,
          onceCount,
          firstCaptured,
          captured,
          primitiveCount,
          numericTypeCount,
        });
      }
      element.remove();
      return results;
    }
    return { native: exercise(window), virtual: exercise(child) };
  });
  expect(result.native).toEqual(
    ["window", "document", "html", "element", "xhr"].map((scope) => ({
      scope,
      firstOnceCount: 1,
      onceCount: 2,
      firstCaptured: 1,
      captured: 1,
      primitiveCount: 0,
      numericTypeCount: 1,
    })),
  );
  expect(result.virtual).toEqual(result.native);
});

test("rejects invalid signals before registration, null callbacks and deduplication", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/documents/dom.html", id: "frame" });
  const result = await page.evaluate(() => {
    const child = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    function exercise(view: Window & typeof globalThis) {
      const element = view.document.createElement("button");
      view.document.body.append(element);
      const signals: Record<string, unknown> = {
        object: {},
        null: null,
        "fake-aborted": { aborted: true },
        "fake-prototype": Object.create(view.AbortSignal.prototype),
        number: 1,
        proxy: new Proxy(new view.AbortController().signal, {}),
        "throwing-getter": {
          get aborted() {
            throw new Error("must not read an unbranded signal");
          },
        },
      };
      const results = [];
      const failure = (action: () => void) => {
        try {
          action();
          return null;
        } catch (error) {
          return {
            name: (error as Error).name,
            realmTypeError: error instanceof view.TypeError,
          };
        }
      };
      for (const [scope, target] of Object.entries({
        window: view,
        document: view.document,
        html: view.document.documentElement,
        element,
        xhr: new view.XMLHttpRequest(),
      })) {
        for (const [description, signal] of Object.entries(signals)) {
          const type = "invalid-signal-" + scope + "-" + description;
          const options = { signal } as AddEventListenerOptions;
          let calls = 0;
          const listener = () => calls++;
          const addError = failure(() =>
            target.addEventListener(type, listener, options),
          );
          target.dispatchEvent(new view.Event(type));
          const callsAfterFailure = calls;
          const nullError = failure(() =>
            Reflect.apply(target.addEventListener, target, [type, null, options]),
          );
          target.addEventListener(type, listener);
          const duplicateError = failure(() =>
            target.addEventListener(type, listener, options),
          );
          target.dispatchEvent(new view.Event(type));
          const removeError = failure(() => target.removeEventListener(type, listener));
          target.dispatchEvent(new view.Event(type));
          results.push({
            scope,
            description,
            addError,
            nullError,
            duplicateError,
            removeError,
            callsAfterFailure,
            calls,
          });
        }
      }
      element.remove();
      return results;
    }
    return { native: exercise(window), virtual: exercise(child) };
  });
  expect(result.native).toHaveLength(35);
  for (const entry of result.native) {
    expect(entry).toEqual({
      scope: entry.scope,
      description: entry.description,
      addError: { name: "TypeError", realmTypeError: true },
      nullError: { name: "TypeError", realmTypeError: true },
      duplicateError: { name: "TypeError", realmTypeError: true },
      removeError: null,
      callsAfterFailure: 0,
      calls: 1,
    });
  }
  expect(result.virtual).toEqual(result.native);
});

test("uses native abort state and methods for genuine cross-realm signals", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/documents/dom.html", id: "frame" });
  const result = await page.evaluate(() => {
    const child = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    function exercise(
      view: Window & typeof globalThis,
      foreign: Window & typeof globalThis,
    ) {
      const element = view.document.createElement("button");
      view.document.body.append(element);
      const results = [];
      for (const [scope, target] of Object.entries({
        window: view,
        document: view.document,
        html: view.document.documentElement,
        element,
        xhr: new view.XMLHttpRequest(),
      })) {
        const controller = new foreign.AbortController();
        const ignoredController = new view.AbortController();
        const publicReads: string[] = [];
        for (const name of ["aborted", "addEventListener", "removeEventListener"]) {
          Object.defineProperty(controller.signal, name, {
            get() {
              publicReads.push(name);
              throw new Error("native registration must not read " + name);
            },
          });
        }
        const type = "cross-realm-signal-" + scope;
        let calls = 0;
        const listener = () => calls++;
        target.addEventListener(type, listener, { signal: controller.signal });
        target.dispatchEvent(new view.Event(type));
        target.addEventListener(type, listener, { signal: ignoredController.signal });
        ignoredController.abort();
        target.dispatchEvent(new view.Event(type));
        controller.abort();
        target.dispatchEvent(new view.Event(type));
        target.addEventListener(type, listener, { signal: controller.signal });
        target.dispatchEvent(new view.Event(type));
        const rearmed = new view.AbortController();
        target.addEventListener(type, listener, { signal: rearmed.signal, once: true });
        target.dispatchEvent(new view.Event(type));
        target.dispatchEvent(new view.Event(type));
        target.removeEventListener(type, listener);
        rearmed.abort();
        results.push({ scope, calls, publicReads });
      }
      element.remove();
      return results;
    }
    return { native: exercise(window, child), virtual: exercise(child, window) };
  });
  expect(result.native).toEqual(
    ["window", "document", "html", "element", "xhr"].map((scope) => ({
      scope,
      calls: 3,
      publicReads: [],
    })),
  );
  expect(result.virtual).toEqual(result.native);
});

test("synthetic abort events do not cancel registrations", async ({ page }) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/documents/dom.html", id: "frame" });
  const result = await page.evaluate(() => {
    const child = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    function exercise(view: Window & typeof globalThis) {
      const element = view.document.createElement("button");
      view.document.body.append(element);
      const results = [];
      for (const [scope, target] of Object.entries({
        window: view,
        document: view.document,
        html: view.document.documentElement,
        element,
        xhr: new view.XMLHttpRequest(),
      })) {
        const controller = new view.AbortController();
        const type = "synthetic-abort-" + scope;
        let calls = 0;
        const listener = () => calls++;
        target.addEventListener(type, listener, { signal: controller.signal });
        for (let count = 0; count < 2; count++) {
          controller.signal.dispatchEvent(new view.Event("abort"));
          target.dispatchEvent(new view.Event(type));
        }
        const afterSynthetic = calls;
        controller.abort();
        target.dispatchEvent(new view.Event(type));
        target.addEventListener(type, listener, { once: true });
        target.dispatchEvent(new view.Event(type));
        target.dispatchEvent(new view.Event(type));
        results.push({ scope, afterSynthetic, calls });
        target.removeEventListener(type, listener);
      }
      element.remove();
      return results;
    }
    return { native: exercise(window), virtual: exercise(child) };
  });
  expect(result.native).toEqual(
    ["window", "document", "html", "element", "xhr"].map((scope) => ({
      scope,
      afterSynthetic: 2,
      calls: 3,
    })),
  );
  expect(result.virtual).toEqual(result.native);
});

test("cancellation survives stopped abort events and reentrant listener registration", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/documents/dom.html", id: "frame" });
  const result = await page.evaluate(() => {
    const child = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    function exercise(view: Window & typeof globalThis) {
      const element = view.document.createElement("button");
      view.document.body.append(element);
      const results = [];
      for (const [scope, target] of Object.entries({
        window: view,
        document: view.document,
        html: view.document.documentElement,
        element,
        xhr: new view.XMLHttpRequest(),
      })) {
        const controller = new view.AbortController();
        const type = "stopped-abort-" + scope;
        let calls = 0;
        let insideAbort = -1;
        const listener = () => calls++;
        controller.signal.addEventListener("abort", (event) => {
          event.stopImmediatePropagation();
          target.dispatchEvent(new view.Event(type));
          insideAbort = calls;
          target.addEventListener(type, listener, { once: true });
          target.dispatchEvent(new view.Event(type));
        });
        target.addEventListener(type, listener, { signal: controller.signal });
        controller.abort();
        target.dispatchEvent(new view.Event(type));
        const afterAbort = calls;
        target.addEventListener(type, listener);
        target.dispatchEvent(new view.Event(type));
        target.removeEventListener(type, listener);
        results.push({ scope, insideAbort, afterAbort, calls });
      }
      element.remove();
      return results;
    }
    return { native: exercise(window), virtual: exercise(child) };
  });
  expect(result.native).toEqual(
    ["window", "document", "html", "element", "xhr"].map((scope) => ({
      scope,
      insideAbort: 0,
      afterAbort: 1,
      calls: 2,
    })),
  );
  expect(result.virtual).toEqual(result.native);
});

test("snapshots option getters once and treats explicit null passive as false", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/documents/dom.html", id: "frame" });
  const result = await page.evaluate(() => {
    const child = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    function exercise(view: Window & typeof globalThis) {
      const element = view.document.createElement("button");
      view.document.body.append(element);
      const results = [];
      for (const [scope, target] of Object.entries({
        window: view,
        document: view.document,
        html: view.document.documentElement,
        element,
      })) {
        const reads: string[] = [];
        let count = 0;
        const listener = () => count++;
        target.addEventListener("getter-" + scope, listener, {
          get capture() {
            reads.push("capture");
            return reads.length === 1;
          },
          get once() {
            reads.push("once");
            return true;
          },
          get passive() {
            reads.push("passive");
            return false;
          },
          get signal() {
            reads.push("signal");
            return undefined;
          },
        } as unknown as AddEventListenerOptions);
        element.dispatchEvent(new view.Event("getter-" + scope, { bubbles: true }));
        element.dispatchEvent(new view.Event("getter-" + scope, { bubbles: true }));
        const active = (event: Event) => event.preventDefault();
        target.addEventListener("wheel", active, {
          passive: null,
        } as unknown as AddEventListenerOptions);
        const wheel = new view.Event("wheel", { bubbles: true, cancelable: true });
        element.dispatchEvent(wheel);
        target.removeEventListener("wheel", active);
        const controller = new view.AbortController();
        let abortedCount = 0;
        target.addEventListener("aborted-" + scope, () => abortedCount++, {
          get capture() {
            controller.abort();
            return false;
          },
          signal: controller.signal,
        });
        element.dispatchEvent(new view.Event("aborted-" + scope, { bubbles: true }));
        results.push({
          scope,
          reads,
          count,
          prevented: wheel.defaultPrevented,
          abortedCount,
        });
      }
      element.remove();
      return results;
    }
    return { native: exercise(window), virtual: exercise(child) };
  });
  expect(result.native).toEqual(
    ["window", "document", "html", "element"].map((scope) => ({
      scope,
      reads: ["capture", "once", "passive", "signal"],
      count: 1,
      prevented: true,
      abortedCount: 0,
    })),
  );
  expect(result.virtual).toEqual(result.native);
});
