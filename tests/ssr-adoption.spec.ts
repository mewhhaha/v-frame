import { expect, test } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import type * as TestingModule from "../src/testing";
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
        const outer = document.querySelector<VFrameElement>("#outer-frame");
        const nestedFrames = [
          outer?.shadowRoot?.querySelector<VFrameElement>("#inner-frame"),
          outer?.contentWindow?.document.querySelector<VFrameElement>("#inner-frame"),
        ].filter((frame): frame is VFrameElement => !!frame);
        return {
          outerStatus: (outer as (HTMLElement & { status: string }) | null)?.status,
          nestedFrames: new Set(nestedFrames).size,
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

  // Dogfood @mewhhaha/v-frame/testing during staged SSR adoption: shadowScreen must see
  // only the visible preview (ignoring the hidden data-v-frame-staged clone), and an
  // existing withinFrame(outer) handle must follow the shadowRoot swap after release.
  const testingCheck = await page.evaluate(async (origin) => {
    const { shadowScreen, withinFrame } = (await import(
      `${origin}/dist/testing.js`
    )) as typeof TestingModule;
    const outer = document.querySelector<VFrameElement>("#outer-frame")!;
    const outerQueries = withinFrame(outer);
    const visibleBeforeRelease = shadowScreen.getAllByText(
      "Nested preview activated",
    ).length;

    (
      window as Window & typeof globalThis & { __releaseNestedOuterModule: () => void }
    ).__releaseNestedOuterModule();

    await outerQueries.ready();
    const inner = outerQueries.queryShadow<VFrameElement>("#inner-frame");
    return {
      visibleBeforeRelease,
      outerStatus: outer.status,
      innerStatus: inner?.status,
      nestedFrames: outerQueries.queryAllShadow("#inner-frame").length,
      nestedText: outerQueries.getByText("Nested preview activated").textContent,
    };
  }, fixture.origin);
  expect(testingCheck).toEqual({
    visibleBeforeRelease: 1,
    outerStatus: "ready",
    innerStatus: "ready",
    nestedFrames: 1,
    nestedText: "Nested preview activated",
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
          <input id="quantity" type="number">
          <p id="adopted-copy" style="visibility: visible !important; pointer-events: auto !important">Server-rendered before activation</p>
          <script
            type="application/vnd.v-frame"
            data-v-frame-script
            data-v-frame-type="module"
          >
            document.querySelector('#adopted-copy').textContent = 'Prepared by initial module';
            const sheet = document.querySelector("style").sheet;
            const index = sheet.insertRule("#adopted-copy { letter-spacing: 1px }", sheet.cssRules.length);
            const rule = sheet.cssRules[index];
            window.ownsLiveRule = () => sheet === document.querySelector("style").sheet && sheet.cssRules[index] === rule;
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
    const frameElement = element as VFrameElement;
    const markup = [
      frameElement.shadowRoot!.querySelector("v-html")!,
      frameElement.contentWindow!.document.documentElement,
    ];
    const frameRect = frameElement.getBoundingClientRect();
    const physicalRect = (html: Element) =>
      Element.prototype.getBoundingClientRect.call(html);
    return {
      numberReadOnly: markup.map(
        (html) => html.querySelector<HTMLInputElement>("#quantity")!.readOnly,
      ),
      connected: markup.map((html) => html.isConnected),
      displays: markup.map((html) => getComputedStyle(html).display),
      liveOverlaysPreview: physicalRect(markup[1]!).top === physicalRect(markup[0]!).top,
      frameHeight: frameRect.height,
      hitPreview: (() => {
        const copy = markup[0]!.querySelector("#adopted-copy")!;
        const box = physicalRect(copy);
        return frameElement.shadowRoot!.elementFromPoint(box.x + 1, box.y + 1) === copy;
      })(),
      liveHeight: physicalRect(markup[1]!).height,
      markupText: markup.map((html) => html.querySelector("#adopted-copy")?.textContent),
      status: frameElement.status,
      separateTrees:
        Node.prototype.getRootNode.call(markup[0]) !==
        Node.prototype.getRootNode.call(markup[1]),
    };
  });
  expect(staged).toEqual({
    numberReadOnly: [true, false],
    connected: [true, true],
    hitPreview: true,
    displays: ["block", "block"],
    liveOverlaysPreview: true,
    frameHeight: expect.any(Number),
    liveHeight: expect.any(Number),
    markupText: ["Server-rendered before activation", "Prepared by initial module"],
    status: "loading",
    separateTrees: true,
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
      height: frameElement.getBoundingClientRect().height,
      moduleFinished: hostWindow.__adoptedModuleFinished,
      markupCount: frameElement.shadowRoot?.querySelectorAll("v-html").length,
      text: frameElement.shadowRoot?.querySelector("#adopted-copy")?.textContent,
      retainedRule: (
        (element as VFrameElement).contentWindow as Window & { ownsLiveRule(): boolean }
      ).ownsLiveRule(),
    };
  });
  expect(revealed).toEqual({
    height: staged.frameHeight,
    moduleFinished: true,
    markupCount: 1,
    text: "Prepared by initial module",
    retainedRule: true,
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
  ).toEqual([1, 1]);

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

test("keeps native disclosure groups independent while the adopted copy is staged", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  await page.evaluate(async (url) => {
    const frame = document.createElement("v-frame");
    frame.setAttribute("adopt", "");
    frame.setAttribute("src", "/flight/");
    frame.attachShadow({ mode: "open" }).innerHTML = `
      <v-html><v-head><style>[name="flight"] summary { color: rgb(4, 75, 90) }</style></v-head>
      <v-body>
        <details name="flight" open><summary>Landing</summary>Touchdown</details>
        <details name="flight"><summary>Launch</summary>Liftoff</details>
        <script type="application/vnd.v-frame" data-v-frame-script data-v-frame-type="module">
          top.initialOpen = document.querySelector('details[name="flight"]').open;
          await new Promise(resolve => { top.finishDisclosure = resolve; });
        </script>
      </v-body></v-html>`;
    document.body.append(frame);
    (await import(url)).defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  await page.waitForFunction(
    () => typeof (window as any).finishDisclosure === "function",
  );
  const trees = page.locator("v-frame v-html");
  const visible = trees.first();
  await expect(visible.locator("details[open] summary")).toHaveText("Landing");
  await expect(visible.locator("summary").first()).toHaveCSS("color", "rgb(4, 75, 90)");
  expect(await page.evaluate(() => (window as any).initialOpen)).toBe(true);
  await visible.getByText("Launch").click();
  await expect(visible.locator("details[open] summary")).toHaveText("Launch");
  await page.evaluate(() => (window as any).finishDisclosure());
  const ready = page.locator("v-frame:state(ready)");
  await expect(ready.locator("details[open] summary")).toHaveText("Launch");
  await expect(ready.locator('details[name="flight"]')).toHaveCount(2);
  await expect(ready.locator("summary").last()).toHaveCSS("color", "rgb(4, 75, 90)");
});

test("restores the original scroll panel and the latest preview edits after a guest reorder", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  await page.evaluate(async (url) => {
    const frame = document.createElement("v-frame");
    frame.setAttribute("adopt", "");
    frame.setAttribute("src", "/panels/");
    frame.attachShadow({ mode: "open" }).innerHTML = `<v-html><v-head><style>
      section { display:block; overflow:auto; height:40px } section p { height:300px }
    </style></v-head><v-body>
      <section id="notes"><p>Notes</p></section><section id="archive"><p>Archive</p></section>
      <details open><summary>Instructions</summary>Read me</details>
      <label><input type="checkbox">Reviewed</label>
      <script type="application/vnd.v-frame" data-v-frame-script data-v-frame-type="module">
        document.querySelector("#notes").before(document.querySelector("#archive"));
        await new Promise(resolve => { top.finishPanels = resolve; });
      </script></v-body></v-html>`;
    document.body.append(frame);
    (await import(url)).defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  await page.waitForFunction(() => typeof (window as any).finishPanels === "function");
  const preview = page.locator("v-frame v-html").first();
  await preview.locator("#notes").evaluate((element) => {
    element.scrollTop = 75;
  });
  // The checkbox edit synchronizes the closed disclosure before the user reopens it.
  await preview.locator("summary").click();
  await preview.getByRole("checkbox").check();
  await preview.locator("summary").click();
  await page.evaluate(() => (window as any).finishPanels());
  const ready = page.locator("v-frame:state(ready)");
  await expect(ready).toHaveCount(1);
  expect(
    await ready
      .locator("section")
      .evaluateAll((elements) =>
        elements.map((element) => [element.id, element.scrollTop]),
      ),
  ).toEqual([
    ["archive", 0],
    ["notes", 75],
  ]);
  await expect(ready.locator("details")).toHaveAttribute("open", "");
  await expect(ready.getByRole("checkbox")).toBeChecked();
  await expect(ready.getByRole("checkbox")).not.toHaveAttribute("value", /.*/);
});
