import { expect, test } from "@playwright/test";
import { type FixtureServer, startFixtureServer } from "./support/fixture-server";

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture.close();
});

test("adopts server-rendered shadow content without fetching the entry document", async ({
  page,
}) => {
  await page.goto(`${fixture.origin}/documents/adopted-host.html`);
  const frame = page.locator("v-frame");

  await expect(frame.locator("#adopted-copy")).toHaveText(
    "Server-rendered before definition",
  );
  await expect(frame.locator("#adopted-copy")).toHaveCSS("color", "rgb(24, 96, 48)");
  expect(
    fixture.requests.filter((path) => path === "/documents/adopted-entry.html"),
  ).toHaveLength(0);

  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);

  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");
  await expect(frame.locator("#adopted-copy")).toHaveText(
    "Activated without an entry fetch",
  );
  expect(
    fixture.requests.filter((path) => path === "/documents/adopted-entry.html"),
  ).toHaveLength(0);
  await expect
    .poll(() => frame.evaluate((element) => (element as any).currentURL))
    .toBe(`${fixture.origin}/documents/adopted-entry.html`);

  await frame.evaluate((element) => (element as any).reload());
  await expect(frame.locator("#network-reload")).toHaveText("Fetched by reload");
  expect(
    fixture.requests.filter((path) => path === "/documents/adopted-entry.html"),
  ).toHaveLength(1);
});

test("preserves nested adopted frames without fetching either entry document", async ({
  page,
}) => {
  const outerRequestsBefore = fixture.requests.filter(
    (path) => path === "/documents/outer-adopted-entry.html",
  ).length;
  const innerRequestsBefore = fixture.requests.filter(
    (path) => path === "/documents/inner-adopted-entry.html",
  ).length;
  await page.goto(`${fixture.origin}/documents/nested-adopted-host.html`);
  await page.evaluate(() => {
    let releaseOuterModule: () => void = () => undefined;
    const outerModuleGate = new Promise<void>((resolve) => {
      releaseOuterModule = resolve;
    });
    const hostWindow = window as Window &
      typeof globalThis & {
        __nestedOuterModuleGate?: Promise<void>;
        __nestedOuterModuleStarted?: boolean;
        __releaseNestedOuterModule?: () => void;
      };
    hostWindow.__nestedOuterModuleGate = outerModuleGate;
    hostWindow.__nestedOuterModuleStarted = false;
    hostWindow.__releaseNestedOuterModule = releaseOuterModule;
  });

  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as Window &
              typeof globalThis & { __nestedOuterModuleStarted?: boolean }
          ).__nestedOuterModuleStarted,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const outer = document.querySelector("#outer-frame");
        const nestedFrames = Array.from(
          outer?.shadowRoot?.querySelectorAll("#inner-frame") ?? [],
        ) as Array<HTMLElement & { status: string }>;
        return {
          outerStatus: (outer as (HTMLElement & { status: string }) | null)?.status,
          nestedFrames: nestedFrames.length,
          nestedStatuses: nestedFrames.map((frame) => frame.status),
          nestedText: nestedFrames.map(
            (frame) => frame.shadowRoot?.querySelector("#nested-copy")?.textContent,
          ),
        };
      }),
    )
    .toEqual({
      outerStatus: "loading",
      nestedFrames: 2,
      nestedStatuses: ["ready", "ready"],
      nestedText: ["Nested preview activated", "Nested preview activated"],
    });
  expect(
    fixture.requests.filter((path) => path === "/documents/outer-adopted-entry.html"),
  ).toHaveLength(outerRequestsBefore);
  expect(
    fixture.requests.filter((path) => path === "/documents/inner-adopted-entry.html"),
  ).toHaveLength(innerRequestsBefore);

  await page.evaluate(() => {
    (
      window as Window & typeof globalThis & { __releaseNestedOuterModule: () => void }
    ).__releaseNestedOuterModule();
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const outer = document.querySelector("#outer-frame") as
          | (HTMLElement & { status: string })
          | null;
        const inner = outer?.shadowRoot?.querySelector("#inner-frame") as
          | (HTMLElement & { status: string })
          | null;
        return {
          innerStatus: inner?.status,
          nestedFrames: outer?.shadowRoot?.querySelectorAll("#inner-frame").length,
          nestedText: inner?.shadowRoot?.querySelector("#nested-copy")?.textContent,
          outerStatus: outer?.status,
        };
      }),
    )
    .toEqual({
      innerStatus: "ready",
      nestedFrames: 1,
      nestedText: "Nested preview activated",
      outerStatus: "ready",
    });
});

test("keeps adopted preview visible until its initial module completes", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  await page.evaluate(() => {
    let releaseModule: () => void = () => undefined;
    const moduleGate = new Promise<void>((resolve) => {
      releaseModule = resolve;
    });
    const hostWindow = window as Window &
      typeof globalThis & {
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

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & typeof globalThis & { __adoptedModuleStarted?: boolean })
            .__adoptedModuleStarted,
      ),
    )
    .toBe(true);
  const frame = page.locator("v-frame");
  const staged = await frame.evaluate((element) => {
    const frameElement = element as HTMLElement & { status: string };
    const markup = Array.from(frameElement.shadowRoot?.querySelectorAll("v-html") ?? []);
    const frameRect = frameElement.getBoundingClientRect();
    const physicalRect = (html: Element) =>
      Element.prototype.getBoundingClientRect.call(html);
    return {
      connected: markup.map((html) => html.isConnected),
      displays: markup.map((html) => getComputedStyle(html).display),
      // The staging armor only overlays the two trees if its `display: grid`
      // rule matches the host, which needs the functional `:host(...)` form —
      // a bare `:host:not(...)` never matches the featureless shadow host.
      hostDisplay: getComputedStyle(frameElement).display,
      liveOverlaysPreview: physicalRect(markup[1]!).top === physicalRect(markup[0]!).top,
      frameHeightMatchesPreview: frameRect.height === physicalRect(markup[0]!).height,
      copyPointerEvents: markup.map(
        (html) => getComputedStyle(html.querySelector("#adopted-copy")!).pointerEvents,
      ),
      copyVisibilities: markup.map(
        (html) => getComputedStyle(html.querySelector("#adopted-copy")!).visibility,
      ),
      liveHeight: physicalRect(markup[1]!).height,
      markupText: markup.map((html) => html.querySelector("#adopted-copy")?.textContent),
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
    hostDisplay: "grid",
    liveOverlaysPreview: true,
    frameHeightMatchesPreview: true,
    liveHeight: expect.any(Number),
    markupText: ["Server-rendered before activation", "Prepared by initial module"],
    status: "loading",
    styleSheets: 2,
    opacities: ["1", "0"],
    visibilities: ["visible", "hidden"],
  });
  expect(staged.liveHeight).toBeGreaterThan(0);

  await page.evaluate(() => {
    (
      window as Window & typeof globalThis & { __releaseAdoptedModule: () => void }
    ).__releaseAdoptedModule();
  });
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as HTMLElement & { status: string }).status),
    )
    .toBe("ready");
  const revealed = await frame.evaluate((element) => {
    const frameElement = element as HTMLElement & { status: string };
    const hostWindow = window as Window &
      typeof globalThis & {
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

test("reveals adopted markup synchronously without starting a view transition", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  await page.evaluate(() => {
    const hostWindow = window as Window &
      typeof globalThis & {
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
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as HTMLElement & { status: string }).status),
    )
    .toBe("ready");
  const state = await page.evaluate(() => {
    const hostWindow = window as Window &
      typeof globalThis & {
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

test("reveals simultaneous adopted handoffs independently", async ({ page }) => {
  await page.goto(fixture.origin);
  await page.evaluate(() => {
    let releaseFirstModule: () => void = () => undefined;
    const firstModuleGate = new Promise<void>((resolve) => {
      releaseFirstModule = resolve;
    });
    const hostWindow = window as Window &
      typeof globalThis & {
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
      frame.attachShadow({
        mode: "open",
      }).innerHTML = `<v-html><v-head></v-head><v-body><p>${name}</p>${
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
  await expect
    .poll(() =>
      frames.evaluateAll((elements) =>
        elements.map((element) => (element as HTMLElement & { status: string }).status),
      ),
    )
    .toEqual(["loading", "ready"]);
  expect(
    await frames.evaluateAll((elements) =>
      elements.map((element) => element.shadowRoot?.querySelectorAll("v-html").length),
    ),
  ).toEqual([2, 1]);

  await page.evaluate(() => {
    (
      window as Window & typeof globalThis & { __releaseFirstModule: () => void }
    ).__releaseFirstModule();
  });
  await expect
    .poll(() =>
      frames.evaluateAll((elements) =>
        elements.map((element) => (element as HTMLElement & { status: string }).status),
      ),
    )
    .toEqual(["ready", "ready"]);
  expect(
    await frames.evaluateAll((elements) =>
      elements.map((element) => element.shadowRoot?.querySelectorAll("v-html").length),
    ),
  ).toEqual([1, 1]);
});

test("does not restore adopted markup after removal during activation", async ({
  page,
}) => {
  const entryRequestsBefore = fixture.requests.filter(
    (path) => path === "/documents/adopted-entry.html",
  ).length;
  await page.goto(fixture.origin);
  await page.evaluate(() => {
    let releaseHeldModule: () => void = () => undefined;
    const heldModuleGate = new Promise<void>((resolve) => {
      releaseHeldModule = resolve;
    });
    const hostWindow = window as Window &
      typeof globalThis & {
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
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & typeof globalThis & { __heldModuleStarted?: boolean })
            .__heldModuleStarted,
      ),
    )
    .toBe(true);

  await page.evaluate(() => {
    const hostWindow = window as Window &
      typeof globalThis & {
        __heldFrame: HTMLElement;
        __releaseHeldModule: () => void;
      };
    hostWindow.__heldFrame.remove();
    hostWindow.__releaseHeldModule();
  });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const frame = (
          window as Window &
            typeof globalThis & {
              __heldFrame: HTMLElement & { status: string };
            }
        ).__heldFrame;
        return {
          status: frame.status,
          childElements: frame.shadowRoot?.children.length,
          loads: (window as Window & typeof globalThis & { __heldFrameLoads: number })
            .__heldFrameLoads,
        };
      }),
    )
    .toEqual({ status: "idle", childElements: 0, loads: 0 });
  expect(
    fixture.requests.filter((path) => path === "/documents/adopted-entry.html"),
  ).toHaveLength(entryRequestsBefore);
});

test("host page reload leaves active adopted frames intact until teardown", async ({
  page,
}) => {
  await page.goto(`${fixture.origin}/documents/adopted-host.html`);
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  const frame = page.locator("v-frame");
  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");

  const reportStart = fixture.teardownReports.length;
  await page.evaluate(() => {
    const report = (message: string) =>
      navigator.sendBeacon(`/teardown-report?report=${encodeURIComponent(message)}`, "");
    window.addEventListener(
      "v-frame-error",
      (event) => {
        const detail = (event as CustomEvent<{ phase: string; fatal: boolean }>).detail;
        report(`v-frame-teardown: error phase=${detail.phase} fatal=${detail.fatal}`);
      },
      true,
    );
    window.addEventListener("pagehide", () => {
      const copyIntact = Boolean(
        document.querySelector("v-frame")?.shadowRoot?.querySelector("#adopted-copy"),
      );
      report(`v-frame-teardown: pagehide copyIntact=${copyIntact}`);
    });
  });
  await page.reload({ waitUntil: "load" });

  await expect
    .poll(() => fixture.teardownReports.slice(reportStart))
    .toEqual(["v-frame-teardown: pagehide copyIntact=true"]);
});
