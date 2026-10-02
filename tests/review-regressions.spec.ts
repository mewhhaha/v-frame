import { expect, test, type Page, type Locator } from "@playwright/test";
import type { VFrameElement } from "../src/index.js";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: HTTPFixture;

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/first": htmlDocument(
        '<a id="next" href="/second">Next</a><div id="target">First</div>',
      ),
      "/second": htmlDocument('<div id="target">Second</div>'),
      "/linked": htmlDocument(
        '<p id="target">Styled</p>',
        '<link id="theme" rel="stylesheet" href="/old/theme.css">',
      ),
      "/old/theme.css": { status: 302, headers: { location: "/new/theme.css" } },
      "/new/theme.css": {
        type: "text/css",
        body: '@import "nested.css"; #target { background-image: url("asset.svg"); }',
      },
      "/new/nested.css": {
        type: "text/css",
        body: "#target { color: rgb(11, 22, 33); }",
      },
      "/blue.css": { type: "text/css", body: "#target { color: rgb(44, 55, 66); }" },
      "/new/asset.svg": {
        type: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      },
    },
  });
});

test.afterAll(async () => fixture.close());

async function mounted(page: Page, route = "/first"): Promise<Locator> {
  await installBundle(page, fixture.origin);
  return mountFrame(page, { src: `${fixture.origin}${route}` });
}

async function atSecondDocument(page: Page): Promise<Locator> {
  const frame = await mounted(page);
  await frame.locator("#next").click();
  await expect(frame.locator("#target")).toHaveText("Second");
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  return frame;
}

test("cross-document traversal settles after the replacement guest activates", async ({
  page,
}) => {
  const frame = await atSecondDocument(page);
  const result = await frame.evaluate(async (element: VFrameElement) => {
    let navigated = 0;
    element.addEventListener("v-frame-navigated", () => navigated++);
    const snapshot = () => ({
      text: element.contentWindow?.document.querySelector("#target")?.textContent,
      path: new URL(element.currentURL!).pathname,
      status: element.status,
      back: element.canGoBack,
      forward: element.canGoForward,
      navigated,
    });
    await element.back();
    const back = snapshot();
    await element.forward();
    return { back, forward: snapshot() };
  });
  expect(result).toEqual({
    back: {
      text: "First",
      path: "/first",
      status: "ready",
      back: false,
      forward: true,
      navigated: 1,
    },
    forward: {
      text: "Second",
      path: "/second",
      status: "ready",
      back: true,
      forward: false,
      navigated: 2,
    },
  });
});

test("failed document traversal rejects and preserves the active history entry", async ({
  page,
}) => {
  const frame = await atSecondDocument(page);
  await page.route(`${fixture.origin}/first`, (route) =>
    route.fulfill({ status: 503, body: "Unavailable" }),
  );
  const result = await frame.evaluate(async (element: VFrameElement) => {
    let error = "";
    try {
      await element.back();
    } catch (cause) {
      error = (cause as Error).message;
    }
    return {
      error,
      url: element.currentURL,
      status: element.status,
      text: element.contentWindow?.document.querySelector("#target")?.textContent,
      back: element.canGoBack,
    };
  });
  expect(result.error).toContain("503");
  expect(result).toMatchObject({
    url: `${fixture.origin}/second`,
    status: "ready",
    text: "Second",
    back: true,
  });
});

test("disconnecting an in-flight document traversal rejects with AbortError", async ({
  page,
}) => {
  const frame = await atSecondDocument(page);
  let requested!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${fixture.origin}/first`, async (route) => {
    requested();
    await held;
    await route.abort().catch(() => undefined);
  });
  await frame.evaluate((element: VFrameElement) => {
    (window as Window & { traversal?: Promise<string> }).traversal = element.back().then(
      () => "resolved",
      (error: Error) => error.name,
    );
  });
  await reached;
  await frame.evaluate((element) => element.remove());
  release();
  expect(
    await page.evaluate(
      () => (window as Window & { traversal?: Promise<string> }).traversal,
    ),
  ).toBe("AbortError");
});

test("stylesheet redirects preserve asset and import bases and live link identity", async ({
  page,
}) => {
  const frame = await mounted(page, "/linked");
  const identity = await frame.evaluate((element: VFrameElement) => {
    const link =
      element.contentWindow!.document.querySelector<HTMLLinkElement>("#theme")!;
    return {
      connected: link.isConnected,
      sheet: link.sheet !== null,
      owner: link.sheet?.ownerNode === link,
      href: link.sheet?.href,
    };
  });
  expect(identity).toEqual({
    connected: true,
    sheet: true,
    owner: true,
    href: `${fixture.origin}/new/theme.css`,
  });
  await expect(frame.locator("#target")).toHaveCSS("color", "rgb(11, 22, 33)");
  await expect(frame.locator("#target")).toHaveCSS(
    "background-image",
    `url("${fixture.origin}/new/asset.svg")`,
  );
  expect(fixture.requests).not.toContain("/old/nested.css");

  const disabled = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow!;
    const link = guest.document.querySelector<HTMLLinkElement>("#theme")!;
    link.disabled = true;
    const disabled = guest.getComputedStyle(
      guest.document.querySelector("#target")!,
    ).color;
    link.disabled = false;
    link.media = "not all";
    const unmatched = guest.getComputedStyle(
      guest.document.querySelector("#target")!,
    ).color;
    link.media = "all";
    return {
      disabled,
      unmatched,
      restored: guest.getComputedStyle(guest.document.querySelector("#target")!).color,
    };
  });
  expect(disabled).toEqual({
    disabled: "rgb(0, 0, 0)",
    unmatched: "rgb(0, 0, 0)",
    restored: "rgb(11, 22, 33)",
  });

  const replaced = await frame.evaluate(async (element: VFrameElement) => {
    const link =
      element.contentWindow!.document.querySelector<HTMLLinkElement>("#theme")!;
    const oldSheet = link.sheet!;
    const loaded = new Promise<void>((resolve) =>
      link.addEventListener("load", () => resolve(), { once: true }),
    );
    link.href = "/blue.css";
    await loaded;
    const index = oldSheet.insertRule('#held { background-image: url("held.svg") }');
    return {
      oldURL: oldSheet.href,
      replaced: link.sheet !== oldSheet,
      background: (oldSheet.cssRules[index] as CSSStyleRule).style.backgroundImage,
    };
  });
  expect(replaced).toEqual({
    oldURL: `${fixture.origin}/new/theme.css`,
    replaced: true,
    background: `url("${fixture.origin}/new/held.svg")`,
  });
  await expect(frame.locator("#target")).toHaveCSS("color", "rgb(44, 55, 66)");
  const removed = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow!;
    const link = guest.document.querySelector<HTMLLinkElement>("#theme")!;
    link.remove();
    return {
      sheet: link.sheet === null,
      color: guest.getComputedStyle(guest.document.querySelector("#target")!).color,
    };
  });
  expect(removed).toEqual({ sheet: true, color: "rgb(0, 0, 0)" });
});

test("contextual fragments preserve tables, SVG, raw text and inert scripts", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow as Window & typeof globalThis;
    const doc = guest.document;
    const table = doc.createElement("table");
    table.innerHTML = "<tr><td>First</td></tr>";
    table
      .querySelector("tbody")!
      .insertAdjacentHTML("beforeend", "<tr><td>Second</td></tr>");
    table.querySelector("td")!.outerHTML = "<td>Replaced</td>";
    const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.innerHTML = '<circle r="5" />';
    svg.insertAdjacentHTML("beforeend", '<path d="M0 0"/>');
    const textarea = doc.createElement("textarea");
    textarea.innerHTML = "<b>literal</b>&amp;";
    const inert = doc.createElement("div");
    inert.innerHTML = "<script>window.__fragmentExecuted = true</script>";
    doc.body.append(table, svg, textarea, inert);
    return {
      table: table.innerHTML,
      namespaces: Array.from(svg.children, (child) => child.namespaceURI),
      text: textarea.value,
      scripts: inert.querySelectorAll("script").length,
      ran:
        (guest as Window & { __fragmentExecuted?: boolean }).__fragmentExecuted === true,
    };
  });
  expect(result).toEqual({
    table: "<tbody><tr><td>Replaced</td></tr><tr><td>Second</td></tr></tbody>",
    namespaces: ["http://www.w3.org/2000/svg", "http://www.w3.org/2000/svg"],
    text: "<b>literal</b>&",
    scripts: 1,
    ran: false,
  });
});

test("once listeners cannot re-enter and can re-register during invocation", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow as Window & typeof globalThis;
    const button = guest.document.createElement("button");
    guest.document.body.append(button);
    return [guest.document, guest.document.documentElement, guest, button].map(
      (target) => {
        let reentrant = 0;
        target.addEventListener(
          "reentrant",
          () => {
            reentrant++;
            if (reentrant === 1) target.dispatchEvent(new guest.Event("reentrant"));
          },
          { once: true },
        );
        target.dispatchEvent(new guest.Event("reentrant"));
        let registered = 0;
        const again = () => {
          registered++;
          if (registered === 1) target.addEventListener("again", again, { once: true });
        };
        target.addEventListener("again", again, { once: true });
        target.dispatchEvent(new guest.Event("again"));
        target.dispatchEvent(new guest.Event("again"));
        return { reentrant, registered };
      },
    );
  });
  expect(result).toEqual(
    Array.from({ length: 4 }, () => ({ reentrant: 1, registered: 2 })),
  );
});

test("relayed listener exceptions are reported without skipping later listeners", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow as Window & typeof globalThis;
    const button = guest.document.createElement("button");
    guest.document.body.append(button);
    let reports = 0;
    const seen: string[] = [];
    guest.addEventListener("error", (event) => {
      reports++;
      event.preventDefault();
    });
    for (const [name, target] of [
      ["document", guest.document],
      ["root", guest.document.documentElement],
    ] as const) {
      target.addEventListener("throwing", () => {
        throw new Error(name);
      });
      target.addEventListener("throwing", () => seen.push(name));
    }
    button.dispatchEvent(new guest.Event("throwing", { bubbles: true }));
    return { reports, seen };
  });
  expect(result).toEqual({ reports: 2, seen: ["root", "document"] });
});

test("passive listeners do not cancel logical or physical default actions", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow as Window & typeof globalThis;
    const button = guest.document.createElement("button");
    guest.document.body.append(button);
    const prevented: boolean[] = [];
    for (const target of [
      button,
      guest.document.documentElement,
      guest.document,
      guest,
    ]) {
      target.addEventListener(
        "passive",
        (event) => {
          event.preventDefault();
          event.returnValue = false;
          prevented.push(event.defaultPrevented);
        },
        { passive: true },
      );
    }
    const event = new guest.Event("passive", { cancelable: true, bubbles: true });
    const dispatched = button.dispatchEvent(event);
    return { dispatched, physical: event.defaultPrevented, prevented };
  });
  expect(result).toEqual({
    dispatched: true,
    physical: false,
    prevented: [false, false, false, false],
  });
});

test("changing or clearing a live Trusted Types policy object reloads exactly once", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate(async (element: VFrameElement) => {
    let starts = 0;
    const originalWindow = element.contentWindow;
    element.addEventListener("v-frame-loadstart", () => starts++);
    const policy = {
      name: "review-policy",
      createHTML: (source: string) => source,
      createScript: (source: string) => source,
      createScriptURL: (source: string) => source,
    };
    const changed = new Promise<void>((resolve) =>
      element.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    element.trustedTypesPolicy = policy;
    await changed;
    const replaced = element.contentWindow !== originalWindow;
    element.trustedTypesPolicy = policy;
    const afterSame = starts;
    const cleared = new Promise<void>((resolve) =>
      element.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    element.trustedTypesPolicy = null;
    await cleared;
    return { replaced, afterSame, starts, policy: element.trustedTypesPolicy };
  });
  expect(result).toEqual({ replaced: true, afterSame: 1, starts: 2, policy: null });
});

test("inline style writes preserve other CSSOM rules instead of reparsing the sheet", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow!;
    const nodes = Array.from({ length: 100 }, () => {
      const node = guest.document.createElement("div");
      node.style.color = "rgb(1, 2, 3)";
      guest.document.body.append(node);
      return node;
    });
    const style = element.shadowRoot!.querySelector<HTMLStyleElement>(
      "style[data-v-frame-inline-styles]",
    )!;
    const sheet = style.sheet!;
    const rules = Array.from(sheet.cssRules);
    let reparses = 0;
    const textContent = Object.getOwnPropertyDescriptor(Node.prototype, "textContent")!;
    Object.defineProperty(style, "textContent", {
      configurable: true,
      get: () => textContent.get!.call(style),
      set: (value: string) => {
        reparses++;
        textContent.set!.call(style, value);
      },
    });
    for (const node of nodes) node.style.color = "rgb(4, 5, 6)";
    return {
      reparses,
      retained: rules.every((rule, index) => sheet.cssRules[index] === rule),
      colors: new Set(nodes.map((node) => guest.getComputedStyle(node).color)).size,
      first: guest.getComputedStyle(nodes[0]!).color,
      count: sheet.cssRules.length,
    };
  });
  expect(result).toEqual({
    reparses: 0,
    retained: true,
    colors: 1,
    first: "rgb(4, 5, 6)",
    count: 100,
  });
});

test("live collections reflect synchronous mutations without repeated full-tree queries", async ({
  page,
}) => {
  const frame = await mounted(page);
  const result = await frame.evaluate((element: VFrameElement) => {
    const guest = element.contentWindow!;
    const doc = guest.document;
    const container = doc.createElement("div");
    container.innerHTML = Array.from(
      { length: 100 },
      (_value, index) => `<a id="row-${index}" class="row" href="/row" name="row"></a>`,
    ).join("");
    doc.body.append(container);
    const tags = doc.getElementsByTagName("a");
    const classes = doc.getElementsByClassName("row");
    const links = doc.links;
    let snapshots = 0;
    const originalArrayFrom = Array.from;
    Array.from = ((...args: unknown[]) => {
      const brand = Object.prototype.toString.call(args[0]);
      if (brand === "[object NodeList]" || brand === "[object HTMLCollection]")
        snapshots++;
      return Reflect.apply(originalArrayFrom, Array, args);
    }) as typeof Array.from;
    const first = doc.querySelector("#row-0") === tags[1];
    let indexed = 0;
    for (let index = 0; index < links.length; index++) if (links[index]) indexed++;
    Array.from = originalArrayFrom;
    const before = { tags: tags.length, classes: classes.length, links: links.length };
    const row = container.firstElementChild!;
    row.removeAttribute("href");
    row.classList.remove("row");
    row.remove();
    return {
      first,
      snapshots,
      indexed,
      before,
      after: { tags: tags.length, classes: classes.length, links: links.length },
      named: classes.namedItem("row-1")?.id,
    };
  });
  expect(result).toEqual({
    first: true,
    snapshots: 1,
    indexed: 101,
    before: { tags: 101, classes: 100, links: 101 },
    after: { tags: 100, classes: 99, links: 100 },
    named: "row-1",
  });
});
