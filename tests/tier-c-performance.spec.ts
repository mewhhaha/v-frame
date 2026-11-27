import { expect, test } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import {
  bundleRoute,
  htmlDocument,
  type HTTPFixture,
  parkRoute,
  startHTTPFixture,
} from "./support/http-fixture";
import { installBundle } from "./support/mount-frame";

function ssrFrameHTML(options: {
  id: string;
  src: string;
  adoptAttr: string;
  extraAttrs?: string;
  bodyHTML: string;
  headHTML?: string;
  styleAttr?: string;
}): string {
  const {
    id,
    src,
    adoptAttr,
    extraAttrs = "",
    bodyHTML,
    headHTML = "",
    styleAttr = "",
  } = options;
  const style = styleAttr === "" ? "" : ` style="${styleAttr}"`;
  return `
    <v-frame id="${id}" src="${src}" ${adoptAttr} ${extraAttrs}${style}>
      <template shadowrootmode="open">
        <v-html>
          <v-head>${headHTML}</v-head>
          <v-body>${bodyHTML}</v-body>
        </v-html>
      </template>
    </v-frame>
  `;
}

let fixture: HTTPFixture;
const blockingA = parkRoute({
  type: "text/javascript",
  headers: { "cache-control": "public, max-age=60" },
  body: `window.__order = window.__order || []; window.__order.push("a");`,
});
const blockingB = parkRoute({
  type: "text/javascript",
  headers: { "cache-control": "public, max-age=60" },
  body: `window.__order = window.__order || []; window.__order.push("b");`,
});
const slowEntry = parkRoute({
  type: "text/html",
  body: htmlDocument(`
    <div id="early-root">early</div>
    <script src="/early-a.js"></script>
    <script src="/early-b.js"></script>
  `),
});
const slowAbortEntry = parkRoute({
  type: "text/html",
  body: htmlDocument(`<div id="abort-root">abort</div>`),
});
let earlyARequests = 0;
let earlyBRequests = 0;
let abortPreloadRequests = 0;
let deferredEntryRequests = 0;

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/lazy-attrs.html": htmlDocument(
        `
          <div id="card" data-initial="yes" style="color: rgb(10, 20, 30)" onclick="window.__clicked = (window.__clicked || 0) + 1">
            <a id="link" href="sub/page.html">Link</a>
          </div>
          <script>window.__bootCount = (window.__bootCount || 0) + 1;</script>
        `,
        "<title>Lazy Attrs</title>",
      ),
      "/lazy-events.html": htmlDocument(
        `<button id="btn">Go</button><div id="target">Target</div>`,
        "<title>Lazy Events</title>",
      ),
      "/content-vis.html": htmlDocument(
        `
          <div id="wrap">
            <section class="card" id="c1">One</section>
            <section class="card pinned" id="c2">Two</section>
            <dialog id="dlg">Dialog</dialog>
            <div id="pop" popover>Popover</div>
          </div>
          <script>window.__cvMarker = Symbol("cv");</script>
        `,
        `<style>.pinned { content-visibility: visible; }</style>`,
      ),
      "/preload-blocking.html": htmlDocument(`
        <script src="/blocking-a.js"></script>
        <script src="/blocking-b.js"></script>
        <script>window.__order.push("inline");</script>
      `),
      "/blocking-a.js": blockingA.route,
      "/blocking-b.js": blockingB.route,
      "/slow-entry.html": slowEntry.route,
      "/slow-abort-entry.html": slowAbortEntry.route,
      "/early-a.js": () => {
        earlyARequests += 1;
        return {
          type: "text/javascript",
          headers: { "cache-control": "public, max-age=60" },
          body: `window.__earlyOrder = window.__earlyOrder || []; window.__earlyOrder.push("early-a");`,
        };
      },
      "/early-b.js": () => {
        earlyBRequests += 1;
        return {
          type: "text/javascript",
          headers: { "cache-control": "public, max-age=60" },
          body: `window.__earlyOrder = window.__earlyOrder || []; window.__earlyOrder.push("early-b");`,
        };
      },
      "/abort-preload.js": () => {
        abortPreloadRequests += 1;
        return {
          type: "text/javascript",
          headers: { "cache-control": "public, max-age=60" },
          body: `window.__abortPreload = true;`,
        };
      },
      "/deferred-entry.html": () => {
        deferredEntryRequests += 1;
        return { body: htmlDocument(`<p id="copy">Fetched from network</p>`) };
      },
      "/never-host-nav": htmlDocument(`<p id="wrong-page">Should not navigate host</p>`),
      "/host-visible.html": htmlDocument(`
        <div style="height: 2800px">spacer</div>
        ${ssrFrameHTML({
          id: "vis-frame",
          src: "/deferred-entry.html",
          adoptAttr: 'adopt="visible"',
          styleAttr: "display:block;height:120px",
          bodyHTML: `
            <p id="copy">Preview</p>
            <script type="application/vnd.v-frame" data-v-frame-script="">
              document.querySelector("#copy").textContent = "Activated on visible";
            </script>
          `,
        })}
      `),
      "/host-interaction.html": htmlDocument(`
        ${ssrFrameHTML({
          id: "int-frame",
          src: "/deferred-entry.html",
          adoptAttr: 'adopt="interaction"',
          bodyHTML: `
            <input id="draft" type="text" value="">
            <a id="preview-link" href="/never-host-nav">Stay here</a>
            <form id="preview-form" action="/never-host-nav"><button id="sub-btn" type="submit">Send</button></form>
            <p id="copy">Preview</p>
            <script type="application/vnd.v-frame" data-v-frame-script="">
              document.querySelector("#copy").textContent = "Activated on interaction";
            </script>
          `,
        })}
      `),
      "/host-idle.html": htmlDocument(`
        ${ssrFrameHTML({
          id: "idle-frame",
          src: "/deferred-entry.html",
          adoptAttr: 'adopt="idle"',
          bodyHTML: `
            <p id="copy">Preview</p>
            <script type="application/vnd.v-frame" data-v-frame-script="">
              document.querySelector("#copy").textContent = "Activated on idle";
            </script>
          `,
        })}
      `),
      "/host-controls.html": htmlDocument(`
        ${ssrFrameHTML({
          id: "ctrl-frame",
          src: "/deferred-entry.html",
          adoptAttr: 'adopt="interaction"',
          bodyHTML: `
            <p id="copy">Preview</p>
            <script type="application/vnd.v-frame" data-v-frame-script="">
              document.querySelector("#copy").textContent = "Activated imperatively";
            </script>
          `,
        })}
        ${ssrFrameHTML({
          id: "eager-switch-frame",
          src: "/deferred-entry.html",
          adoptAttr: 'adopt="interaction"',
          bodyHTML: `
            <p id="copy">Preview 2</p>
            <script type="application/vnd.v-frame" data-v-frame-script="">
              document.querySelector("#copy").textContent = "Activated via adoptMode";
            </script>
          `,
        })}
        ${ssrFrameHTML({
          id: "disconnect-frame",
          src: "/deferred-entry.html",
          adoptAttr: 'adopt="interaction"',
          bodyHTML: `<p id="copy">Will disconnect</p>`,
        })}
        <v-frame id="no-preview-frame" src="/deferred-entry.html" adopt="visible"></v-frame>
      `),
    },
  });
});

test.afterAll(async () => {
  blockingA.abandon();
  blockingB.abandon();
  slowEntry.abandon();
  slowAbortEntry.abandon();
  await fixture.close();
});

test.describe("Tier C opt-in performance modes", () => {
  test("C1 lazy-attributes preserves guest Attr identity, live NamedNodeMap, URLs, styles, handlers, and brand checks", async ({
    page,
  }) => {
    await installBundle(page, fixture.origin);
    const result = await page.evaluate(async (url) => {
      const frame = document.createElement("v-frame") as VFrameElement;
      frame.lazyAttributes = true;
      const reflectedBefore = frame.hasAttribute("lazy-attributes");
      frame.src = url;
      document.querySelector("#host")!.append(frame);
      await frame.whenReady();

      const guest = frame.contentWindow! as Window & typeof globalThis;
      const doc = guest.document;
      const card = doc.querySelector("#card")!;
      const link = doc.querySelector("#link") as HTMLAnchorElement;

      // On-demand Attr via getAttributeNode + detached identity after removeAttributeNode
      const initialAttr = card.getAttributeNode("data-initial")!;
      const initialOwnerMatches = initialAttr.ownerDocument === doc;
      const initialBaseMatches = initialAttr.baseURI === doc.baseURI;
      const initialRootMatches = initialAttr.getRootNode() === initialAttr;

      // setAttribute without touching .attributes, then on-demand getAttributeNode
      card.setAttribute("data-dynamic", "42");
      const dynAttr = card.getAttributeNode("data-dynamic")!;
      const dynOwner = dynAttr.ownerDocument === doc;
      const dynBase = dynAttr.baseURI === doc.baseURI;

      // Cached live NamedNodeMap updated by subsequent setAttribute + removeAttribute
      const liveMap = card.attributes;
      card.setAttribute("data-live", "hello");
      const liveAttr = liveMap.getNamedItem("data-live")!;
      card.removeAttribute("data-live");
      const detachedLiveOwner = liveAttr.ownerDocument === doc;
      const detachedLiveBase = liveAttr.baseURI === doc.baseURI;

      // removeAttributeNode marks Attr before detachment
      const removedAttr = card.removeAttributeNode(dynAttr);
      const removedOwner = removedAttr.ownerDocument === doc;
      const removedBase = removedAttr.baseURI === doc.baseURI;

      // Invalid removeAttributeNode argument throws native TypeError
      let invalidRemoveThrew = false;
      try {
        card.removeAttributeNode({ ownerElement: card } as unknown as Attr);
      } catch (error) {
        invalidRemoveThrew = error instanceof guest.TypeError;
      }

      // Attr.prototype brand check rejects spoofed objects
      let spoofedGetterThrew = false;
      try {
        Object.getOwnPropertyDescriptor(guest.Attr.prototype, "ownerDocument")!.get!.call(
          { ownerElement: card },
        );
      } catch (error) {
        spoofedGetterThrew = error instanceof guest.TypeError;
      }

      // URL attribute, inline style, and inline event handler still work
      const resolvedHref = link.href;
      const authoredHref = link.getAttribute("href");
      const computedColor = guest.getComputedStyle(card).color;
      card.dispatchEvent(new guest.MouseEvent("click", { bubbles: true }));
      const clicks = (guest as unknown as { __clicked?: number }).__clicked;

      // Toggling lazyAttributes reloads cleanly with default eager marking
      const prevWindow = guest;
      const reloaded = new Promise<void>((resolve) => {
        frame.addEventListener("v-frame-load", () => resolve(), { once: true });
      });
      frame.lazyAttributes = false;
      await reloaded;
      const reloadedNewWindow = frame.contentWindow !== prevWindow;
      const reflectedAfter = frame.hasAttribute("lazy-attributes");

      return {
        reflectedBefore,
        reflectedAfter,
        initialOwnerMatches,
        initialBaseMatches,
        initialRootMatches,
        dynOwner,
        dynBase,
        detachedLiveOwner,
        detachedLiveBase,
        removedOwner,
        removedBase,
        invalidRemoveThrew,
        spoofedGetterThrew,
        resolvedHref,
        authoredHref,
        computedColor,
        clicks,
        reloadedNewWindow,
      };
    }, `${fixture.origin}/lazy-attrs.html`);

    expect(result).toEqual({
      reflectedBefore: true,
      reflectedAfter: false,
      initialOwnerMatches: true,
      initialBaseMatches: true,
      initialRootMatches: true,
      dynOwner: true,
      dynBase: true,
      detachedLiveOwner: true,
      detachedLiveBase: true,
      removedOwner: true,
      removedBase: true,
      invalidRemoveThrew: true,
      spoofedGetterThrew: true,
      resolvedHref: `${fixture.origin}/sub/page.html`,
      authoredHref: "sub/page.html",
      computedColor: "rgb(10, 20, 30)",
      clicks: 1,
      reloadedNewWindow: true,
    });
  });

  test("C2 adopt='visible' keeps offscreen SSR preview idle with 0 iframes until scrolled into view", async ({
    page,
  }) => {
    const beforeRequests = deferredEntryRequests;
    await page.goto(`${fixture.origin}/host-visible.html`);
    await page.evaluate(async (url) => {
      const bundle = await import(url);
      bundle.defineVFrame();
    }, `${fixture.origin}/dist/index.js`);

    // Give IntersectionObserver a couple of frames to report offscreen status.
    await page.waitForTimeout(100);
    const beforeScroll = await page.evaluate(() => {
      const frame = document.querySelector<VFrameElement>("#vis-frame")!;
      return {
        status: frame.status,
        adopt: frame.adopt,
        adoptMode: frame.adoptMode,
        iframes: frame.shadowRoot.querySelectorAll("iframe").length,
        text: frame.shadowRoot.querySelector("#copy")?.textContent,
      };
    });
    expect(beforeScroll).toEqual({
      status: "idle",
      adopt: true,
      adoptMode: "visible",
      iframes: 0,
      text: "Preview",
    });
    expect(deferredEntryRequests).toBe(beforeRequests);

    // Scroll into view -> activates automatically without fetching the entry document.
    await page.locator("#vis-frame").scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const frame = document.querySelector<VFrameElement>("#vis-frame")!;
          return {
            status: frame.status,
            text: frame.shadowRoot.querySelector("#copy")?.textContent,
          };
        }),
      )
      .toEqual({
        status: "ready",
        text: "Activated on visible",
      });
    expect(deferredEntryRequests).toBe(beforeRequests);
  });

  test("C2 adopt='interaction' activates on input while preserving draft and blocks preview link navigation", async ({
    page,
  }) => {
    const beforeRequests = deferredEntryRequests;
    await page.goto(`${fixture.origin}/host-interaction.html`);
    await page.evaluate(async (url) => {
      const bundle = await import(url);
      bundle.defineVFrame();
    }, `${fixture.origin}/dist/index.js`);

    await page.waitForTimeout(100);
    const initial = await page.evaluate(() => {
      const frame = document.querySelector<VFrameElement>("#int-frame")!;
      return {
        status: frame.status,
        adoptMode: frame.adoptMode,
        iframes: frame.shadowRoot.querySelectorAll("iframe").length,
      };
    });
    expect(initial).toEqual({ status: "idle", adoptMode: "interaction", iframes: 0 });

    // Type into preview input -> activates and preserves draft in live guest DOM.
    const input = page.locator("#int-frame").locator("#draft");
    await input.click();
    await input.fill("typed before hydration");

    await expect
      .poll(() =>
        page.evaluate(() => {
          const frame = document.querySelector<VFrameElement>("#int-frame")!;
          return {
            status: frame.status,
            text: frame.shadowRoot.querySelector("#copy")?.textContent,
            value: (
              frame.contentWindow?.document.querySelector(
                "#draft",
              ) as HTMLInputElement | null
            )?.value,
          };
        }),
      )
      .toEqual({
        status: "ready",
        text: "Activated on interaction",
        value: "typed before hydration",
      });
    expect(deferredEntryRequests).toBe(beforeRequests);

    // Fresh page: clicking a preview link activates without hard-navigating the host page.
    await page.goto(`${fixture.origin}/host-interaction.html`);
    await page.evaluate(async (url) => {
      const bundle = await import(url);
      bundle.defineVFrame();
    }, `${fixture.origin}/dist/index.js`);
    await page.waitForTimeout(50);

    await page.locator("#int-frame").locator("#preview-link").click();
    await expect.poll(() =>
      page.evaluate(() => ({
        hostPath: location.pathname,
        status: document.querySelector<VFrameElement>("#int-frame")!.status,
        text: document
          .querySelector<VFrameElement>("#int-frame")!
          .shadowRoot.querySelector("#copy")?.textContent,
      })),
    );
    // Fresh page: submitting a preview form activates without hard-navigating the host page.
    await page.goto(`${fixture.origin}/host-interaction.html`);
    await page.evaluate(async (url) => {
      const bundle = await import(url);
      bundle.defineVFrame();
    }, `${fixture.origin}/dist/index.js`);
    await page.waitForTimeout(50);

    await page.locator("#int-frame").locator("#sub-btn").click();
    await expect
      .poll(() =>
        page.evaluate(() => ({
          hostPath: location.pathname,
          status: document.querySelector<VFrameElement>("#int-frame")!.status,
          text: document
            .querySelector<VFrameElement>("#int-frame")!
            .shadowRoot.querySelector("#copy")?.textContent,
        })),
      )
      .toEqual({
        hostPath: "/host-interaction.html",
        status: "ready",
        text: "Activated on interaction",
      });
  });

  test("C2 adopt='idle', activate(), adoptMode switch, disconnect cleanup, and non-SSR fallback", async ({
    page,
  }) => {
    await page.goto(`${fixture.origin}/host-idle.html`);
    await page.evaluate(async (url) => {
      const bundle = await import(url);
      bundle.defineVFrame();
    }, `${fixture.origin}/dist/index.js`);

    await expect
      .poll(() =>
        page.evaluate(() => {
          const frame = document.querySelector<VFrameElement>("#idle-frame")!;
          return {
            status: frame.status,
            text: frame.shadowRoot.querySelector("#copy")?.textContent,
          };
        }),
      )
      .toEqual({
        status: "ready",
        text: "Activated on idle",
      });

    // Imperative activate(), switching adoptMode to "eager", disconnect abort, and no-preview fallback.
    await page.goto(`${fixture.origin}/host-controls.html`);
    await page.evaluate(async (url) => {
      const bundle = await import(url);
      bundle.defineVFrame();
    }, `${fixture.origin}/dist/index.js`);

    const controlResults = await page.evaluate(async () => {
      const ctrl = document.querySelector<VFrameElement>("#ctrl-frame")!;
      const eagerSwitch = document.querySelector<VFrameElement>("#eager-switch-frame")!;
      const disc = document.querySelector<VFrameElement>("#disconnect-frame")!;
      const noPreview = document.querySelector<VFrameElement>("#no-preview-frame")!;

      const ctrlIdleBefore = ctrl.status === "idle";
      await ctrl.activate();
      const ctrlText = ctrl.shadowRoot.querySelector("#copy")?.textContent;
      // Calling activate() when already ready is a clean no-op.
      await ctrl.activate();

      eagerSwitch.adoptMode = "eager";
      await eagerSwitch.whenReady();
      const eagerText = eagerSwitch.shadowRoot.querySelector("#copy")?.textContent;

      const discWait = disc.whenReady();
      disc.remove();
      let discRejectedAbort = false;
      try {
        await discWait;
      } catch (error) {
        discRejectedAbort = (error as DOMException).name === "AbortError";
      }

      let disconnectedActivateRejected = false;
      try {
        await disc.activate();
      } catch (error) {
        disconnectedActivateRejected =
          (error as DOMException).name === "InvalidStateError";
      }

      // Frame without SSR preview falls back to eager network fetch.
      await noPreview.whenReady();
      const fallbackText = noPreview.shadowRoot.querySelector("#copy")?.textContent;

      return {
        ctrlIdleBefore,
        ctrlText,
        eagerText,
        discRejectedAbort,
        disconnectedActivateRejected,
        fallbackText,
      };
    });

    expect(controlResults).toEqual({
      ctrlIdleBefore: true,
      ctrlText: "Activated imperatively",
      eagerText: "Activated via adoptMode",
      discRejectedAbort: true,
      disconnectedActivateRejected: true,
      fallbackText: "Fetched from network",
    });
  });

  test("C3 preload-scripts fetches blocking classic scripts concurrently in strict execution order and supports host-declared URLs", async ({
    page,
  }) => {
    await installBundle(page, fixture.origin);

    // 1. Auto preload-scripts: b.js request arrives while a.js is still parked,
    //    and releasing b.js BEFORE a.js still executes ["a", "b", "inline"].
    const autoLoadPromise = page.evaluate(async (url) => {
      const frame = document.createElement("v-frame") as VFrameElement;
      frame.preloadScripts = true;
      frame.src = url;
      document.querySelector("#host")!.append(frame);
      await frame.whenReady();
      const guest = frame.contentWindow as Window & { __order?: string[] };
      const remainingPreloads = frame.shadowRoot
        .querySelector("iframe")!
        .contentDocument!.head.querySelectorAll('link[rel="preload"]').length;
      return { order: guest.__order, remainingPreloads };
    }, `${fixture.origin}/preload-blocking.html`);

    // Release B *before* A: this can only succeed if B was already requested concurrently!
    await blockingB.release();
    await blockingA.release();
    const autoResult = await autoLoadPromise;
    expect(autoResult).toEqual({
      order: ["a", "b", "inline"],
      remainingPreloads: 0,
    });

    // 2. Host-declared preload-scripts="/early-a.js /early-b.js": both script fetches start
    //    while the entry HTML is still parked, and host <link>s are removed after load.
    const prevA = earlyARequests;
    const prevB = earlyBRequests;
    const declaredLoadPromise = page.evaluate(async (url) => {
      const frame = document.createElement("v-frame") as VFrameElement;
      frame.preloadScripts = ["/early-a.js", "/early-b.js"];
      const attrVal = frame.getAttribute("preload-scripts");
      frame.src = url;
      document.querySelector("#host")!.append(frame);
      await frame.whenReady();
      const guest = frame.contentWindow as Window & { __earlyOrder?: string[] };
      return {
        attrVal,
        order: guest.__earlyOrder,
        hostPreloadsLeft: document.head.querySelectorAll('link[rel="preload"]').length,
      };
    }, `${fixture.origin}/slow-entry.html`);

    // Both early scripts must hit the server BEFORE slowEntry is released!
    await expect.poll(() => earlyARequests).toBeGreaterThan(prevA);
    await expect.poll(() => earlyBRequests).toBeGreaterThan(prevB);
    await slowEntry.release();

    const declaredResult = await declaredLoadPromise;
    expect(declaredResult).toEqual({
      attrVal: "/early-a.js /early-b.js",
      order: ["early-a", "early-b"],
      hostPreloadsLeft: 0,
    });

    // 3. Disconnecting while entry fetch is parked cleans up host <link rel="preload">.
    const prevAbort = abortPreloadRequests;
    await page.evaluate((url) => {
      const frame = document.createElement("v-frame") as VFrameElement;
      frame.id = "abort-preload-frame";
      frame.setAttribute("preload-scripts", "/abort-preload.js");
      frame.src = url;
      document.querySelector("#host")!.append(frame);
    }, `${fixture.origin}/slow-abort-entry.html`);
    await expect.poll(() => abortPreloadRequests).toBeGreaterThan(prevAbort);
    const hostPreloadsAfterAbort = await page.evaluate(async () => {
      const frame = document.querySelector("#abort-preload-frame")!;
      frame.remove();
      await Promise.resolve();
      return document.head.querySelectorAll('link[rel="preload"]').length;
    });
    slowAbortEntry.abandon();
    expect(hostPreloadsAfterAbort).toBe(0);
  });

  test("C4 lazy-events handles core, exotic guest/host subclasses, userland subclasses, and disposal restoration", async ({
    page,
  }) => {
    await installBundle(page, fixture.origin);
    const result = await page.evaluate(async (url) => {
      const frame = document.createElement("v-frame") as VFrameElement;
      frame.lazyEvents = true;
      frame.src = url;
      document.querySelector("#host")!.append(frame);
      await frame.whenReady();

      const guest = frame.contentWindow! as Window & typeof globalThis;
      const target = guest.document.querySelector("#target")!;
      const nativeCodeGetterBefore = Object.getOwnPropertyDescriptor(
        guest.CloseEvent.prototype,
        "code",
      )!.get;

      // 1. Core event (click) + exotic guest event (CloseEvent, not in core list)
      const observed: Record<string, unknown> = {};
      target.addEventListener("click", (ev) => {
        observed.clickOk = (ev as MouseEvent).clientX === 12;
      });
      target.dispatchEvent(new guest.MouseEvent("click", { clientX: 12 }));

      target.addEventListener("close", (ev) => {
        const ce = ev as CloseEvent;
        const protoCode = Object.getOwnPropertyDescriptor(
          guest.CloseEvent.prototype,
          "code",
        )!.get!.call(ce);
        observed.guestClose = {
          code: ce.code,
          reason: ce.reason,
          protoCode,
        };
      });
      target.dispatchEvent(
        new guest.CloseEvent("close", { code: 1000, reason: "normal" }),
      );

      // 2. Host-constructed exotic event dispatched directly onto the rendered node
      target.addEventListener("hostclose", (ev) => {
        const ce = ev as CloseEvent;
        observed.hostClose = {
          code: ce.code,
          reason: ce.reason,
        };
      });
      const renderedTarget = frame.shadowRoot.querySelector("#target")!;
      renderedTarget.dispatchEvent(
        new window.CloseEvent("hostclose", { code: 1001, reason: "going away" }),
      );

      // 3. Guest userland subclass of exotic CloseEvent keeps proxy `this`
      class AppCloseEvent extends guest.CloseEvent {
        get label() {
          return `${this.type}:${this.code}:${this.target === target}`;
        }
      }
      target.addEventListener("appclose", (ev) => {
        observed.subclassLabel = (ev as AppCloseEvent).label;
      });
      target.dispatchEvent(new AppCloseEvent("appclose", { code: 4000 }));

      // 4. Verify lazily patched CloseEvent.prototype.code is restored on disconnect/dispose
      const patchedDuringMount =
        Object.getOwnPropertyDescriptor(guest.CloseEvent.prototype, "code")!.get !==
        nativeCodeGetterBefore;
      const closeProto = guest.CloseEvent.prototype;
      frame.remove();
      const restoredAfterDispose =
        Object.getOwnPropertyDescriptor(closeProto, "code")!.get ===
        nativeCodeGetterBefore;

      return {
        ...observed,
        patchedDuringMount,
        restoredAfterDispose,
      };
    }, `${fixture.origin}/lazy-events.html`);

    expect(result).toEqual({
      clickOk: true,
      guestClose: { code: 1000, reason: "normal", protoCode: 1000 },
      hostClose: { code: 1001, reason: "going away" },
      subclassLabel: "appclose:4000:true",
      patchedDuringMount: true,
      restoredAfterDispose: true,
    });
  });

  test("C5 content-visibility applies zero-specificity auto/custom rules, excludes top-layer elements, and updates live without reload", async ({
    page,
  }) => {
    await installBundle(page, fixture.origin);
    const result = await page.evaluate(async (url) => {
      const frame = document.createElement("v-frame") as VFrameElement;
      frame.contentVisibility = "auto";
      frame.src = url;
      document.querySelector("#host")!.append(frame);
      await frame.whenReady();

      const guest = frame.contentWindow as Window & { __cvMarker?: symbol };
      const initialMarker = guest.__cvMarker;
      const readCV = (id: string) =>
        guest.getComputedStyle(guest.document.querySelector(`#${id}`)!).contentVisibility;

      const autoState = {
        wrap: readCV("wrap"),
        c1: readCV("c1"),
        c2Pinned: readCV("c2"),
        dialog: readCV("dlg"),
        popover: readCV("pop"),
      };

      // Live custom selector update without reloading the guest
      frame.contentVisibility = "#c2, .card";
      const customState = {
        c1: readCV("c1"),
        c2Pinned: readCV("c2"),
        sameGuest:
          (frame.contentWindow as Window & { __cvMarker?: symbol }).__cvMarker ===
          initialMarker,
      };

      // Invalid selector and selector-injection attempts fail safely without breaking styles
      frame.contentVisibility = "::invalid[[[";
      const invalidState = {
        c1: readCV("c1"),
        sameGuest:
          (frame.contentWindow as Window & { __cvMarker?: symbol }).__cvMarker ===
          initialMarker,
      };
      frame.contentVisibility = "div){display:none!important}:where(.card";
      const injectionState = {
        c1: readCV("c1"),
        c1Display: guest.getComputedStyle(guest.document.querySelector("#c1")!).display,
        sameGuest:
          (frame.contentWindow as Window & { __cvMarker?: symbol }).__cvMarker ===
          initialMarker,
      };

      // Clearing content-visibility removes the rule live
      frame.contentVisibility = "";
      const clearedState = {
        c1: readCV("c1"),
        attrRemoved: !frame.hasAttribute("content-visibility"),
        sameGuest:
          (frame.contentWindow as Window & { __cvMarker?: symbol }).__cvMarker ===
          initialMarker,
      };

      return { autoState, customState, invalidState, injectionState, clearedState };
    }, `${fixture.origin}/content-vis.html`);

    expect(result).toEqual({
      autoState: {
        wrap: "visible",
        c1: "auto",
        c2Pinned: "visible",
        dialog: "visible",
        popover: "visible",
      },
      customState: {
        c1: "auto",
        c2Pinned: "visible",
        sameGuest: true,
      },
      invalidState: {
        c1: "visible",
        sameGuest: true,
      },
      injectionState: {
        c1: "visible",
        c1Display: "block",
        sameGuest: true,
      },
      clearedState: {
        c1: "visible",
        attrRemoved: true,
        sameGuest: true,
      },
    });
  });

  test("combined Tier C opt-in modes work cleanly together on one frame", async ({
    page,
  }) => {
    await installBundle(page, fixture.origin);
    const combined = await page.evaluate(async (url) => {
      const frame = document.createElement("v-frame") as VFrameElement;
      frame.lazyAttributes = true;
      frame.lazyEvents = true;
      frame.preloadScripts = true;
      frame.contentVisibility = "auto";
      frame.src = url;
      document.querySelector("#host")!.append(frame);
      await frame.whenReady();

      const guest = frame.contentWindow! as Window & typeof globalThis;
      const card = guest.document.querySelector("#c1")!;
      card.setAttribute("data-tag", "combo");
      const attr = card.getAttributeNode("data-tag")!;
      let closeCode = 0;
      card.addEventListener("close", (ev) => {
        closeCode = (ev as CloseEvent).code;
      });
      card.dispatchEvent(new guest.CloseEvent("close", { code: 1002 }));

      return {
        attrOwner: attr.ownerDocument === guest.document,
        closeCode,
        cv: guest.getComputedStyle(card).contentVisibility,
      };
    }, `${fixture.origin}/content-vis.html`);

    expect(combined).toEqual({
      attrOwner: true,
      closeCode: 1002,
      cv: "auto",
    });
  });
});
