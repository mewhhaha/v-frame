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
    const hostWindow = window as Window & typeof globalThis & {
      __adoptedModuleFinished?: boolean;
      __adoptedModuleGate?: Promise<void>;
      __adoptedModuleStarted?: boolean;
      __releaseAdoptedModule?: () => void;
    };
    hostWindow.__adoptedModuleFinished = false;
    hostWindow.__adoptedModuleGate = moduleGate;
    hostWindow.__adoptedModuleStarted = false;
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
    const frameRect = frameElement.getBoundingClientRect();
    return {
      connected: markup.map((html) => html.isConnected),
      displays: markup.map((html) => getComputedStyle(html).display),
      liveOverlaysPreview:
        markup[1].getBoundingClientRect().top === markup[0].getBoundingClientRect().top,
      frameHeightMatchesPreview:
        frameRect.height === markup[0].getBoundingClientRect().height,
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
      opacities: markup.map((html) => getComputedStyle(html).opacity),
      visibilities: markup.map((html) => getComputedStyle(html).visibility),
    };
  });
  expect(staged).toEqual({
    connected: [true, true],
    copyPointerEvents: ["auto", "none"],
    copyVisibilities: ["visible", "hidden"],
    displays: ["block", "block"],
    liveOverlaysPreview: true,
    frameHeightMatchesPreview: true,
    liveHeight: expect.any(Number),
    markupText: [
      "Server-rendered before activation",
      "Prepared by initial module",
    ],
    status: "loading",
    styleSheets: 2,
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
    };
    return {
      moduleFinished: hostWindow.__adoptedModuleFinished,
      markupCount: frameElement.shadowRoot?.querySelectorAll("v-html").length,
      text: frameElement.shadowRoot?.querySelector("#adopted-copy")?.textContent,
      styleSheets: frameElement.shadowRoot?.adoptedStyleSheets.length,
    };
  });
  expect(revealed).toEqual({
    moduleFinished: true,
    markupCount: 1,
    text: "Prepared by initial module",
    styleSheets: 1,
  });
});

test("reveals adopted markup synchronously without starting a view transition", async ({ page }) => {
  await page.goto(fixture.origin);
  await page.evaluate(() => {
    const hostWindow = window as Window & typeof globalThis & {
      __revealTransitionStarts?: number;
    };
    hostWindow.__revealTransitionStarts = 0;
    const prototype = HTMLElement.prototype as HTMLElement & {
      startViewTransition?: (update: () => void) => ViewTransition;
    };
    prototype.startViewTransition = function startViewTransition(): ViewTransition {
      hostWindow.__revealTransitionStarts =
        (hostWindow.__revealTransitionStarts ?? 0) + 1;
      throw new Error("The adopted reveal must not start a view transition");
    };

    const frame = document.createElement("v-frame");
    frame.setAttribute("adopt", "");
    frame.setAttribute("src", "/documents/adopted-entry.html");
    frame.attachShadow({ mode: "open" }).innerHTML = `
      <v-html><v-head></v-head><v-body>
        <p id="reveal-copy">Server-rendered before reveal</p>
        <script type="application/vnd.v-frame" data-v-frame-script>
          document.querySelector('#reveal-copy').textContent = 'Reveal script complete';
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
      __revealTransitionStarts: number;
    };
    const frame = document.querySelector("v-frame");
    return {
      markupCount: frame?.shadowRoot?.querySelectorAll("v-html").length,
      text: frame?.shadowRoot?.querySelector("#reveal-copy")?.textContent,
      transitionStarts: hostWindow.__revealTransitionStarts,
    };
  });
  expect(state).toEqual({
    markupCount: 1,
    text: "Reveal script complete",
    transitionStarts: 0,
  });
});

test("keeps the adopted preview after a bootstrap navigation failure", async ({ page }) => {
  await page.goto(fixture.origin);
  await page.evaluate(() => {
    const hostWindow = window as Window & typeof globalThis & {
      __adoptedFailureEvents?: string[];
      __adoptedFailureLoads?: number;
    };
    hostWindow.__adoptedFailureEvents = [];
    hostWindow.__adoptedFailureLoads = 0;

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
    };
    const frame = document.querySelector("v-frame");
    return {
      failures: hostWindow.__adoptedFailureEvents,
      loads: hostWindow.__adoptedFailureLoads,
      markupCount: frame?.shadowRoot?.querySelectorAll("v-html").length,
      preview: frame?.shadowRoot?.querySelector("#failure-preview")?.textContent,
    };
  });
  expect(state).toEqual({
    failures: ["navigation"],
    loads: 0,
    markupCount: 1,
    preview: "Server-rendered failure fallback",
  });
});

test("reveals simultaneous adopted handoffs independently", async ({ page }) => {
  await page.goto(fixture.origin);
  await page.evaluate(() => {
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
  expect(await frames.evaluateAll((elements) =>
    elements.map((element) => element.shadowRoot?.querySelectorAll("v-html").length)
  )).toEqual([2, 1]);

  await page.evaluate(() => {
    (window as Window & typeof globalThis & { __releaseFirstModule: () => void })
      .__releaseFirstModule();
  });
  await expect.poll(() => frames.evaluateAll((elements) =>
    elements.map((element) => (element as HTMLElement & { status: string }).status)
  )).toEqual(["ready", "ready"]);
  expect(await frames.evaluateAll((elements) =>
    elements.map((element) => element.shadowRoot?.querySelectorAll("v-html").length)
  )).toEqual([1, 1]);
});

test("does not restore adopted markup after removal during activation", async ({ page }) => {
  const entryRequestsBefore = fixture.requests.filter(
    (path) => path === "/documents/adopted-entry.html",
  ).length;
  await page.goto(fixture.origin);
  await page.evaluate(() => {
    let releaseHeldModule = () => undefined;
    const heldModuleGate = new Promise<void>((resolve) => {
      releaseHeldModule = resolve;
    });
    const hostWindow = window as Window & typeof globalThis & {
      __heldFrame?: HTMLElement;
      __heldFrameLoads?: number;
      __heldModuleGate?: Promise<void>;
      __heldModuleStarted?: boolean;
      __releaseHeldModule?: () => void;
    };
    hostWindow.__heldFrameLoads = 0;
    hostWindow.__heldModuleGate = heldModuleGate;
    hostWindow.__heldModuleStarted = false;
    hostWindow.__releaseHeldModule = releaseHeldModule;

    const frame = document.createElement("v-frame");
    frame.addEventListener("v-frame-load", () => {
      hostWindow.__heldFrameLoads = (hostWindow.__heldFrameLoads ?? 0) + 1;
    });
    frame.setAttribute("adopt", "");
    frame.setAttribute("src", "/documents/adopted-entry.html");
    frame.attachShadow({ mode: "open" }).innerHTML = `
      <v-html><v-head></v-head><v-body>
        <p id="held-preview">Server-rendered before removal</p>
        <script type="application/vnd.v-frame" data-v-frame-script data-v-frame-type="module">
          top.__heldModuleStarted = true;
          await top.__heldModuleGate;
        </script>
      </v-body></v-html>`;
    hostWindow.__heldFrame = frame;
    document.querySelector("#host")?.append(frame);
  });
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  await expect.poll(() => page.evaluate(() =>
    (window as Window & typeof globalThis & { __heldModuleStarted?: boolean })
      .__heldModuleStarted
  )).toBe(true);

  await page.evaluate(() => {
    const hostWindow = window as Window & typeof globalThis & {
      __heldFrame: HTMLElement;
      __releaseHeldModule: () => void;
    };
    hostWindow.__heldFrame.remove();
    hostWindow.__releaseHeldModule();
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
