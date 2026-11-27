import { expect, test, type Locator } from "@playwright/test";
import {
  bundleRoute,
  htmlDocument as html,
  type HTTPFixture,
  type Route,
  startHTTPFixture,
} from "./support/http-fixture";
import { frameFailures, mountFrame } from "./support/mount-frame";

const nonce = "sec-audit-nonce";
const csp = `script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; object-src 'none'`;
const trustedTypesCSP = `${csp}; trusted-types v-frame-test guest-safe; require-trusted-types-for 'script'`;

interface RecordedRequest {
  method: string;
  pathname: string;
  referer: string | undefined;
}

let fixture: HTTPFixture<RecordedRequest>;
let crossOriginFixture: HTTPFixture<RecordedRequest>;

function javascript(body: string): Route {
  return { type: "text/javascript", body };
}

function stylesheet(body: string, extraHeaders: Record<string, string> = {}): Route {
  return { type: "text/css", body, headers: extraHeaders };
}

const hostPage = html(
  '<div id="host"></div><script type="module" nonce="sec-audit-nonce">import { defineVFrame } from "/dist/index.js"; defineVFrame();</script>',
);

async function childValue<T>(
  frame: Locator,
  expression: (window: Window & typeof globalThis) => T,
): Promise<T> {
  return frame.evaluate((element, source) => {
    const evaluate = new Function("window", `return (${source})(window)`);
    return evaluate(
      (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
        .contentWindow,
    );
  }, expression.toString()) as Promise<T>;
}

test.beforeAll(async () => {
  crossOriginFixture = await startHTTPFixture<RecordedRequest>({
    record: (req) => ({
      method: req.method ?? "GET",
      pathname: new URL(req.url ?? "/", "http://fixture.test").pathname,
      referer: req.headers.referer,
    }),
    routes: {
      "/submit-target": {
        body: html("<p id='xorigin-submitted'>xorigin</p>"),
        headers: { "access-control-allow-origin": "*" },
      },
    },
  });

  fixture = await startHTTPFixture<RecordedRequest>({
    record: (req) => ({
      method: req.method ?? "GET",
      pathname: new URL(req.url ?? "/", "http://fixture.test").pathname,
      referer: req.headers.referer,
    }),
    routes: {
      "/": { body: hostPage, headers: { "content-security-policy": csp } },
      "/trusted-types": {
        body: hostPage,
        headers: { "content-security-policy": trustedTypesCSP },
      },
      "/plain": hostPage,
      "/ssr-preview-host": () => ({
        body: html(
          `<div id="host">` +
            `<v-frame id="ssr-embed" adopt="interaction" src="${fixture.origin}/documents/ssr-embed.html">` +
            `<template shadowrootmode="open" shadowrootserializable><v-html><v-head></v-head><v-body>` +
            `<iframe id="deferred-iframe" data-v-frame-preview-attributes="[&quot;srcdoc&quot;]" data-v-frame-preview-attributes-0="&lt;p id='loaded'&gt;iframe-live&lt;/p&gt;"></iframe>` +
            `</v-body></v-html></template></v-frame></div>` +
            `<script type="module" nonce="sec-audit-nonce">import { defineVFrame } from "/dist/index.js"; defineVFrame();</script>`,
        ),
      }),
      "/dist/index.js": bundleRoute,
      "/documents/shadow-dom-csp.html": html(
        `<div id="shadow-host"></div><div id="shadow-host-inner"></div><div id="dsd-host"></div>`,
      ),
      "/documents/bang-comment-csp.html": html(
        '<!-- comment --!><style id="after-bang-style">#after-bang-target{color:rgb(12,123,234)}</style><p id="after-bang-target" style="font-weight:700">Bang</p>',
      ),
      "/documents/set-attr-node-tt.html": html(
        `<button id="btn-node">Node</button>
         <button id="btn-node-ns">NodeNS</button>
         <script>
           const a1 = document.createAttribute("onclick");
           a1.value = "window.__nodeRan = true";
           try {
             document.querySelector("#btn-node").setAttributeNode(a1);
             window.__nodeRejected = false;
           } catch (err) {
             window.__nodeRejected = err instanceof TypeError;
           }
           const a2 = document.createAttributeNS(null, "onclick");
           a2.value = "window.__nodeNSRan = true";
           try {
             document.querySelector("#btn-node-ns").setAttributeNodeNS(a2);
             window.__nodeNSRejected = false;
           } catch (err) {
             window.__nodeNSRejected = err instanceof TypeError;
           }
         </script>`,
      ),
      "/documents/forged-sri.html": html(
        '<p id="target">Hello</p>',
        '<link rel="stylesheet" href="/styles/real.css" integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=">' +
          '<style data-v-frame-linked="" data-v-frame-integrity="sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=">#target{color:rgb(222,11,22)}</style>',
      ),
      "/styles/real.css": stylesheet("#target { color: rgb(10, 20, 30); }"),
      "/documents/trusted-types-attr.html": html(
        `<button id="btn-raw">Raw</button>
         <button id="btn-raw-ns">RawNS</button>
         <button id="btn-trusted">Trusted</button>
         <script>
           const btnRaw = document.querySelector("#btn-raw");
           try {
             btnRaw.setAttribute("onclick", "window.__rawRan = true");
             window.__rawAttrRejected = false;
           } catch (err) {
             window.__rawAttrRejected = err instanceof TypeError;
           }
           const btnRawNS = document.querySelector("#btn-raw-ns");
           try {
             btnRawNS.setAttributeNS(null, "onclick", "window.__rawNSRan = true");
             window.__rawNSAttrRejected = false;
           } catch (err) {
             window.__rawNSAttrRejected = err instanceof TypeError;
           }
           const guestPolicy = window.trustedTypes.createPolicy("guest-safe", {
             createScript: (s) => s,
           });
           const btnTrusted = document.querySelector("#btn-trusted");
           btnTrusted.setAttribute("onclick", guestPolicy.createScript("window.__trustedRan = true"));
         </script>`,
      ),
      "/documents/preload-creds.html": html(
        '<p id="ready">ok</p>',
        '<script defer src="/scripts/deferred.js"></script><script type="module" src="/scripts/mod.js"></script>',
      ),
      "/scripts/deferred.js": javascript("window.__deferredRan = true;"),
      "/scripts/mod.js": javascript("window.__modRan = true;"),
      "/documents/forms.html": () => ({
        body: html(`
          <form id="same-origin-form" method="get" action="/documents/submitted.html">
            <input name="q" value="ok">
            <button id="submit-same" type="submit">Same</button>
          </form>
          <form id="cross-origin-form" method="post" action="${crossOriginFixture.origin}/submit-target">
            <input name="secret" value="1">
            <button id="submit-cross" type="submit">Cross</button>
          </form>
          <form id="blank-form" method="get" target="_blank" action="${crossOriginFixture.origin}/submit-target">
            <button id="submit-blank" type="submit">Blank</button>
          </form>
        `),
      }),
      "/documents/submitted.html": html('<p id="submitted-ok">Submitted OK</p>'),
      "/documents/link-policy.html": html(
        '<p id="styled">Styled</p>',
        '<link id="dyn-link" rel="stylesheet" href="/styles/policy-a.css">',
      ),
      "/styles/policy-a.css": stylesheet("#styled { color: rgb(12, 34, 56); }"),
      "/documents/referrer-links.html": html(`
        <a id="no-ref-link" href="/documents/referrer-target.html" referrerpolicy="no-referrer">NoRef</a>
        <a id="noreferrer-link" href="/documents/referrer-target.html" rel="noreferrer">NoReferrer</a>
        <a id="blank-noreferrer" href="/documents/referrer-target.html" target="_blank" rel="noreferrer">BlankNoRef</a>
      `),
      "/documents/referrer-target.html": html('<p id="arrived">Arrived</p>'),
      "/documents/popup-schemes.html": html('<p id="popup-host">Popup test</p>'),
    },
  });
});

test.afterAll(async () => {
  await fixture.close();
  await crossOriginFixture.close();
});

test("H1: ShadowRoot.setHTMLUnsafe and ShadowRoot.innerHTML do not inherit host CSP nonce", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);

  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/shadow-dom-csp.html`,
    nonce,
  });

  const capabilities = await childValue(frame, (win) => {
    const host1 = win.document.querySelector("#shadow-host")!;
    const sr1 = host1.attachShadow({ mode: "open" });
    const hasSetHTMLUnsafe =
      typeof (sr1 as ShadowRoot & { setHTMLUnsafe?: unknown }).setHTMLUnsafe ===
      "function";
    if (hasSetHTMLUnsafe) {
      (sr1 as ShadowRoot & { setHTMLUnsafe(html: string): void }).setHTMLUnsafe(
        '<style id="sr-style">#sr-p{color:rgb(222,11,22)}</style>' +
          '<p id="sr-p">shadow</p>' +
          '<button id="sr-btn" onclick="window.__srUnsafeRan = true">Click</button>',
      );
      (sr1.querySelector("#sr-btn") as HTMLButtonElement | null)?.click();
    }

    const host2 = win.document.querySelector("#shadow-host-inner")!;
    const sr2 = host2.attachShadow({ mode: "open" });
    sr2.innerHTML =
      '<style id="sr2-style">#sr2-p{color:rgb(222,11,22)}</style>' +
      '<p id="sr2-p">shadow2</p>' +
      '<button id="sr2-btn" onclick="window.__srInnerRan = true">Click2</button>';
    (sr2.querySelector("#sr2-btn") as HTMLButtonElement | null)?.click();

    const dsdHost = win.document.querySelector("#dsd-host") as HTMLElement & {
      setHTMLUnsafe?(html: string): void;
    };
    const hasElemSetHTMLUnsafe = typeof dsdHost.setHTMLUnsafe === "function";
    if (hasElemSetHTMLUnsafe) {
      dsdHost.setHTMLUnsafe!(
        '<div id="dsd-inner"><template shadowrootmode="open">' +
          '<button id="dsd-btn" onclick="window.__dsdRan = true">DSD</button>' +
          "</template></div>",
      );
      const dsdBtn = dsdHost
        .querySelector("#dsd-inner")
        ?.shadowRoot?.querySelector("#dsd-btn") as HTMLButtonElement | null;
      dsdBtn?.click();
    }

    const w = win as typeof win & {
      __srUnsafeRan?: boolean;
      __srInnerRan?: boolean;
      __dsdRan?: boolean;
    };
    return {
      hasSetHTMLUnsafe,
      srStyleNonce:
        (sr1.querySelector("#sr-style") as HTMLStyleElement | null)?.nonce ?? "",
      sr2StyleNonce:
        (sr2.querySelector("#sr2-style") as HTMLStyleElement | null)?.nonce ?? "",
      srUnsafeRan: Boolean(w.__srUnsafeRan),
      srInnerRan: Boolean(w.__srInnerRan),
      dsdRan: Boolean(w.__dsdRan),
    };
  });

  expect(capabilities.srUnsafeRan).toBe(false);
  expect(capabilities.srInnerRan).toBe(false);
  expect(capabilities.dsdRan).toBe(false);
  expect(capabilities.srStyleNonce).toBe("");
  expect(capabilities.sr2StyleNonce).toBe("");
});

test("M2: client-fetched document cannot spoof SSR linked-style markers to bypass SRI", async ({
  page,
}) => {
  await page.goto(`${fixture.origin}/plain`);
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);

  fixture.requests.length = 0;
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/forged-sri.html`,
  });

  // The forged <style data-v-frame-linked data-v-frame-integrity> MUST NOT satisfy
  // the <link>'s SRI check: the <link> must still fetch /styles/real.css, fail SRI,
  // leave link.sheet null, and strip the forged SSR markers.
  expect(fixture.requests.some((r) => r.pathname === "/styles/real.css")).toBe(true);
  await expect(frame.locator("#target")).not.toHaveCSS("color", "rgb(10, 20, 30)");
  const domState = await childValue(frame, (win) => {
    const link = win.document.querySelector("link") as HTMLLinkElement | null;
    const forgedStyle = win.document.querySelector("style");
    return {
      hasLink: link !== null,
      linkSheetIsNull: link?.sheet === null,
      hasForgedLinkedMarker: forgedStyle?.hasAttribute("data-v-frame-linked") ?? false,
      hasForgedIntegrityMarker:
        forgedStyle?.hasAttribute("data-v-frame-integrity") ?? false,
    };
  });
  expect(domState).toEqual({
    hasLink: true,
    linkSheetIsNull: true,
    hasForgedLinkedMarker: false,
    hasForgedIntegrityMarker: false,
  });
  const failures = await frameFailures(frame);
  expect(
    failures.some((f) => f.phase === "stylesheet" && f.url.endsWith("/styles/real.css")),
  ).toBe(true);
});

test("M3: imperative setAttribute('onclick', raw) enforces native Trusted Types in named-policy mode", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "chromium", "Trusted Types enforcement is unavailable");
  await page.goto(`${fixture.origin}/trusted-types`);
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);

  const frame = page.locator("v-frame");
  await page.evaluate(
    ({ frameNonce, source }) => {
      const element = document.createElement("v-frame") as HTMLElement & {
        nonce: string;
        src: string;
        trustedTypesPolicy: string;
      };
      element.nonce = frameNonce;
      element.trustedTypesPolicy = "v-frame-test";
      element.src = source;
      document.querySelector("#host")?.append(element);
    },
    { frameNonce: nonce, source: `${fixture.origin}/documents/trusted-types-attr.html` },
  );

  await expect
    .poll(() => frame.evaluate((el: HTMLElement & { status: string }) => el.status))
    .toBe("ready");

  await frame.locator("#btn-raw").click();
  await frame.locator("#btn-raw-ns").click();
  await frame.locator("#btn-trusted").click();

  expect(
    await childValue(frame, (win) => {
      const w = win as typeof win & {
        __rawAttrRejected?: boolean;
        __rawNSAttrRejected?: boolean;
        __rawRan?: boolean;
        __rawNSRan?: boolean;
        __trustedRan?: boolean;
      };
      return {
        rawAttrRejected: w.__rawAttrRejected,
        rawNSAttrRejected: w.__rawNSAttrRejected,
        rawRan: Boolean(w.__rawRan),
        rawNSRan: Boolean(w.__rawNSRan),
        trustedRan: Boolean(w.__trustedRan),
      };
    }),
  ).toEqual({
    rawAttrRejected: true,
    rawNSAttrRejected: true,
    rawRan: false,
    rawNSRan: false,
    trustedRan: true,
  });
});

test("M4: deferred SSR preview keeps iframe srcdoc inert until activate() restores it", async ({
  page,
}) => {
  await page.goto(`${fixture.origin}/ssr-preview-host`);
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);

  const beforeAndAfter = await page.evaluate(async () => {
    const frame = document.querySelector("#ssr-embed") as HTMLElement & {
      activate(): Promise<void>;
      shadowRoot: ShadowRoot;
    };
    const previewIframe = frame.shadowRoot.querySelector(
      "#deferred-iframe",
    ) as HTMLIFrameElement;
    const beforeHasSrcdoc = previewIframe.hasAttribute("srcdoc");
    await frame.activate();
    const liveIframe = frame.shadowRoot.querySelector(
      "#deferred-iframe",
    ) as HTMLIFrameElement;
    const afterSrcdoc = liveIframe.getAttribute("srcdoc");
    return { beforeHasSrcdoc, afterSrcdoc };
  });

  expect(beforeAndAfter.beforeHasSrcdoc).toBe(false);
  expect(beforeAndAfter.afterSrcdoc).toBe("<p id='loaded'>iframe-live</p>");
});

test("M5: form-action attribute and formActionPolicy enforce virtual form submission targets", async ({
  page,
}) => {
  await page.goto(`${fixture.origin}/plain`);
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);

  crossOriginFixture.requests.length = 0;

  // Mount frame with form-action="'self'"
  await page.evaluate(
    ({ src }) => {
      const frame = document.createElement("v-frame") as HTMLElement & {
        src: string;
        __errors: Array<{ phase: string; name: string; url: string; fatal: boolean }>;
      };
      frame.id = "form-frame";
      frame.setAttribute("form-action", "'self'");
      frame.__errors = [];
      frame.addEventListener("v-frame-error", (event) => {
        const detail = (
          event as CustomEvent<{
            phase: string;
            error: Error;
            url: string;
            fatal: boolean;
          }>
        ).detail;
        frame.__errors.push({
          phase: detail.phase,
          name: detail.error.name,
          url: detail.url,
          fatal: detail.fatal,
        });
      });
      frame.src = src;
      document.querySelector("#host")?.append(frame);
    },
    { src: `${fixture.origin}/documents/forms.html` },
  );

  const frame = page.locator("v-frame#form-frame");
  await expect
    .poll(() => frame.evaluate((el: HTMLElement & { status: string }) => el.status))
    .toBe("ready");

  // Cross-origin POST and cross-origin _blank should both be blocked.
  await frame.locator("#submit-cross").click();
  await frame.locator("#submit-blank").click();

  await expect
    .poll(() =>
      frame.evaluate(
        (el: HTMLElement & { __errors: Array<{ name: string }> }) => el.__errors.length,
      ),
    )
    .toBe(2);

  const errors = await frame.evaluate(
    (
      el: HTMLElement & {
        __errors: Array<{ phase: string; name: string; url: string; fatal: boolean }>;
      },
    ) => el.__errors,
  );
  expect(
    errors.every(
      (e) => e.phase === "navigation" && e.name === "SecurityError" && !e.fatal,
    ),
  ).toBe(true);
  expect(crossOriginFixture.requests).toHaveLength(0);

  // Predicate override can deny even same-origin forms.
  await frame.evaluate((el: HTMLElement & { formActionPolicy: unknown }) => {
    el.formActionPolicy = () => false;
  });
  await frame.locator("#submit-same").click();
  await expect
    .poll(() =>
      frame.evaluate(
        (el: HTMLElement & { __errors: Array<{ name: string }> }) => el.__errors.length,
      ),
    )
    .toBe(3);

  // Restoring "'self'" policy allows same-origin GET submission.
  await frame.evaluate((el: HTMLElement & { formActionPolicy: unknown }) => {
    el.formActionPolicy = "'self'";
  });
  await frame.locator("#submit-same").click();
  await expect(frame.locator("#submitted-ok")).toHaveText("Submitted OK");
});

test("M6: credentials='omit' never emits host preload links that default to same-origin credentials", async ({
  page,
}) => {
  await page.goto(`${fixture.origin}/plain`);
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);

  const observed = await page.evaluate(async (origin) => {
    const preloadsAdded: Array<{
      frame: string;
      href: string;
      crossOrigin: string | null;
    }> = [];
    let currentLabel = "omit";
    const observer = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (
            node instanceof HTMLLinkElement &&
            (node.rel === "preload" || node.rel === "modulepreload")
          ) {
            preloadsAdded.push({
              frame: currentLabel,
              href: node.href,
              crossOrigin: node.getAttribute("crossorigin"),
            });
          }
        }
      }
    });
    observer.observe(document.head, { childList: true });

    const runOne = async (label: string, credentials: string) => {
      currentLabel = label;
      const frame = document.createElement("v-frame") as HTMLElement & { src: string };
      frame.setAttribute("credentials", credentials);
      frame.setAttribute("preload-scripts", "/scripts/deferred.js");
      const loaded = new Promise<void>((r) =>
        frame.addEventListener("v-frame-load", () => r(), { once: true }),
      );
      frame.src = `${origin}/documents/preload-creds.html`;
      document.querySelector("#host")?.append(frame);
      await loaded;
      frame.remove();
    };

    await runOne("omit", "omit");
    await runOne("same-origin", "same-origin");
    observer.disconnect();
    return preloadsAdded;
  }, fixture.origin);

  expect(observed.filter((p) => p.frame === "omit")).toEqual([]);
  expect(observed.filter((p) => p.frame === "same-origin").length).toBeGreaterThan(0);
});

test("L2: mutating link referrerpolicy or crossorigin refetches stylesheet with updated policy", async ({
  page,
}) => {
  await page.goto(`${fixture.origin}/plain`);
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);

  fixture.requests.length = 0;
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/link-policy.html`,
  });
  await expect(frame.locator("#styled")).toHaveCSS("color", "rgb(12, 34, 56)");

  const initialCount = fixture.requests.filter(
    (r) => r.pathname === "/styles/policy-a.css",
  ).length;
  expect(initialCount).toBe(1);

  await childValue(frame, (win) => {
    const link = win.document.querySelector("#dyn-link") as HTMLLinkElement;
    link.setAttribute("referrerpolicy", "no-referrer");
  });

  await expect
    .poll(
      () => fixture.requests.filter((r) => r.pathname === "/styles/policy-a.css").length,
    )
    .toBe(2);
  const second = fixture.requests.filter(
    (r) => r.pathname === "/styles/policy-a.css",
  )[1]!;
  expect(second.referer).toBeUndefined();

  await childValue(frame, (win) => {
    const link = win.document.querySelector("#dyn-link") as HTMLLinkElement;
    link.setAttribute("crossorigin", "anonymous");
  });

  await expect
    .poll(
      () => fixture.requests.filter((r) => r.pathname === "/styles/policy-a.css").length,
    )
    .toBe(3);
});

test("L3: referrerpolicy='no-referrer' and rel='noreferrer' propagate on fetches and popups", async ({
  page,
}) => {
  await page.goto(`${fixture.origin}/plain`);
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);

  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/referrer-links.html`,
  });

  // Clicking <a target="_blank" rel="noreferrer"> opens a real popup with no opener and no Referer header.
  fixture.requests.length = 0;
  const popupPromise = page.waitForEvent("popup");
  await frame.locator("#blank-noreferrer").click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  const popupReq = fixture.requests.find(
    (r) => r.pathname === "/documents/referrer-target.html",
  );
  expect(popupReq).toBeDefined();
  expect(popupReq?.referer).toBeUndefined();
  await popup.close();

  // Click referrerpolicy="no-referrer" link -> guest document fetch omits Referer header.
  fixture.requests.length = 0;
  await frame.locator("#no-ref-link").click();
  await expect(frame.locator("#arrived")).toHaveText("Arrived");
  const refReq = fixture.requests.find(
    (r) => r.pathname === "/documents/referrer-target.html",
  );
  expect(refReq?.referer).toBeUndefined();

  // Navigate back via history and test rel="noreferrer" link.
  await frame.evaluate((el: HTMLElement & { back(): Promise<void> }) => el.back());
  await expect(frame.locator("#noreferrer-link")).toBeVisible();
  fixture.requests.length = 0;
  await frame.locator("#noreferrer-link").click();
  await expect(frame.locator("#arrived")).toHaveText("Arrived");
  const norefReq = fixture.requests.find(
    (r) => r.pathname === "/documents/referrer-target.html",
  );
  expect(norefReq?.referer).toBeUndefined();
});

test("Hardening #4: window.open(_blank) blocks non-HTTP schemes while still notifying v-frame-navigate", async ({
  page,
}) => {
  await page.goto(`${fixture.origin}/plain`);
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);

  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/popup-schemes.html`,
  });

  const popups: string[] = [];
  page.on("popup", async (popup) => {
    popups.push(popup.url());
    await popup.close().catch(() => {});
  });

  await page.evaluate(() => {
    const win = window as typeof window & { __navEvents?: string[] };
    win.__navEvents = [];
    document.querySelector("v-frame")?.addEventListener("v-frame-navigate", (event) => {
      win.__navEvents!.push((event as CustomEvent<{ to: string }>).detail.to);
    });
  });

  // Non-HTTP schemes must NOT open popups and must return null.
  const blockedResults = await childValue(frame, (win) => ({
    js: win.open("javascript:alert(1)", "_blank") === null,
    data: win.open("data:text/html,<p>x</p>", "_blank") === null,
  }));
  expect(blockedResults).toEqual({ js: true, data: true });
  expect(popups).toEqual([]);

  // Explicit HTTP(S) URL opens a popup natively with noopener.
  const popupPromise = page.waitForEvent("popup");
  await frame.evaluate((element, url) => {
    const win = (element as HTMLElement & { contentWindow: Window }).contentWindow;
    win.open(url, "_blank");
  }, `${fixture.origin}/documents/referrer-target.html`);
  const httpPopup = await popupPromise;
  await httpPopup.waitForLoadState("domcontentloaded").catch(() => {});
  await httpPopup.close().catch(() => {});

  const navEvents = await page.evaluate(
    () => (window as typeof window & { __navEvents?: string[] }).__navEvents ?? [],
  );
  expect(navEvents).toEqual([
    "javascript:alert(1)",
    "data:text/html,<p>x</p>",
    `${fixture.origin}/documents/referrer-target.html`,
  ]);
});

test("CSP nonce allowlist blocks Range, DOMParser, parseHTMLUnsafe, and createHTMLDocument while allowing createElement/createElementNS", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);

  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/shadow-dom-csp.html`,
    nonce,
  });

  const result = await childValue(frame, (win) => {
    const w = win as typeof win & {
      __rangeRan?: boolean;
      __parserRan?: boolean;
      __unsafeRan?: boolean;
      __implRan?: boolean;
      __cloneParsedOverRan?: boolean;
      __cloneImpClickRan?: boolean;
    };

    // 1. Range.createContextualFragment
    const range = win.document.createRange();
    range.selectNodeContents(win.document.body);
    const frag = range.createContextualFragment(
      '<style id="s-range">#t-range{color:rgb(222,11,22)}</style>' +
        '<p id="t-range">r</p>' +
        '<button id="b-range" onclick="window.__rangeRan = true">r</button>',
    );
    win.document.body.append(frag);
    (win.document.querySelector("#b-range") as HTMLButtonElement).click();

    // 2. DOMParser.parseFromString
    const parsedDoc = new win.DOMParser().parseFromString(
      '<style id="s-parser">#t-parser{color:rgb(222,11,22)}</style>' +
        '<p id="t-parser">p</p>' +
        '<button id="b-parser" onclick="window.__parserRan = true">p</button>',
      "text/html",
    );
    win.document.body.append(...Array.from(parsedDoc.head.childNodes));
    win.document.body.append(...Array.from(parsedDoc.body.childNodes));
    (win.document.querySelector("#b-parser") as HTMLButtonElement).click();

    // 3. Document.parseHTMLUnsafe (when available)
    const DocCtor = win.Document as typeof Document & {
      parseHTMLUnsafe?: (html: string) => Document;
    };
    let unsafeStyleNonce = "";
    if (typeof DocCtor.parseHTMLUnsafe === "function") {
      const unsafeDoc = DocCtor.parseHTMLUnsafe(
        '<style id="s-unsafe">#t-unsafe{color:rgb(222,11,22)}</style>' +
          '<button id="b-unsafe" onclick="window.__unsafeRan = true">u</button>',
      );
      win.document.body.append(...Array.from(unsafeDoc.head.childNodes));
      win.document.body.append(...Array.from(unsafeDoc.body.childNodes));
      (win.document.querySelector("#b-unsafe") as HTMLButtonElement).click();
      unsafeStyleNonce =
        (win.document.querySelector("#s-unsafe") as HTMLStyleElement | null)?.nonce ?? "";
    }

    // 4. document.implementation.createHTMLDocument()
    const implDoc = win.document.implementation.createHTMLDocument("");
    implDoc.body.innerHTML =
      '<style id="s-impl">#t-impl{color:rgb(222,11,22)}</style>' +
      '<button id="b-impl" onclick="window.__implRan = true">i</button>';
    win.document.body.append(...Array.from(implDoc.body.childNodes));
    (win.document.querySelector("#b-impl") as HTMLButtonElement).click();

    // 5. Imperative overwrite of one event attribute on a parsed node does NOT upgrade another parsed event attribute on clone.
    const box = win.document.createElement("div");
    box.innerHTML =
      '<button id="mixed" onclick="window.__parsedClick = true" onmouseover="window.__cloneParsedOverRan = true">M</button>';
    const mixed = box.querySelector("#mixed") as HTMLButtonElement;
    mixed.setAttribute("onclick", "window.__cloneImpClickRan = true");
    const cloned = mixed.cloneNode(true) as HTMLButtonElement;
    win.document.body.append(cloned);
    cloned.click();
    cloned.dispatchEvent(new win.MouseEvent("mouseover", { bubbles: true }));

    // 6. Legitimate createElement("style") and createElementNS(HTML, "style") DO receive the host nonce.
    const s1 = win.document.createElement("style");
    s1.textContent = "#ok-el{color:rgb(11,22,33)}";
    const s2 = win.document.createElementNS("http://www.w3.org/1999/xhtml", "style");
    s2.textContent = "#ok-ns{color:rgb(44,55,66)}";
    const p1 = win.document.createElement("p");
    p1.id = "ok-el";
    const p2 = win.document.createElement("p");
    p2.id = "ok-ns";
    win.document.head.append(s1, s2);
    win.document.body.append(p1, p2);

    return {
      rangeNonce:
        (win.document.querySelector("#s-range") as HTMLStyleElement | null)?.nonce ?? "",
      parserNonce:
        (win.document.querySelector("#s-parser") as HTMLStyleElement | null)?.nonce ?? "",
      unsafeStyleNonce,
      implNonce:
        (win.document.querySelector("#s-impl") as HTMLStyleElement | null)?.nonce ?? "",
      rangeRan: Boolean(w.__rangeRan),
      parserRan: Boolean(w.__parserRan),
      unsafeRan: Boolean(w.__unsafeRan),
      implRan: Boolean(w.__implRan),
      cloneParsedOverRan: Boolean(w.__cloneParsedOverRan),
      cloneImpClickRan: Boolean(w.__cloneImpClickRan),
      okElNonce: s1.nonce,
      okNsNonce: s2.nonce,
    };
  });

  expect(result).toEqual({
    rangeNonce: "",
    parserNonce: "",
    unsafeStyleNonce: "",
    implNonce: "",
    rangeRan: false,
    parserRan: false,
    unsafeRan: false,
    implRan: false,
    cloneParsedOverRan: false,
    cloneImpClickRan: true,
    okElNonce: nonce,
    okNsNonce: nonce,
  });
  await expect(frame.locator("#ok-el")).toHaveCSS("color", "rgb(11, 22, 33)");
  await expect(frame.locator("#ok-ns")).toHaveCSS("color", "rgb(44, 55, 66)");
  await expect(frame.locator("#t-range")).not.toHaveCSS("color", "rgb(222, 11, 22)");
  await expect(frame.locator("#t-parser")).not.toHaveCSS("color", "rgb(222, 11, 22)");
});

test("setAttributeNode and setAttributeNodeNS intercept managed URL, style, and event attributes", async ({
  browserName,
  page,
}) => {
  await page.goto(fixture.origin);
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);

  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/shadow-dom-csp.html`,
    nonce,
  });

  const attrResult = await childValue(frame, (win) => {
    const a = win.document.createElement("a");
    a.id = "attr-node-link";
    const hrefAttr = win.document.createAttribute("href");
    hrefAttr.value = "relative/page.html";
    a.setAttributeNode(hrefAttr);
    win.document.body.append(a);
    const authoredHref = a.getAttribute("href");
    const resolvedHref = a.href;
    const removedHref = a.removeAttributeNode(a.getAttributeNode("href")!);
    const afterRemoveHref = a.getAttribute("href");

    const styled = win.document.createElement("p");
    styled.id = "attr-node-styled";
    const styleAttr = win.document.createAttribute("style");
    styleAttr.value = "color: rgb(33, 66, 99)";
    styled.setAttributeNode(styleAttr);
    win.document.body.append(styled);

    return {
      authoredHref,
      resolvedHref,
      removedName: removedHref.name,
      afterRemoveHref,
      styledAuthored: styled.getAttribute("style"),
      styledComputed: win.getComputedStyle(styled).color,
    };
  });
  const physicalStyleOnHost = await frame.evaluate((el) =>
    Element.prototype.getAttribute.call(
      el.shadowRoot!.querySelector("#attr-node-styled")!,
      "style",
    ),
  );

  expect(attrResult).toEqual({
    authoredHref: "relative/page.html",
    resolvedHref: `${fixture.origin}/documents/relative/page.html`,
    removedName: "href",
    afterRemoveHref: null,
    styledAuthored: "color: rgb(33, 66, 99)",
    styledComputed: "rgb(33, 66, 99)",
  });
  expect(physicalStyleOnHost).toBeNull();

  if (browserName === "chromium") {
    await page.goto(`${fixture.origin}/trusted-types`);
    await expect
      .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
      .toBe(true);

    const ttFrame = page.locator("v-frame");
    await page.evaluate(
      ({ frameNonce, source }) => {
        const el = document.createElement("v-frame") as HTMLElement & {
          nonce: string;
          src: string;
          trustedTypesPolicy: string;
        };
        el.nonce = frameNonce;
        el.trustedTypesPolicy = "v-frame-test";
        el.src = source;
        document.querySelector("#host")?.append(el);
      },
      { frameNonce: nonce, source: `${fixture.origin}/documents/set-attr-node-tt.html` },
    );
    await expect
      .poll(() => ttFrame.evaluate((el: HTMLElement & { status: string }) => el.status))
      .toBe("ready");
    await ttFrame.locator("#btn-node").click();
    await ttFrame.locator("#btn-node-ns").click();
    expect(
      await childValue(ttFrame, (win) => {
        const w = win as typeof win & {
          __nodeRejected?: boolean;
          __nodeNSRejected?: boolean;
          __nodeRan?: boolean;
          __nodeNSRan?: boolean;
        };
        return {
          nodeRejected: w.__nodeRejected,
          nodeNSRejected: w.__nodeNSRejected,
          nodeRan: Boolean(w.__nodeRan),
          nodeNSRan: Boolean(w.__nodeNSRan),
        };
      }),
    ).toEqual({
      nodeRejected: true,
      nodeNSRejected: true,
      nodeRan: false,
      nodeNSRan: false,
    });
  }
});

test("client style neutralization recognizes --!> comment closing under strict style-src CSP", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);

  await page.evaluate(() => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(event.violatedDirective);
    });
    (window as typeof window & { __bangViolations?: string[] }).__bangViolations =
      violations;
  });

  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/bang-comment-csp.html`,
    nonce,
  });

  await expect(frame.locator("#after-bang-target")).toHaveCSS(
    "color",
    "rgb(12, 123, 234)",
  );
  await expect(frame.locator("#after-bang-target")).toHaveCSS("font-weight", "700");
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { __bangViolations?: string[] }).__bangViolations ??
        [],
    ),
  ).toEqual([]);
});
