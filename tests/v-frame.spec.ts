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

test("keeps adopted preview visible until its initial module completes", async ({ page }) => {
  await page.goto(fixture.origin);
  await page.evaluate(() => {
    let releaseModule = () => undefined;
    const moduleGate = new Promise<void>((resolve) => {
      releaseModule = resolve;
    });
    const transitionSnapshots: Array<{
      liveText: string | null;
      markupCount: number;
      moduleFinished: boolean;
    }> = [];
    const transitionState = {
      starts: 0,
      transitionSnapshots,
    };
    const prototype = HTMLElement.prototype as HTMLElement & {
      startViewTransition?: (update: () => void) => ViewTransition;
    };
    prototype.startViewTransition = function startViewTransition(update): ViewTransition {
      transitionState.starts += 1;
      const markup = this.shadowRoot?.querySelectorAll("v-html") ?? [];
      transitionSnapshots.push({
        liveText: markup[1]?.querySelector("#adopted-copy")?.textContent ?? null,
        markupCount: markup.length,
        moduleFinished: (window as Window & typeof globalThis & {
          __adoptedModuleFinished?: boolean;
        }).__adoptedModuleFinished === true,
      });
      const updateCallbackDone = Promise.resolve().then(update);
      return {
        finished: new Promise<void>(() => undefined),
        ready: Promise.reject(new Error("The staged transition is not animatable")),
        types: new Set<string>(),
        updateCallbackDone,
        skipTransition() {},
      } as unknown as ViewTransition;
    };

    const hostWindow = window as Window & typeof globalThis & {
      __adoptedModuleFinished?: boolean;
      __adoptedModuleGate?: Promise<void>;
      __adoptedModuleStarted?: boolean;
      __adoptedTransitionState?: typeof transitionState;
      __releaseAdoptedModule?: () => void;
    };
    hostWindow.__adoptedModuleFinished = false;
    hostWindow.__adoptedModuleGate = moduleGate;
    hostWindow.__adoptedModuleStarted = false;
    hostWindow.__adoptedTransitionState = transitionState;
    hostWindow.__releaseAdoptedModule = releaseModule;

    const frame = document.createElement("v-frame");
    frame.setAttribute("adopt", "");
    frame.setAttribute("src", "/documents/adopted-entry.html");
    frame.attachShadow({ mode: "open" }).innerHTML = `
      <v-html style="visibility: visible !important; opacity: 1 !important">
        <v-head><style>v-html, v-body { display: block; } v-head { display: none; }</style></v-head>
        <v-body>
          <p id="adopted-copy" style="visibility: visible !important; pointer-events: auto !important">Server-rendered before activation</p>
          <script
            type="application/vnd.v-frame"
            data-v-frame-script
            data-v-frame-type="module"
          >
            document.querySelector('#adopted-copy').textContent = 'Prepared by initial module';
            top.__adoptedModuleStarted = true;
            await top.__adoptedModuleGate;
            top.__adoptedModuleFinished = true;
          </script>
        </v-body>
      </v-html>`;
    document.querySelector("#host")?.append(frame);
  });
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);

  await expect.poll(() => page.evaluate(() =>
    (window as Window & typeof globalThis & { __adoptedModuleStarted?: boolean })
      .__adoptedModuleStarted
  )).toBe(true);
  const frame = page.locator("v-frame");
  const staged = await frame.evaluate((element) => {
    const frameElement = element as HTMLElement & { status: string };
    const markup = Array.from(
      frameElement.shadowRoot?.querySelectorAll("v-html") ?? [],
    );
    return {
      connected: markup.map((html) => html.isConnected),
      displays: markup.map((html) => getComputedStyle(html).display),
      copyPointerEvents: markup.map((html) =>
        getComputedStyle(html.querySelector("#adopted-copy")!).pointerEvents
      ),
      copyVisibilities: markup.map((html) =>
        getComputedStyle(html.querySelector("#adopted-copy")!).visibility
      ),
      liveHeight: markup[1]?.getBoundingClientRect().height,
      markupText: markup.map((html) =>
        html.querySelector("#adopted-copy")?.textContent
      ),
      status: frameElement.status,
      styleSheets: frameElement.shadowRoot?.adoptedStyleSheets.length,
      transitionStarts: (window as Window & typeof globalThis & {
        __adoptedTransitionState: { starts: number };
      }).__adoptedTransitionState.starts,
      opacities: markup.map((html) => getComputedStyle(html).opacity),
      visibilities: markup.map((html) => getComputedStyle(html).visibility),
    };
  });
  expect(staged).toEqual({
    connected: [true, true],
    copyPointerEvents: ["auto", "none"],
    copyVisibilities: ["visible", "hidden"],
    displays: ["block", "block"],
    liveHeight: expect.any(Number),
    markupText: [
      "Server-rendered before activation",
      "Prepared by initial module",
    ],
    status: "loading",
    styleSheets: 2,
    transitionStarts: 0,
    opacities: ["1", "0"],
    visibilities: ["visible", "hidden"],
  });
  expect(staged.liveHeight).toBeGreaterThan(0);

  await page.evaluate(() => {
    (window as Window & typeof globalThis & { __releaseAdoptedModule: () => void })
      .__releaseAdoptedModule();
  });
  await expect.poll(() => frame.evaluate((element) =>
    (element as HTMLElement & { status: string }).status
  )).toBe("ready");
  const revealed = await frame.evaluate((element) => {
    const frameElement = element as HTMLElement & { status: string };
    const hostWindow = window as Window & typeof globalThis & {
      __adoptedModuleFinished: boolean;
      __adoptedTransitionState: {
        starts: number;
        transitionSnapshots: Array<{
          liveText: string | null;
          markupCount: number;
          moduleFinished: boolean;
        }>;
      };
    };
    return {
      moduleFinished: hostWindow.__adoptedModuleFinished,
      markupCount: frameElement.shadowRoot?.querySelectorAll("v-html").length,
      text: frameElement.shadowRoot?.querySelector("#adopted-copy")?.textContent,
      styleSheets: frameElement.shadowRoot?.adoptedStyleSheets.length,
      transitionState: hostWindow.__adoptedTransitionState,
    };
  });
  expect(revealed).toEqual({
    moduleFinished: true,
    markupCount: 1,
    text: "Prepared by initial module",
    styleSheets: 1,
    transitionState: {
      starts: 1,
      transitionSnapshots: [{
        liveText: "Prepared by initial module",
        markupCount: 2,
        moduleFinished: true,
      }],
    },
  });
});

test("reveals adopted markup directly when scoped transitions are unavailable", async ({ page }) => {
  await page.goto(fixture.origin);
  await page.evaluate(() => {
    const hostWindow = window as Window & typeof globalThis & {
      __fallbackTransitionStarts?: number;
    };
    hostWindow.__fallbackTransitionStarts = 0;
    const prototype = HTMLElement.prototype as HTMLElement & {
      startViewTransition?: (update: () => void) => ViewTransition;
    };
    prototype.startViewTransition = function startViewTransition(): ViewTransition {
      hostWindow.__fallbackTransitionStarts =
        (hostWindow.__fallbackTransitionStarts ?? 0) + 1;
      throw new Error("The frame should use its direct reveal fallback");
    };

    const frame = document.createElement("v-frame");
    Object.defineProperty(frame, "startViewTransition", {
      configurable: true,
      value: undefined,
    });
    frame.setAttribute("adopt", "");
    frame.setAttribute("src", "/documents/adopted-entry.html");
    frame.attachShadow({ mode: "open" }).innerHTML = `
      <v-html><v-head></v-head><v-body>
        <p id="fallback-copy">Server-rendered fallback</p>
        <script type="application/vnd.v-frame" data-v-frame-script>
          document.querySelector('#fallback-copy').textContent = 'Fallback script complete';
        </script>
      </v-body></v-html>`;
    document.querySelector("#host")?.append(frame);
  });
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);

  const frame = page.locator("v-frame");
  await expect.poll(() => frame.evaluate((element) =>
    (element as HTMLElement & { status: string }).status
  )).toBe("ready");
  const state = await page.evaluate(() => {
    const hostWindow = window as Window & typeof globalThis & {
      __fallbackTransitionStarts: number;
    };
    const frame = document.querySelector("v-frame");
    return {
      markupCount: frame?.shadowRoot?.querySelectorAll("v-html").length,
      text: frame?.shadowRoot?.querySelector("#fallback-copy")?.textContent,
      transitionStarts: hostWindow.__fallbackTransitionStarts,
    };
  });
  expect(state).toEqual({
    markupCount: 1,
    text: "Fallback script complete",
    transitionStarts: 0,
  });
});

test("keeps the adopted preview after a bootstrap navigation failure", async ({ page }) => {
  await page.goto(fixture.origin);
  await page.evaluate(() => {
    const hostWindow = window as Window & typeof globalThis & {
      __adoptedFailureEvents?: string[];
      __adoptedFailureLoads?: number;
      __adoptedFailureTransitions?: number;
    };
    hostWindow.__adoptedFailureEvents = [];
    hostWindow.__adoptedFailureLoads = 0;
    hostWindow.__adoptedFailureTransitions = 0;
    const prototype = HTMLElement.prototype as HTMLElement & {
      startViewTransition?: (update: () => void) => ViewTransition;
    };
    prototype.startViewTransition = function startViewTransition(update): ViewTransition {
      hostWindow.__adoptedFailureTransitions =
        (hostWindow.__adoptedFailureTransitions ?? 0) + 1;
      update();
      return {
        finished: Promise.resolve(),
        ready: Promise.resolve(),
        types: new Set<string>(),
        updateCallbackDone: Promise.resolve(),
        skipTransition() {},
      } as unknown as ViewTransition;
    };

    const frame = document.createElement("v-frame");
    frame.addEventListener("v-frame-error", (event) => {
      const failure = (event as CustomEvent<{ fatal: boolean; phase: string }>).detail;
      if (failure.fatal) {
        hostWindow.__adoptedFailureEvents?.push(failure.phase);
      }
    });
    frame.addEventListener("v-frame-load", () => {
      hostWindow.__adoptedFailureLoads = (hostWindow.__adoptedFailureLoads ?? 0) + 1;
    });
    frame.setAttribute("adopt", "");
    frame.setAttribute("src", "/documents/adopted-entry.html");
    frame.attachShadow({ mode: "open" }).innerHTML = `
      <v-html><v-head></v-head><v-body>
        <p id="failure-preview">Server-rendered failure fallback</p>
        <script type="application/vnd.v-frame" data-v-frame-script>
          location.assign('/documents/second.html');
        </script>
      </v-body></v-html>`;
    document.querySelector("#host")?.append(frame);
  });
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);

  const frame = page.locator("v-frame");
  await expect.poll(() => frame.evaluate((element) =>
    (element as HTMLElement & { status: string }).status
  )).toBe("error");
  const state = await page.evaluate(() => {
    const hostWindow = window as Window & typeof globalThis & {
      __adoptedFailureEvents: string[];
      __adoptedFailureLoads: number;
      __adoptedFailureTransitions: number;
    };
    const frame = document.querySelector("v-frame");
    return {
      failures: hostWindow.__adoptedFailureEvents,
      loads: hostWindow.__adoptedFailureLoads,
      markupCount: frame?.shadowRoot?.querySelectorAll("v-html").length,
      preview: frame?.shadowRoot?.querySelector("#failure-preview")?.textContent,
      transitions: hostWindow.__adoptedFailureTransitions,
    };
  });
  expect(state).toEqual({
    failures: ["navigation"],
    loads: 0,
    markupCount: 1,
    preview: "Server-rendered failure fallback",
    transitions: 0,
  });
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

    let releaseFirstModule = () => undefined;
    const firstModuleGate = new Promise<void>((resolve) => {
      releaseFirstModule = resolve;
    });
    const hostWindow = window as Window & typeof globalThis & {
      __firstModuleGate?: Promise<void>;
      __releaseFirstModule?: () => void;
    };
    hostWindow.__firstModuleGate = firstModuleGate;
    hostWindow.__releaseFirstModule = releaseFirstModule;

    for (const name of ["first", "second"]) {
      const frame = document.createElement("v-frame");
      frame.id = name;
      frame.setAttribute("adopt", "");
      frame.setAttribute("src", `/documents/${name}.html`);
      frame.attachShadow({ mode: "open" }).innerHTML =
        `<v-html><v-head></v-head><v-body><p>${name}</p>${
          name === "first"
            ? `<script type="application/vnd.v-frame" data-v-frame-script data-v-frame-type="module">
                await top.__firstModuleGate;
              </script>`
            : ""
        }</v-body></v-html>`;
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
  )).toEqual(["loading", "ready"]);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & typeof globalThis & { __transitionHosts: HTMLElement[] })
      .__transitionHosts.map((host) => host.id)
  )).toEqual(["second"]);

  await page.evaluate(() => {
    (window as Window & typeof globalThis & { __releaseFirstModule: () => void })
      .__releaseFirstModule();
  });
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
    (window as Window & typeof globalThis & { __heldFrameLoads?: number })
      .__heldFrameLoads = 0;
    frame.addEventListener("v-frame-load", () => {
      const hostWindow = window as Window & typeof globalThis & {
        __heldFrameLoads: number;
      };
      hostWindow.__heldFrameLoads += 1;
    });
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
      loads: (window as Window & typeof globalThis & { __heldFrameLoads: number })
        .__heldFrameLoads,
    };
  })).toEqual({ status: "idle", childElements: 0, loads: 0 });
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
