import { expect, test } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: HTTPFixture;
let cdnFixture: HTTPFixture;

test.beforeAll(async () => {
  cdnFixture = await startHTTPFixture({
    routes: {
      "/public.css": (request) => ({
        type: "text/css",
        headers: {
          "access-control-allow-origin": "*",
          "x-seen-cookie": request.headers.cookie ?? "",
          "x-seen-referer": request.headers.referer ?? "",
        },
        body: `#cdn-target { color: rgb(12, 134, 56); --cookie: "${request.headers.cookie ?? "none"}"; --referer: "${request.headers.referer ?? "none"}"; }`,
      }),
      "/cred.css": (request) => ({
        type: "text/css",
        headers: {
          "access-control-allow-origin": request.headers.origin ?? "*",
          "access-control-allow-credentials": "true",
          vary: "Origin",
        },
        body: `#cred-target { color: rgb(78, 90, 102); }`,
      }),
    },
  });

  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<main id="host"></main>'),
      "/dist/index.js": bundleRoute,
      "/ready.html": htmlDocument("<p id='ok'>Ready</p>"),
      "/missing.html": { status: 404, type: "text/html", body: "missing" },
      "/visibility.html": htmlDocument(`<p id="vis">init</p><script>
        window.__visibilityEvents = [];
        document.addEventListener("visibilitychange", () => {
          window.__visibilityEvents.push({
            hidden: document.hidden,
            state: document.visibilityState,
          });
        });
      </script>`),
      "/shadow-sheet.html":
        htmlDocument(`<div id="wc"></div><p id="doc-target">Doc</p><script>
        const host = document.querySelector("#wc");
        const shadow = host.attachShadow({ mode: "open" });
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(":host { display: block; } p { color: rgb(33, 66, 99); background-image: url('assets/bg.png'); }");
        shadow.adoptedStyleSheets = [sheet];
        const p = document.createElement("p");
        p.id = "inner";
        p.textContent = "Styled";
        shadow.append(p);
        const docSheet = new CSSStyleSheet();
        docSheet.replaceSync("body #doc-target { color: rgb(44, 55, 66); background-image: url('assets/doc.png'); }");
        document.adoptedStyleSheets = [docSheet];
        const docTarget = document.querySelector("#doc-target");
        window.__sheetState = {
          isInstance: sheet instanceof CSSStyleSheet,
          documentAdoptedCount: document.adoptedStyleSheets.length,
          docColor: getComputedStyle(docTarget).color,
          docBg: getComputedStyle(docTarget).backgroundImage,
          bg: getComputedStyle(p).backgroundImage,
          color: getComputedStyle(p).color,
        };
      </script>`),
      "/popover-translate.html": htmlDocument(
        `<button id="open" type="button">Open</button>
         <div id="pop" popover="auto" style="position:fixed;inset:auto;left:10px;top:10px;translate:40px 50px">Pop</div>
         <script>
           const pop = document.querySelector("#pop");
           document.querySelector("#open").onclick = () => pop.showPopover();
         </script>`,
      ),
      "/cdn-styles.html": htmlDocument(
        `<p id="cdn-target">CDN</p><p id="cred-target">Cred</p>`,
        `<link rel="stylesheet" href="${cdnFixture.origin}/public.css" referrerpolicy="no-referrer">
         <link rel="stylesheet" href="${cdnFixture.origin}/cred.css" crossorigin="use-credentials">`,
      ),
      "/scanner.html": `<!doctype html><html><head>
        <!--><style>#abrupt{color:rgb(10,20,30)}</style>
        <script>const s = "<!-- <script></script> -->";</script>
        <style>#after-script{color:rgb(40,50,60)}</style>
      </head><body>
        <svg><style /></svg>
        <p id="abrupt">A</p>
        <p id="after-script">B</p>
        <p id="after-svg" style="color:rgb(70,80,90)">C</p>
      </body></html>`,
      "/malformed-nav.html": htmlDocument(
        `<a id="bad-link" href="http://[">Bad link</a>
         <form id="bad-form" action="http://["><button id="bad-submit" type="submit">Go</button></form>`,
      ),
      "/nested-outer.html": htmlDocument(
        `<h1 id="outer-heading">Outer document</h1>
         <v-frame id="inner-nav" src="/nested-inner-a.html"></v-frame>`,
      ),
      "/nested-inner-a.html": htmlDocument(
        `<h2 id="inner-heading">Inner A</h2>
         <a id="inner-next" href="/nested-inner-b.html">Go to Inner B</a>`,
      ),
      "/nested-inner-b.html": htmlDocument(`<h2 id="inner-heading">Inner B</h2>`),
    },
  });
});

test.afterAll(async () => {
  await fixture.close();
  await cdnFixture.close();
});

test("VFrameElement.whenReady() resolves on load, resolves immediately when ready, and rejects on fatal error or disconnect", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const result = await page.evaluate(async (origin) => {
    const okFrame = document.createElement("v-frame") as VFrameElement;
    okFrame.src = `${origin}/ready.html`;
    const beforeConnect = okFrame.whenReady();
    document.querySelector("#host")!.append(okFrame);
    await beforeConnect;
    const statusAfter = okFrame.status;
    await okFrame.whenReady();

    const badFrame = document.createElement("v-frame") as VFrameElement;
    badFrame.src = `${origin}/missing.html`;
    document.querySelector("#host")!.append(badFrame);
    let badError = "";
    try {
      await badFrame.whenReady();
    } catch (error) {
      badError = (error as Error).name;
    }

    const removedFrame = document.createElement("v-frame") as VFrameElement;
    removedFrame.src = `${origin}/ready.html`;
    const waitRemoved = removedFrame.whenReady();
    document.querySelector("#host")!.append(removedFrame);
    removedFrame.remove();
    let removedError = "";
    try {
      await waitRemoved;
    } catch (error) {
      removedError = (error as Error).name;
    }

    return { statusAfter, badError, removedError };
  }, fixture.origin);

  expect(result).toEqual({
    statusAfter: "ready",
    badError: "TypeError",
    removedError: "AbortError",
  });
});

test("bridges window.CSSStyleSheet for both guest ShadowRoot and document.adoptedStyleSheets", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/shadow-sheet.html`,
  });
  const state = await frame.evaluate(
    (el: VFrameElement) =>
      (
        el.contentWindow as Window & {
          __sheetState?: {
            isInstance: boolean;
            documentAdoptedCount: number;
            docColor: string;
            docBg: string;
            bg: string;
            color: string;
          };
        }
      ).__sheetState,
  );
  expect(state).toEqual({
    isInstance: true,
    documentAdoptedCount: 1,
    docColor: "rgb(44, 55, 66)",
    docBg: `url("${fixture.origin}/assets/doc.png")`,
    bg: `url("${fixture.origin}/assets/bg.png")`,
    color: "rgb(33, 66, 99)",
  });
});

test("mirrors host document.hidden, visibilityState, and visibilitychange into the guest", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, { src: `${fixture.origin}/visibility.html` });
  const initial = await frame.evaluate((el: VFrameElement) => ({
    hidden: el.contentWindow!.document.hidden,
    state: el.contentWindow!.document.visibilityState,
  }));
  expect(initial).toEqual({ hidden: false, state: "visible" });

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  const events = await frame.evaluate(
    (el: VFrameElement) =>
      (
        el.contentWindow as Window & {
          __visibilityEvents?: Array<{ hidden: boolean; state: string }>;
        }
      ).__visibilityEvents,
  );
  expect(events).toEqual([{ hidden: true, state: "hidden" }]);
});

test("popover top-layer rule does not clobber guest translate and cleans up on close", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/popover-translate.html`,
  });
  await frame.locator("#open").click();
  await expect(frame.locator("#pop")).toBeVisible();
  const translateWhenOpen = await frame
    .locator("#pop")
    .evaluate((el) => getComputedStyle(el).translate);
  expect(translateWhenOpen).toBe("40px 50px");
  await frame.locator("#pop").evaluate((el: HTMLElement) => el.hidePopover());
  const topLayerRuleAfterClose = await frame.evaluate((el: VFrameElement) => {
    const sheets = el.shadowRoot.adoptedStyleSheets;
    return sheets.flatMap((s) => Array.from(s.cssRules, (r) => r.cssText));
  });
  expect(
    topLayerRuleAfterClose.some(
      (text) => text.includes("translate:") && !text.includes("translate: ;"),
    ),
  ).toBe(false);
});

test("fetches cross-origin stylesheets with CORS credentials omitted by default and honors crossorigin and referrerpolicy", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/cdn-styles.html`,
    credentials: "include",
  });
  await expect(frame.locator("#cdn-target")).toHaveCSS("color", "rgb(12, 134, 56)");
  await expect(frame.locator("#cred-target")).toHaveCSS("color", "rgb(78, 90, 102)");
  const referer = await frame
    .locator("#cdn-target")
    .evaluate((el) => getComputedStyle(el).getPropertyValue("--referer").trim());
  expect(referer).toBe('"none"');
});

test("neutralizeStyleMarkup handles abrupt comments, script escaped states, and self-closing SVG style", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, { src: `${fixture.origin}/scanner.html` });
  await expect(frame.locator("#abrupt")).toHaveCSS("color", "rgb(10, 20, 30)");
  await expect(frame.locator("#after-script")).toHaveCSS("color", "rgb(40, 50, 60)");
  await expect(frame.locator("#after-svg")).toHaveCSS("color", "rgb(70, 80, 90)");
});

test("ignores malformed link href and form action URLs without throwing uncaught exceptions", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/malformed-nav.html`,
  });
  await frame.locator("#bad-link").click();
  await frame.locator("#bad-submit").click();
  await page.waitForTimeout(50);
  expect(pageErrors).toEqual([]);
});

test("clicking a link inside a nested v-frame navigates only the inner frame without hijacking the outer frame", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const outer = await mountFrame(page, {
    id: "outer-nav",
    src: `${fixture.origin}/nested-outer.html`,
  });
  const inner = outer.locator("v-frame#inner-nav");
  await expect(inner.locator("#inner-heading")).toHaveText("Inner A");

  await inner.locator("#inner-next").click();
  await expect(inner.locator("#inner-heading")).toHaveText("Inner B");
  await expect(outer.locator("#outer-heading")).toHaveText("Outer document");
  expect(
    await outer.evaluate((el: VFrameElement) => ({
      outerURL: el.currentURL,
      innerURL: el.shadowRoot.querySelector<VFrameElement>("#inner-nav")?.currentURL,
    })),
  ).toEqual({
    outerURL: `${fixture.origin}/nested-outer.html`,
    innerURL: `${fixture.origin}/nested-inner-b.html`,
  });
});
