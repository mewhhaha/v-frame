import { expect, test } from "@playwright/test";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { frameFailures, installBundle, mountFrame } from "./support/mount-frame";

let fixture: HTTPFixture;

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/guest.html": htmlDocument('<button id="target">Target</button>'),
      "/patched.html": htmlDocument(
        `<script>
          window.selectorCalls = [];
          for (const prototype of [Element.prototype, DocumentFragment.prototype]) {
            const native = prototype.querySelectorAll;
            prototype.querySelectorAll = function (selector) {
              window.selectorCalls.push(String(selector));
              return native.call(this, selector);
            };
          }
        </script>`,
      ),
    },
  });
});

test.afterAll(async () => {
  await fixture.close();
});

test("window on* handlers fire for guest events for every bridged type", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/guest.html", id: "frame" });
  const counts = await page.evaluate(() => {
    const view = (
      document.querySelector("#frame") as HTMLElement & {
        contentWindow: Window & typeof globalThis;
      }
    ).contentWindow;
    const button = view.document.querySelector("#target")!;
    // None of these were in the hand-kept list the bridge used to rely on.
    const types = [
      "drop",
      "dragstart",
      "select",
      "animationend",
      "transitionend",
      "gotpointercapture",
    ];
    const counts: Record<string, number> = {};
    for (const type of types) {
      counts[type] = 0;
      (view as unknown as Record<string, unknown>)["on" + type] = () => {
        counts[type] = (counts[type] ?? 0) + 1;
      };
      button.dispatchEvent(new view.Event(type, { bubbles: true }));
    }
    return counts;
  });
  for (const [type, count] of Object.entries(counts)) {
    expect(count, type).toBe(1);
  }
});

test("window on* handlers replace and clear like native handler attributes", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/guest.html", id: "frame" });
  const result = await page.evaluate(() => {
    const view = (
      document.querySelector("#frame") as HTMLElement & {
        contentWindow: Window & typeof globalThis;
      }
    ).contentWindow;
    const button = view.document.querySelector("#target")!;
    const log: string[] = [];
    const first = () => log.push("first");
    view.ontransitionend = first;
    view.ontransitionend = () => log.push("second");
    button.dispatchEvent(new view.Event("transitionend", { bubbles: true }));
    const replacedGetter = view.ontransitionend !== first;
    view.ontransitionend = null;
    button.dispatchEvent(new view.Event("transitionend", { bubbles: true }));
    return { log, replacedGetter, cleared: view.ontransitionend };
  });
  expect(result).toEqual({ log: ["second"], replacedGetter: true, cleared: null });
});

test("window-native handlers stay bound to the realm window", async ({ page }) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/guest.html", id: "frame" });
  const result = await page.evaluate(async () => {
    const view = (
      document.querySelector("#frame") as HTMLElement & {
        contentWindow: Window & typeof globalThis;
      }
    ).contentWindow;
    const button = view.document.querySelector("#target")!;
    const fired: string[] = [];
    const message = new Promise<void>((resolve) => {
      view.onmessage = () => {
        fired.push("message");
        resolve();
      };
    });
    view.onpagehide = () => fired.push("pagehide");
    view.postMessage("ping", "*");
    await message;
    view.dispatchEvent(new view.Event("pagehide"));
    // A guest-tree event of a window-native type must not reach the handler.
    button.dispatchEvent(new view.Event("pagehide", { bubbles: true }));
    return fired;
  });
  expect(result).toEqual(["message", "pagehide"]);
});

test("a host without constructable stylesheets fails bootstrap loudly", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await page.evaluate(() => {
    Object.defineProperty(window, "CSSStyleSheet", {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });
  const frame = await mountFrame(page, {
    src: fixture.origin + "/guest.html",
    id: "frame",
    settle: "none",
  });
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as unknown as { status: string }).status),
    )
    .toBe("error");
  expect((await frameFailures(frame)).map((failure) => failure.phase)).toContain(
    "bootstrap",
  );
});

test("a viewport property that cannot be patched fails bootstrap", async ({ page }) => {
  await installBundle(page, fixture.origin);
  await page.evaluate(() => {
    const define = Object.defineProperty;
    // Stands in for an engine that refuses to redefine a window property.
    Object.defineProperty = ((target: object, key: PropertyKey, descriptor) => {
      if (key === "innerHeight" && target !== window) {
        throw new TypeError("Cannot redefine property: innerHeight");
      }
      return define(target, key, descriptor);
    }) as typeof Object.defineProperty;
  });
  const frame = await mountFrame(page, {
    src: fixture.origin + "/guest.html",
    id: "frame",
    settle: "none",
  });
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as unknown as { status: string }).status),
    )
    .toBe("error");
  expect((await frameFailures(frame)).map((failure) => failure.phase)).toContain(
    "bootstrap",
  );
});

test("host bookkeeping does not run a guest-patched querySelectorAll", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/patched.html", id: "patched" });
  const calls = await page.evaluate(async () => {
    const view = (
      document.querySelector("#patched") as HTMLElement & {
        contentWindow: Window & typeof globalThis & { selectorCalls: string[] };
      }
    ).contentWindow;
    view.selectorCalls.length = 0;
    // Connecting nodes drives the host's clone cleanup, style and link discovery.
    const container = view.document.createElement("div");
    container.innerHTML =
      "<style>p{color:red}</style><link rel='stylesheet' href='x.css'>";
    view.document.body.append(container);
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    return view.selectorCalls;
  });
  expect(calls).toEqual([]);
});
