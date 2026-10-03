import { expect, test, type Page } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { installBundle } from "./support/mount-frame";

let fixture: HTTPFixture;
test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/fragments": htmlDocument(
        '<a id="one-link" href="#one">One</a><a id="two-link" href="#two">Two</a><a id="alias-link" href="#alias">Alias</a><a id="top-link" href="#ToP">Top</a><div id="one" class="part">One<span>Child</span></div><div style="height:1000px"></div><div id="two" class="part">Two</div><a id="named" name="alias">Alias</a><div style="height:1500px"></div><script>requestAnimationFrame(()=>{window.firstPaintScroll=scrollY})</script>',
        "<style>html,body{margin:0}.part{color:rgb(200,0,0)}.part:target{color:rgb(0,200,0)}.part:ta\\72 get{background-color:rgb(10,20,30)}</style>",
      ),
      "/pending-fragment": htmlDocument(
        '<div id="replacement">Replacement</div><div style="height:1000px"></div><div id="two">Two</div><div style="height:1500px"></div><script type="module">location.hash="two";await fetch("/fragment-release");function record(){if(getComputedStyle(document.body).visibility==="hidden")requestAnimationFrame(record);else window.firstPaintScroll=scrollY}requestAnimationFrame(record)</script>',
        "<style>html,body{margin:0}</style>",
      ),
      "/fragment-release": { type: "text/plain", body: "released" },
    },
  });
});

test("a staged document's initial hash change leaves the old viewport alone until handoff", async ({
  page,
}) => {
  const frame = await mount(page);
  await frame.evaluate((element) => element.scrollTo({ top: 250, behavior: "instant" }));
  let release: (() => Promise<void>) | undefined;
  await page.route("**/fragment-release", (route) => {
    release = () => route.continue();
  });
  await frame.evaluate((element: VFrameElement, src) => {
    const doc = element.contentWindow!.document;
    const link = doc.createElement("a");
    link.href = src;
    doc.body.append(link);
    link.click();
  }, fixture.origin + "/pending-fragment");
  await expect.poll(() => !!release).toBe(true);
  await expect
    .poll(() =>
      frame.evaluate(
        (element) =>
          [...element.shadowRoot!.querySelectorAll("v-html")]
            .at(-1)!
            .querySelector(":target")?.id,
      ),
    )
    .toBe("two");
  expect(await frame.evaluate((element) => element.scrollTop)).toBe(250);
  await release!();
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  await expect
    .poll(() =>
      frame.evaluate(
        (element: VFrameElement) =>
          (element.contentWindow as Window & { firstPaintScroll?: number })!
            .firstPaintScroll,
      ),
    )
    .toBeGreaterThan(1000);
  const state = await frame.evaluate((element: VFrameElement) => ({
    scroll: element.scrollTop,
    display: getComputedStyle(element).display,
    roots: element.shadowRoot!.querySelectorAll("v-html").length,
    targetTop:
      window.Element.prototype.getBoundingClientRect.call(
        element.contentWindow!.document.querySelector("#two")!,
      ).top - element.getBoundingClientRect().top,
  }));
  expect(state).toMatchObject({ display: "block", roots: 1 });
  expect(state.scroll).toBeGreaterThan(1000);
  expect(state.targetTop).toBeCloseTo(0, 0);
});
test.afterAll(async () => {
  await fixture.close();
});

async function mount(page: Page, fragment = "") {
  await installBundle(page, fixture.origin);
  await page.evaluate(
    async (src) => {
      const frame = document.createElement("iframe");
      frame.id = "native";
      frame.style.cssText = "height:240px;width:400px;border:0";
      const loaded = new Promise<void>((resolve) => (frame.onload = () => resolve()));
      frame.src = src;
      document.querySelector("#host")!.append(frame);
      await loaded;
      const guest = document.createElement("v-frame") as VFrameElement;
      guest.id = "frame";
      guest.style.cssText = "height:240px;width:400px";
      guest.src = src;
      document.querySelector("#host")!.append(guest);
    },
    fixture.origin + "/fragments" + fragment,
  );
  const frame = page.locator("#frame");
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  return frame;
}

test("a fetched document's initial fragment scrolls before its first paint", async ({
  page,
}) => {
  const frame = await mount(page, "#two");
  await expect
    .poll(() =>
      frame.evaluate(
        (element: VFrameElement) =>
          (element.contentWindow as Window & { firstPaintScroll?: number })!
            .firstPaintScroll,
      ),
    )
    .toBeGreaterThan(1000);
  const result = await page.evaluate(() => {
    const native = (document.querySelector("#native") as HTMLIFrameElement)
      .contentWindow!;
    const child = (document.querySelector("#frame") as VFrameElement).contentWindow!;
    return { native: native.scrollY, virtual: child.scrollY, host: scrollY };
  });
  expect(result.virtual).toBe(result.native);
  expect(result.host).toBe(0);
});

for (const action of ["hash", "assign", "replace", "navigate"] as const) {
  test(`${action} fragment changes scroll before hashchange, without moving the host or overriding traversal`, async ({
    page,
  }) => {
    const frame = await mount(page);
    await page.evaluate(() => {
      document.body.style.cssText = "height:5000px;margin:0";
      (document.querySelector("#host") as HTMLElement).style.marginTop = "500px";
      scrollTo(0, 400);
    });
    const result = await frame.evaluate(async (element: VFrameElement, action) => {
      const child = element.contentWindow!;
      child.scrollTo({ top: 250, behavior: "instant" });
      const changed = new Promise<number>((resolve) =>
        child.addEventListener("hashchange", () => resolve(child.scrollY), {
          once: true,
        }),
      );
      if (action === "hash") child.location.hash = "two";
      else if (action === "assign" || action === "replace") {
        // Absolute URLs isolate scrolling from Location's caller-base behavior
        // when this test invokes a guest method from the host window.
        child.location[action](new URL("#two", element.currentURL!).href);
      } else await element.navigate("#two");
      return { atHashchange: await changed, scroll: child.scrollY };
    }, action);
    expect(result.scroll).toBeGreaterThan(1000);
    expect(result.atHashchange).toBe(result.scroll);
    expect(await page.evaluate(() => scrollY)).toBe(400);
    if (action !== "replace") {
      await frame.evaluate((element: VFrameElement) => element.back());
      expect(
        await frame.evaluate((element: VFrameElement) => element.contentWindow!.scrollY),
      ).toBe(250);
    }
  });
}

test("location.hash supports decoded targets and case-insensitive top fallback", async ({
  page,
}) => {
  const frame = await mount(page);
  const values = await frame.evaluate(async (element: VFrameElement) => {
    const child = element.contentWindow!;
    const values: number[] = [];
    for (const hash of ["#tw%6F", "#%54oP", "#two", "#"]) {
      const changed = new Promise<void>((resolve) =>
        child.addEventListener("hashchange", () => resolve(), { once: true }),
      );
      child.location.hash = hash;
      await changed;
      values.push(child.scrollY);
    }
    return values;
  });
  expect(values[0]).toBeGreaterThan(1000);
  expect(values).toEqual([values[0], 0, values[0], 0]);
});

test("escaped target and shell selectors match native DOM, styles and CSSOM", async ({
  page,
}) => {
  await mount(page, "#one");
  const result = await page.evaluate(() => {
    const native = (document.querySelector("#native") as HTMLIFrameElement)
      .contentWindow!;
    const child = (document.querySelector("#frame") as VFrameElement).contentWindow!;
    function exercise(view: Window) {
      const one = view.document.querySelector("#one")!;
      const style = view.document.createElement("style");
      view.document.head.append(style);
      style.sheet!.insertRule(".part:ta\\000072get{border-top:3px solid rgb(1,2,3)}");
      return {
        targets: [...view.document.querySelectorAll(":ta\\72 get")].map(
          (node) => node.id,
        ),
        match: one.matches(":ta\\72 get"),
        negative: one.matches(":not(:ta\\72 get)"),
        closest: one.firstElementChild!.closest(":ta\\72 get")?.id,
        body: view.document.querySelector("\\62 ody") === view.document.body,
        root: view.document.querySelector(":r\\6f ot") === view.document.documentElement,
        background: view.getComputedStyle(one).backgroundColor,
        border: view.getComputedStyle(one).borderTopColor,
      };
    }
    return { native: exercise(native), virtual: exercise(child) };
  });
  expect(result.native).toEqual({
    targets: ["one"],
    match: true,
    negative: false,
    closest: "one",
    body: true,
    root: true,
    background: "rgb(10, 20, 30)",
    border: "rgb(1, 2, 3)",
  });
  expect(result.virtual).toEqual(result.native);
});

test("fragment targets drive styles, positive and negative selectors, closest and event observations", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const native = (document.querySelector("#native") as HTMLIFrameElement)
      .contentWindow! as Window & typeof globalThis;
    const child = (document.querySelector("#frame") as VFrameElement)
      .contentWindow! as Window & typeof globalThis;
    async function exercise(view: Window & typeof globalThis) {
      const events: Array<{ type: string; target: string | null }> = [];
      for (const type of ["popstate", "hashchange"])
        view.addEventListener(type, () =>
          events.push({
            type,
            target: view.document.querySelector(":target")?.id ?? null,
          }),
        );
      const changed = new Promise<void>((resolve) =>
        view.addEventListener("hashchange", () => resolve(), { once: true }),
      );
      (view.document.querySelector("#one-link") as HTMLElement).click();
      await changed;
      const one = view.document.querySelector("#one")!;
      return {
        target: view.document.querySelector(":target")?.id,
        targets: [...view.document.querySelectorAll(":is(:target)")].map(
          (element) => element.id,
        ),
        negatives: [...view.document.querySelectorAll(".part:not(:target)")].map(
          (element) => element.id,
        ),
        matches: one.matches(":target:not(:not(:target))"),
        closest: one.firstElementChild!.closest(":target")?.id,
        parent: view.document.querySelector("body:has(:target)") === view.document.body,
        color: view.getComputedStyle(one).color,
        events,
      };
    }
    return { native: await exercise(native), virtual: await exercise(child) };
  });
  const { events, ...native } = result.native;
  expect(native).toEqual({
    target: "one",
    targets: ["one"],
    negatives: ["two"],
    matches: true,
    closest: "one",
    parent: true,
    color: "rgb(0, 200, 0)",
  });
  expect(events.map((event) => event.type)).toEqual(["popstate", "hashchange"]);
  expect(events[1]).toEqual({ type: "hashchange", target: "one" });
  // Chromium selects its native target after popstate; Firefox and WebKit do
  // so before it. The guest deliberately exposes the new target in both events.
  expect(result.virtual).toEqual({
    ...native,
    events: [
      { type: "popstate", target: "one" },
      { type: "hashchange", target: "one" },
    ],
  });
});

test("preserves the selected element through silent history writes, ID changes and cloning", async ({
  page,
}) => {
  await mount(page, "#one");
  const result = await page.evaluate(() => {
    const native = (document.querySelector("#native") as HTMLIFrameElement)
      .contentWindow!;
    const child = (document.querySelector("#frame") as VFrameElement).contentWindow!;
    function exercise(view: Window) {
      const snapshots: string[][] = [];
      const snapshot = () =>
        snapshots.push(
          [...view.document.querySelectorAll(":target")].map((element) => element.id),
        );
      snapshot();
      view.history.pushState(null, "", "#two");
      view.history.replaceState(null, "", "#alias");
      snapshot();
      const selected = view.document.querySelector("#one")!;
      selected.id = "renamed";
      snapshot();
      const clone = selected.cloneNode(true) as Element;
      clone.id = "one";
      view.document.body.append(clone);
      snapshot();
      selected.remove();
      snapshot();
      return snapshots;
    }
    return { native: exercise(native), virtual: exercise(child) };
  });
  expect(result.native).toEqual([["one"], ["one"], ["renamed"], ["renamed"], []]);
  expect(result.virtual).toEqual(result.native);
});

test("selects only the first duplicate ID, prefers IDs to named anchors, and clears canceled or absent targets correctly", async ({
  page,
}) => {
  const frame = await mount(page);
  await frame.evaluate((element: VFrameElement) => {
    const doc = element.contentWindow!.document;
    const duplicate = doc.createElement("div");
    duplicate.id = "one";
    doc.body.append(duplicate);
    const namedID = doc.createElement("div");
    namedID.id = "alias";
    doc.body.append(namedID);
  });
  await frame.locator("#one-link").click();
  await expect
    .poll(() =>
      frame.evaluate((element: VFrameElement) =>
        [...element.contentWindow!.document.querySelectorAll(":target")].map(
          (node) => node.textContent,
        ),
      ),
    )
    .toEqual(["OneChild"]);
  await frame.evaluate((element: VFrameElement) => {
    const doc = element.contentWindow!.document;
    (doc.querySelector("#alias-link") as HTMLElement).click();
  });
  await expect
    .poll(() =>
      frame.evaluate(
        (element: VFrameElement) =>
          element.contentWindow!.document.querySelector(":target")?.id,
      ),
    )
    .toBe("alias");
  await frame.evaluate((element: VFrameElement) => {
    const doc = element.contentWindow!.document;
    doc
      .querySelector("#two-link")!
      .addEventListener("click", (event) => event.preventDefault(), { once: true });
    (doc.querySelector("#two-link") as HTMLElement).click();
  });
  await expect
    .poll(() =>
      frame.evaluate(
        (element: VFrameElement) =>
          element.contentWindow!.document.querySelector(":target")?.id,
      ),
    )
    .toBe("alias");
  await frame.evaluate((element: VFrameElement) => {
    const link = element.contentWindow!.document.querySelector(
      "#two-link",
    ) as HTMLAnchorElement;
    link.href = "#missing";
    link.click();
  });
  await expect
    .poll(() =>
      frame.evaluate((element: VFrameElement) => element.contentWindow!.location.hash),
    )
    .toBe("#missing");
  expect(
    await frame.evaluate((element: VFrameElement) =>
      element.contentWindow!.document.querySelector(":target"),
    ),
  ).toBeNull();
  await frame.evaluate((element: VFrameElement) => element.back());
  expect(
    await frame.evaluate(
      (element: VFrameElement) =>
        element.contentWindow!.document.querySelector(":target")?.id,
    ),
  ).toBe("alias");
});

test("retains detached target identity without copying it into clones or document fragments", async ({
  page,
}) => {
  await mount(page, "#one");
  const result = await page.evaluate(async () => {
    const native = (document.querySelector("#native") as HTMLIFrameElement)
      .contentWindow!;
    const child = (document.querySelector("#frame") as VFrameElement).contentWindow!;
    async function exercise(view: Window) {
      const selected = view.document.querySelector("#one")!;
      const clone = selected.cloneNode(true) as Element;
      const cloned = clone.matches(":target");
      const fragment = view.document.createDocumentFragment();
      fragment.append(selected);
      view.document.body.append(clone);
      const detached = {
        selected: selected.matches(":target"),
        closest: selected.firstElementChild!.closest(":target")?.id,
        fragment: fragment.querySelector(":target")?.id,
        fragments: [...fragment.querySelectorAll(":target")].map((node) => node.id),
        document: view.document.querySelector(":target")?.id ?? null,
        clone: clone.matches(":target"),
      };
      const changed = new Promise<void>((resolve) =>
        view.addEventListener("hashchange", () => resolve(), { once: true }),
      );
      (view.document.querySelector("#two-link") as HTMLElement).click();
      await changed;
      return {
        cloned,
        detached,
        after: {
          selected: selected.matches(":target"),
          fragment: fragment.querySelector(":target")?.id ?? null,
          document: view.document.querySelector(":target")?.id,
        },
      };
    }
    return { native: await exercise(native), virtual: await exercise(child) };
  });
  expect(result.native).toEqual({
    cloned: false,
    detached: {
      selected: true,
      closest: "one",
      fragment: "one",
      fragments: ["one"],
      document: null,
      clone: false,
    },
    after: { selected: false, fragment: null, document: "two" },
  });
  expect(result.virtual).toEqual(result.native);
});

test("matches native raw and decoded fragments, malformed escapes, foreign IDs and inert templates", async ({
  page,
}) => {
  await mount(page);
  const result = await page.evaluate(async () => {
    const native = (document.querySelector("#native") as HTMLIFrameElement)
      .contentWindow!;
    const child = (document.querySelector("#frame") as VFrameElement).contentWindow!;
    const cases = [
      [
        "#A%20B",
        '<div id="A B" data-case="decoded-id"></div><div id="A%20B" data-case="raw-id"></div>',
      ],
      [
        "#A%20B",
        '<div id="A B" data-case="decoded-id"></div><a name="A%20B" data-case="raw-name"></a>',
      ],
      ["#A%20B", '<a name="A B" data-case="decoded-name"></a>'],
      ["#%E0%A4%A", '<div id="%E0%A4%A" data-case="raw-id"></div>'],
      ["#shape", '<svg><rect id="shape" data-case="svg-id"/></svg>'],
      ["#shape", '<svg><a name="shape" data-case="svg-name"/></svg>'],
      [
        "#one",
        '<template><div id="one" data-case="inert"></div></template><div id="one" data-case="active"></div>',
      ],
    ];
    async function exercise(view: Window) {
      const targets: Array<string | null> = [];
      for (let index = 0; index < cases.length; index++) {
        const [hash, markup] = cases[index]!;
        view.document.body.innerHTML = markup!;
        const link = view.document.createElement("a");
        view.document.body.append(link);
        for (const destination of [`#reset-${index}`, hash!]) {
          const changed = new Promise<void>((resolve) =>
            view.addEventListener("hashchange", () => resolve(), { once: true }),
          );
          link.href = destination;
          link.click();
          await changed;
        }
        targets.push(
          view.document.querySelector(":target")?.getAttribute("data-case") ?? null,
        );
      }
      return targets;
    }
    return { native: await exercise(native), virtual: await exercise(child) };
  });
  expect(result.native).toEqual([
    "raw-id",
    "raw-name",
    "decoded-name",
    "raw-id",
    "svg-id",
    null,
    "active",
  ]);
  expect(result.virtual).toEqual(result.native);
});

test("updates targets for host-bound fragments and traversal but not guest history writes", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await page.evaluate(() => {
    history.replaceState(null, "", "/fragments#one");
    const frame = document.createElement("v-frame") as VFrameElement;
    frame.id = "frame";
    frame.style.cssText = "height:240px;width:400px";
    frame.setAttribute("navigation", "host");
    frame.src = location.href;
    document.querySelector("#host")!.append(frame);
  });
  const frame = page.locator("#frame");
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  const target = () =>
    frame.evaluate(
      (element: VFrameElement) =>
        element.contentWindow!.document.querySelector(":target")?.id,
    );
  expect(await target()).toBe("one");
  await frame.evaluate((element: VFrameElement) =>
    element.contentWindow!.history.pushState(null, "", "#two"),
  );
  expect(await target()).toBe("one");
  await frame.evaluate((element: VFrameElement) =>
    (element.contentWindow!.document.querySelector("#alias-link") as HTMLElement).click(),
  );
  await expect.poll(target).toBe("named");
  expect(new URL(page.url()).hash).toBe("#alias");
  expect(
    await frame.evaluate((element: VFrameElement) => element.contentWindow!.scrollY),
  ).toBeGreaterThan(1000);
  await frame.evaluate((element: VFrameElement) => element.back());
  await expect.poll(target).toBe("two");
  await frame.evaluate((element: VFrameElement) => element.forward());
  await expect.poll(target).toBe("named");
});

test("rewrites dynamic stylesheet and CSSOM target rules without reducing specificity", async ({
  page,
}) => {
  const frame = await mount(page, "#one");
  await frame.evaluate((element: VFrameElement) => {
    const view = element.contentWindow!;
    const style = view.document.createElement("style");
    style.textContent =
      ".part:target{background:rgb(0,150,0)}.part{background:rgb(150,0,0)}";
    view.document.head.append(style);
  });
  await expect(frame.locator("#one")).toHaveCSS("background-color", "rgb(0, 150, 0)");
  await frame.evaluate((element: VFrameElement) => {
    const view = element.contentWindow!;
    view.document.styleSheets[0]!.insertRule(
      ".part:target{outline:3px solid rgb(0,0,150)}",
      0,
    );
    const names = view.document.querySelector("#one")!.getAttributeNames();
    if (names.includes("data-v-frame-target"))
      throw new Error("Target state leaked into authored attributes");
  });
  await expect(frame.locator("#one")).toHaveCSS("outline-color", "rgb(0, 0, 150)");
  expect(
    await frame.evaluate((element: VFrameElement) => {
      const doc = element.contentWindow!.document;
      const selected = doc.querySelector("#one")!;
      return [
        () => doc.querySelector(":target()"),
        () => selected.matches(":target()"),
        () => selected.closest(":target()"),
      ].map((query) => {
        try {
          query();
          return null;
        } catch (error) {
          return (error as DOMException).name;
        }
      });
    }),
  ).toEqual(["SyntaxError", "SyntaxError", "SyntaxError"]);
});

for (const hash of ["#top", "#ToP", "#%74op"]) {
  test(`scrolls ${hash} to the top only in the absence of a matching element`, async ({
    page,
  }) => {
    const frame = await mount(page);
    const result = await page.evaluate(async (hash) => {
      const native = (document.querySelector("#native") as HTMLIFrameElement)
        .contentWindow!;
      const frame = document.querySelector("#frame") as VFrameElement;
      const child = frame.contentWindow!;
      async function exercise(
        view: Window,
        scroll: (top: number) => void,
        read: () => number,
      ) {
        const link = view.document.querySelector("#top-link") as HTMLAnchorElement;
        link.href = hash;
        scroll(500);
        link.click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        const fallback = read();
        const target = view.document.querySelector("#two")!;
        target.id = decodeURIComponent(hash.slice(1));
        scroll(500);
        link.click();
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { fallback, matched: read() > 500 };
      }
      return {
        native: await exercise(
          native,
          (top) => native.scrollTo(0, top),
          () => native.scrollY,
        ),
        virtual: await exercise(
          child,
          (top) => (frame.scrollTop = top),
          () => frame.scrollTop,
        ),
      };
    }, hash);
    expect(result.native).toEqual({ fallback: 0, matched: true });
    expect(result.virtual).toEqual(result.native);
    await expect(frame).toBeVisible();
  });
}
