import { expect, test } from "@playwright/test";
import { startFixtureServer, type FixtureServer } from "./support/fixture-server";

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture.close();
});

async function installBundle(page: import("@playwright/test").Page) {
  await page.goto(fixture.origin);
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  await expect.poll(() => page.evaluate(() => Boolean(customElements.get("v-frame")))).toBe(true);
}

async function mountFrame(page: import("@playwright/test").Page, source: string) {
  await page.evaluate((src) => {
    const frame = document.createElement("v-frame");
    frame.setAttribute("src", src);
    document.querySelector("#host")?.append(frame);
  }, source);
  return page.locator("v-frame");
}

test("importing the bundle has no registration side effect and defineVFrame is guarded", async ({ page, browser }) => {
  await page.goto(fixture.origin);
  expect(await page.evaluate(() => customElements.get("v-frame"))).toBeUndefined();

  const registration = await page.evaluate(async (url) => {
    const bundle = await import(url);
    const before = Boolean(customElements.get("v-frame"));
    const first = bundle.defineVFrame();
    const second = bundle.defineVFrame();
    return { before, sameConstructor: first === second, registered: customElements.get("v-frame") === bundle.VFrameElement };
  }, `${fixture.origin}/dist/index.js`);
  expect(registration).toEqual({ before: false, sameConstructor: true, registered: true });

  const collisionPage = await browser.newPage();
  try {
    await collisionPage.goto(fixture.origin);
    await collisionPage.evaluate(() => customElements.define("v-frame", class extends HTMLElement {}));
    await expect(collisionPage.evaluate(async (url) => (await import(url)).defineVFrame(), `${fixture.origin}/dist/index.js`)).rejects.toThrow();
  } finally {
    await collisionPage.close();
  }
});

test("loads a document into a semantic shadow DOM and exposes readonly state", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, `${fixture.origin}/documents/first.html`);

  await expect.poll(() => frame.evaluate((element) => (element as any).status)).toBe("ready");
  await expect(frame.locator("main#first")).toContainText("First document");
  await expect(frame.locator("v-html > v-head")).toHaveCount(1);
  await expect(frame.locator("v-html > v-body")).toHaveCount(1);
  await expect(frame.locator("iframe")).toHaveCount(1);
  await expect(frame.locator("iframe")).toHaveAttribute("aria-hidden", "true");
  await expect(frame.locator("iframe")).toHaveCSS("opacity", "0");
  await expect(frame.locator("iframe")).toHaveCSS("pointer-events", "none");

  const state = await frame.evaluate((element) => {
    const value = element as HTMLElement & { currentURL: string; contentWindow: Window | null };
    return { currentURL: value.currentURL, hasContentWindow: value.contentWindow !== null };
  });
  expect(state.currentURL).toBe(`${fixture.origin}/documents/first.html`);
  expect(state.hasContentWindow).toBe(true);
});

test("adopts server-rendered shadow content without fetching the entry document", async ({ page }) => {
  await page.goto(`${fixture.origin}/documents/adopted-host.html`);
  const frame = page.locator("v-frame");

  await expect(frame.locator("#adopted-copy")).toHaveText("Server-rendered before definition");
  await expect(frame.locator("#adopted-copy")).toHaveCSS("color", "rgb(24, 96, 48)");
  expect(fixture.requests.filter((path) => path === "/documents/adopted-entry.html")).toHaveLength(0);

  await page.evaluate(() => {
    const prototype = HTMLElement.prototype as HTMLElement & {
      startViewTransition?: (update: () => void) => ViewTransition;
    };
    const nativeStart = prototype.startViewTransition;
    (window as Window & typeof globalThis & { __scopedTransitionStarts?: number })
      .__scopedTransitionStarts = 0;
    if (nativeStart === undefined) {
      return;
    }
    prototype.startViewTransition = function startViewTransition(update): ViewTransition {
      (window as Window & typeof globalThis & { __scopedTransitionStarts: number })
        .__scopedTransitionStarts += 1;
      return nativeStart.call(this, update);
    };
  });
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);

  await expect.poll(() => frame.evaluate((element) => (element as any).status)).toBe("ready");
  await expect(frame.locator("#adopted-copy")).toHaveText("Activated without an entry fetch");
  expect(fixture.requests.filter((path) => path === "/documents/adopted-entry.html")).toHaveLength(0);
  await expect.poll(() => frame.evaluate((element) => (element as any).currentURL)).toBe(
    `${fixture.origin}/documents/adopted-entry.html`,
  );
  const transitionState = await page.evaluate(() => ({
    supported: typeof (HTMLElement.prototype as HTMLElement & {
      startViewTransition?: unknown;
    }).startViewTransition === "function",
    starts: (window as Window & typeof globalThis & { __scopedTransitionStarts: number })
      .__scopedTransitionStarts,
  }));
  expect(transitionState.starts).toBe(transitionState.supported ? 1 : 0);

  await frame.evaluate((element) => (element as any).reload());
  await expect(frame.locator("#network-reload")).toHaveText("Fetched by reload");
  expect(fixture.requests.filter((path) => path === "/documents/adopted-entry.html")).toHaveLength(1);
});

test("runs simultaneous adopted handoffs as independent scoped transitions", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "chromium", "element-scoped transitions are not available");
  await page.goto(fixture.origin);
  await page.evaluate(() => {
    const style = document.createElement("style");
    style.textContent = "v-frame::view-transition-group(root) { animation-duration: 2s; }";
    document.head.append(style);

    const prototype = HTMLElement.prototype as HTMLElement & {
      startViewTransition(update: () => void): ViewTransition;
    };
    const nativeStart = prototype.startViewTransition;
    const transitionHosts: HTMLElement[] = [];
    prototype.startViewTransition = function startViewTransition(update): ViewTransition {
      transitionHosts.push(this);
      return nativeStart.call(this, update);
    };
    (window as Window & typeof globalThis & { __transitionHosts?: HTMLElement[] })
      .__transitionHosts = transitionHosts;

    for (const name of ["first", "second"]) {
      const frame = document.createElement("v-frame");
      frame.id = name;
      frame.setAttribute("adopt", "");
      frame.setAttribute("src", `/documents/${name}.html`);
      frame.attachShadow({ mode: "open" }).innerHTML =
        `<v-html><v-head></v-head><v-body><p>${name}</p></v-body></v-html>`;
      document.querySelector("#host")?.append(frame);
    }
  });

  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  const frames = page.locator("v-frame");
  await expect.poll(() => frames.evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement & { status: string }).status)
  )).toEqual(["ready", "ready"]);

  const transitionState = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll("v-frame")) as Array<HTMLElement & {
      activeViewTransition: ViewTransition | null;
    }>;
    const hosts = (window as Window & typeof globalThis & { __transitionHosts: HTMLElement[] })
      .__transitionHosts;
    return {
      starts: hosts.length,
      uniqueHosts: new Set(hosts).size,
      active: elements.map((element) => element.activeViewTransition !== null),
    };
  });
  expect(transitionState).toEqual({
    starts: 2,
    uniqueHosts: 2,
    active: [true, true],
  });
});

test("does not restore adopted markup after removal during a transition", async ({ page }) => {
  const entryRequestsBefore = fixture.requests.filter(
    (path) => path === "/documents/adopted-entry.html",
  ).length;
  await page.goto(`${fixture.origin}/documents/adopted-host.html`);
  await page.evaluate(() => {
    const prototype = HTMLElement.prototype as HTMLElement & {
      startViewTransition?: (update: () => void) => ViewTransition;
    };
    prototype.startViewTransition = function startViewTransition(update): ViewTransition {
      let release: (() => void) | null = null;
      const updateCallbackDone = new Promise<void>((resolve, reject) => {
        release = () => {
          Promise.resolve().then(update).then(resolve, reject);
        };
      });
      const transition = {
        finished: updateCallbackDone,
        ready: updateCallbackDone,
        types: new Set<string>(),
        updateCallbackDone,
        skipTransition() {
          release?.();
          release = null;
        },
      } as unknown as ViewTransition;
      (window as Window & typeof globalThis & { __heldTransitionStarted?: boolean })
        .__heldTransitionStarted = true;
      return transition;
    };
  });
  await page.evaluate(async (url) => {
    const frame = document.querySelector("v-frame") as HTMLElement & {
      status: string;
    };
    (window as Window & typeof globalThis & { __heldFrame?: HTMLElement })
      .__heldFrame = frame;
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & typeof globalThis & { __heldTransitionStarted?: boolean })
      .__heldTransitionStarted
  )).toBe(true);

  await page.evaluate(() => {
    (window as Window & typeof globalThis & { __heldFrame: HTMLElement })
      .__heldFrame.remove();
  });
  await expect.poll(() => page.evaluate(() => {
    const frame = (window as Window & typeof globalThis & {
      __heldFrame: HTMLElement & { status: string };
    }).__heldFrame;
    return {
      status: frame.status,
      childElements: frame.shadowRoot?.children.length,
    };
  })).toEqual({ status: "idle", childElements: 0 });
  expect(fixture.requests.filter(
    (path) => path === "/documents/adopted-entry.html",
  )).toHaveLength(entryRequestsBefore);
});

test("emits lifecycle errors and ignores stale loads after disconnection", async ({ page }) => {
  await installBundle(page);
  const events = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & { reload(): void };
    const seen: string[] = [];
    for (const name of ["v-frame-loadstart", "v-frame-load", "v-frame-error"]) frame.addEventListener(name, () => seen.push(name));
    document.body.append(frame);
    frame.setAttribute("src", `${origin}/documents/first.html`);
    await new Promise((resolve) => frame.addEventListener("v-frame-load", resolve, { once: true }));
    const reloaded = new Promise((resolve) => frame.addEventListener("v-frame-load", resolve, { once: true }));
    frame.reload();
    await reloaded;
    frame.setAttribute("src", `${origin}/documents/broken.html`);
    await new Promise((resolve) => frame.addEventListener("v-frame-error", resolve, { once: true }));
    frame.setAttribute("src", `${origin}/documents/second.html`);
    frame.remove();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return seen;
  }, fixture.origin);

  expect(events).toEqual(expect.arrayContaining(["v-frame-loadstart", "v-frame-load", "v-frame-error"]));
  await expect(page.locator("v-frame")).toHaveCount(0);
});

test("bridges document scripts, rewritten CSS, and relative assets", async ({ page }) => {
  await installBundle(page);
  const scripted = await mountFrame(page, `${fixture.origin}/documents/scripted.html`);
  await expect(scripted.locator("#script-added")).toHaveText("Script executed");

  const styled = await mountFrame(page, `${fixture.origin}/documents/styled.html`);
  await expect(styled.locator("#relative-image")).toHaveCount(1);
  await expect(styled.locator("#styled-copy")).toHaveCSS("color", "rgb(12, 34, 56)");
  await expect.poll(() => fixture.requests.filter((path) => path === "/assets/pixel.png").length).toBeGreaterThan(0);
});

test("forwards fetch-driven DOM changes and iframe history navigation", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, `${fixture.origin}/documents/application.html`);
  await expect(frame.locator("#load")).toHaveCount(1);
  await frame.evaluate((element) => (element as any).contentWindow.document.querySelector("#load").click());
  await expect(frame.locator("#result")).toHaveText("Fetched from fixture");

  const navigated = page.evaluate(() => new Promise<string>((resolve) => {
    document.querySelector("v-frame")?.addEventListener("v-frame-navigate", (event) => {
      resolve((event as CustomEvent<{ to?: string }>).detail?.to ?? "");
    }, { once: true });
  }));
  await frame.evaluate((element) => (element as any).contentWindow.document.querySelector("#push").click());
  await expect.poll(async () => (await frame.evaluate((element) => (element as any).currentURL))).toContain("history-state");
  await expect(navigated).resolves.toContain("history-state");
});
