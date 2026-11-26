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
      "/base-guest.html": htmlDocument(
        '<base href="/first/"><a id="link" href="item.html">Item</a><div id="other">Other</div>',
      ),
      "/styled-guest.html": htmlDocument(
        '<style>p { color: rgb(1, 2, 3); }</style><p id="styled">Styled</p>',
      ),
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

test("VFrameElement.prewarm() claims a pristine hidden iframe via moveBefore and cleans up safely", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const result = await page.evaluate(async (origin) => {
    const VFrameElement = customElements.get("v-frame") as typeof HTMLElement & {
      prewarm(doc?: Document): () => void;
    };
    const hasMoveBefore = typeof ShadowRoot.prototype.moveBefore === "function";

    // Disposing an unclaimed spare removes it cleanly and is idempotent.
    const disposeUnused = VFrameElement.prewarm();
    const spareAfterFirst = document.documentElement.querySelector(":scope > iframe");
    const disposeDuplicate = VFrameElement.prewarm();
    const countAfterSecond =
      document.documentElement.querySelectorAll(":scope > iframe").length;
    disposeUnused();
    disposeDuplicate();
    const countAfterDispose =
      document.documentElement.querySelectorAll(":scope > iframe").length;

    // Prewarm a fresh spare, wait for its empty srcdoc load, then mount a <v-frame>.
    const disposeClaimed = VFrameElement.prewarm();
    const spare = document.documentElement.querySelector(
      ":scope > iframe",
    ) as HTMLIFrameElement | null;
    if (spare !== null && spare.contentDocument?.URL !== "about:srcdoc") {
      await new Promise<void>((resolve) =>
        spare.addEventListener("load", () => resolve(), { once: true }),
      );
    }
    const spareWindow = spare?.contentWindow ?? null;
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: Window | null;
      whenReady(): Promise<void>;
    };
    frame.setAttribute("src", `${origin}/guest.html`);
    document.body.append(frame);
    await frame.whenReady();
    const claimedSameWindow = spareWindow !== null && frame.contentWindow === spareWindow;
    const rootIframesAfterClaim =
      document.documentElement.querySelectorAll(":scope > iframe").length;
    // Disposing after claim must not touch the live frame.
    disposeClaimed();
    const stillConnectedAfterDispose =
      frame.shadowRoot?.querySelector("iframe")?.isConnected === true;

    // A second frame falls back cleanly to its own fresh realm.
    const second = document.createElement("v-frame") as HTMLElement & {
      contentWindow: Window | null;
      whenReady(): Promise<void>;
    };
    second.setAttribute("src", `${origin}/guest.html`);
    document.body.append(second);
    await second.whenReady();
    const distinctSecondRealm = second.contentWindow !== frame.contentWindow;

    // Replacing srcdoc on a spare invalidates it rather than claiming polluted state.
    const disposePolluted = VFrameElement.prewarm();
    const pollutedSpare = document.documentElement.querySelector(
      ":scope > iframe",
    ) as HTMLIFrameElement | null;
    let pollutedClean = true;
    if (pollutedSpare !== null) {
      if (pollutedSpare.contentDocument?.URL !== "about:srcdoc") {
        await new Promise<void>((resolve) =>
          pollutedSpare.addEventListener("load", () => resolve(), { once: true }),
        );
      }
      await new Promise<void>((resolve) => {
        pollutedSpare.addEventListener("load", () => resolve(), { once: true });
        pollutedSpare.srcdoc = "<script>window.__prewarmPolluted = 123;</script>";
      });
      const third = document.createElement("v-frame") as HTMLElement & {
        contentWindow: (Window & { __prewarmPolluted?: number }) | null;
        whenReady(): Promise<void>;
      };
      third.setAttribute("src", `${origin}/guest.html`);
      document.body.append(third);
      await third.whenReady();
      pollutedClean = third.contentWindow?.__prewarmPolluted === undefined;
      third.remove();
    }
    disposePolluted();

    // Replacing srcdoc immediately before first load also invalidates the spare.
    const disposeEarlyPolluted = VFrameElement.prewarm();
    const earlySpare = document.documentElement.querySelector(
      ":scope > iframe",
    ) as HTMLIFrameElement | null;
    let earlyPollutedClean = true;
    if (earlySpare !== null) {
      await new Promise<void>((resolve) => {
        earlySpare.addEventListener("load", () => resolve(), { once: true });
        earlySpare.srcdoc = "<script>window.__earlyPolluted = 123;</script>";
      });
      const earlyFrame = document.createElement("v-frame") as HTMLElement & {
        contentWindow: (Window & { __earlyPolluted?: number }) | null;
        whenReady(): Promise<void>;
      };
      earlyFrame.setAttribute("src", `${origin}/guest.html`);
      document.body.append(earlyFrame);
      await earlyFrame.whenReady();
      earlyPollutedClean = earlyFrame.contentWindow?.__earlyPolluted === undefined;
      earlyFrame.remove();
    }
    disposeEarlyPolluted();
    frame.remove();
    second.remove();

    return {
      hasMoveBefore,
      hadSpare: spareAfterFirst !== null,
      countAfterSecond,
      countAfterDispose,
      claimedSameWindow,
      rootIframesAfterClaim,
      stillConnectedAfterDispose,
      distinctSecondRealm,
      pollutedClean,
      earlyPollutedClean,
    };
  }, fixture.origin);

  expect(result).toEqual({
    hasMoveBefore: result.hasMoveBefore,
    hadSpare: result.hasMoveBefore,
    countAfterSecond: result.hasMoveBefore ? 1 : 0,
    countAfterDispose: 0,
    claimedSameWindow: result.hasMoveBefore,
    rootIframesAfterClaim: 0,
    stillConnectedAfterDispose: true,
    distinctSecondRealm: true,
    pollutedClean: true,
    earlyPollutedClean: true,
  });
});

test("settled moves do not drop native base removals, style edits, or guest shadow scripts", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/base-guest.html", id: "base-frame" });
  const baseResult = await page.evaluate(async () => {
    const frame = document.querySelector("#base-frame") as HTMLElement & {
      contentWindow: Window & typeof globalThis;
    };
    const view = frame.contentWindow;
    const base = view.document.querySelector("base")!;
    const link = view.document.querySelector("#link") as HTMLAnchorElement;
    const other = view.document.querySelector("#other")!;
    // Remove <base> natively, then remove an unrelated element via the facade.
    Node.prototype.removeChild.call(base.parentNode!, base);
    other.remove();
    await Promise.resolve();
    await Promise.resolve();
    return {
      baseURI: view.document.baseURI,
      physicalHref: Element.prototype.getAttribute.call(link, "href"),
    };
  });
  expect(baseResult.baseURI).toBe(`${fixture.origin}/base-guest.html`);
  expect(baseResult.physicalHref).toBe(`${fixture.origin}/item.html`);

  await mountFrame(page, { src: fixture.origin + "/guest.html", id: "style-frame" });
  const styleAndShadow = await page.evaluate(async () => {
    const frame = document.querySelector("#style-frame") as HTMLElement & {
      contentWindow: Window & typeof globalThis;
    };
    const view = frame.contentWindow;
    // 1) Native <style> insertion + unrelated settled move + textContent += rule.
    const a = view.document.createElement("div");
    const b = view.document.createElement("div");
    const p = view.document.createElement("p");
    p.id = "p";
    view.document.body.append(a, b, p);
    const style = view.document.createElement("style");
    style.textContent = "#p { color: rgb(11, 22, 33); }";
    Node.prototype.appendChild.call(view.document.body, style);
    view.document.body.appendChild(a);
    style.textContent += " #p { background-color: rgb(44, 55, 66); }";
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const computed = view.getComputedStyle(p);
    const colors = { color: computed.color, bg: computed.backgroundColor };

    // 2) Settled custom element moved into a guest shadow root appending a script natively.
    (view as unknown as { shadowRan?: boolean }).shadowRan = false;
    const host = view.document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    class ShadowMover extends view.HTMLElement {
      connectedCallback() {
        if (this.parentNode === shadow) {
          const s = view.document.createElement("script");
          s.textContent = "window.shadowRan = true;";
          Node.prototype.appendChild.call(this, s);
        }
      }
    }
    view.customElements.define("shadow-mover", ShadowMover);
    const mover = view.document.createElement("shadow-mover");
    view.document.body.append(mover, host);
    view.Node.prototype.appendChild.call(shadow, mover);
    return { colors, shadowRan: (view as unknown as { shadowRan?: boolean }).shadowRan };
  });
  expect(styleAndShadow).toEqual({
    colors: { color: "rgb(11, 22, 33)", bg: "rgb(44, 55, 66)" },
    shadowRan: true,
  });
});

test("custom Trusted Types policy rewriting markup still restores authored styles", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const color = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: Window & typeof globalThis;
      trustedTypesPolicy: {
        name: string;
        createHTML(source: string): string;
        createScript(source: string): string;
        createScriptURL(source: string): string;
      };
      whenReady(): Promise<void>;
    };
    frame.trustedTypesPolicy = {
      name: "rewrite-style-check",
      createHTML: (source) => `${source}<!-- policy-touched -->`,
      createScript: (source) => source,
      createScriptURL: (source) => source,
    };
    frame.setAttribute("src", `${origin}/styled-guest.html`);
    document.body.append(frame);
    await frame.whenReady();
    const p = frame.contentWindow.document.querySelector("#styled")!;
    const result = frame.contentWindow.getComputedStyle(p).color;
    frame.remove();
    return result;
  }, fixture.origin);
  expect(color).toBe("rgb(1, 2, 3)");
});
