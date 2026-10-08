import { expect, test, type Locator, type Page } from "@playwright/test";
import { type FixtureServer, startFixtureServer } from "./support/fixture-server";
import { childValue } from "./support/guest-frames";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture.close();
});

function mountDocument(page: Page, path: string): Promise<Locator> {
  return mountFrame(page, { src: `${fixture.origin}${path}`, settle: "none" });
}

function mountSourceFrame(page: Page, source: string): Promise<Locator> {
  return mountFrame(page, { src: source, settle: "none" });
}

test("importing the bundle has no registration side effect and defineVFrame is guarded", async ({
  page,
  browser,
}) => {
  await page.goto(fixture.origin);
  expect(await page.evaluate(() => customElements.get("v-frame"))).toBeUndefined();

  const registration = await page.evaluate(async (url) => {
    const bundle = await import(url);
    const before = Boolean(customElements.get("v-frame"));
    const first = bundle.defineVFrame();
    const second = bundle.defineVFrame();
    return {
      before,
      sameConstructor: first === second,
      registered: customElements.get("v-frame") === bundle.VFrameElement,
    };
  }, `${fixture.origin}/dist/index.js`);
  expect(registration).toEqual({
    before: false,
    sameConstructor: true,
    registered: true,
  });

  const collisionPage = await browser.newPage();
  try {
    await collisionPage.goto(fixture.origin);
    await collisionPage.evaluate(() =>
      customElements.define("v-frame", class extends HTMLElement {}),
    );
    await expect(
      collisionPage.evaluate(
        async (url) => (await import(url)).defineVFrame(),
        `${fixture.origin}/dist/index.js`,
      ),
    ).rejects.toThrow();
  } finally {
    await collisionPage.close();
  }
});

test("loads a document into a semantic shadow DOM and exposes readonly state", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountSourceFrame(page, `${fixture.origin}/documents/first.html`);

  await expect
    .poll(() =>
      frame.evaluate((element) => (element as HTMLElement & { status: string }).status),
    )
    .toBe("ready");
  await expect(frame.locator("main#first")).toContainText("First document");
  await expect(frame.locator("v-html > v-head")).toHaveCount(1);
  await expect(frame.locator("v-html > v-body")).toHaveCount(1);
  await expect(frame.locator("iframe")).toHaveCount(1);
  await expect(frame.locator("iframe")).toHaveAttribute("aria-hidden", "true");
  await expect(frame.locator("iframe")).toHaveCSS("opacity", "0");
  await expect(frame.locator("iframe")).toHaveCSS("pointer-events", "none");

  const state = await frame.evaluate((element) => {
    const value = element as HTMLElement & {
      currentURL: string;
      contentWindow: (Window & typeof globalThis) | null;
    };
    return {
      currentURL: value.currentURL,
      hasContentWindow: value.contentWindow !== null,
    };
  });
  expect(state.currentURL).toBe(`${fixture.origin}/documents/first.html`);
  expect(state.hasContentWindow).toBe(true);
});

test("resolves bare module specifiers through a document import map", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountSourceFrame(
    page,
    `${fixture.origin}/documents/import-map.html`,
  );

  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");
  await expect(frame.locator("#import-map-result")).toHaveText(
    "resolved through import map",
  );
});

test("keeps child custom element definitions isolated between frames", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await page.evaluate((origin) => {
    for (const label of ["first child", "second child"]) {
      const frame = document.createElement("v-frame");
      frame.setAttribute(
        "src",
        `${origin}/documents/child-custom-elements.html?label=${encodeURIComponent(label)}`,
      );
      document.querySelector("#host")?.append(frame);
    }
  }, fixture.origin);
  const frames = page.locator("v-frame");

  await expect
    .poll(() =>
      frames.evaluateAll((elements) =>
        elements.map((element) => (element as HTMLElement & { status: string }).status),
      ),
    )
    .toEqual(["ready", "ready"]);
  await expect(frames.nth(0).locator("#dynamic")).toHaveText("first child");
  await expect(frames.nth(0).locator("#parsed")).toHaveText("first child");
  await expect(frames.nth(1).locator("#dynamic")).toHaveText("second child");
  await expect(frames.nth(1).locator("#parsed")).toHaveText("second child");

  expect(
    await frames.evaluateAll((elements) => {
      type ChildWindow = Window &
        typeof globalThis & {
          __childCustomElementState: {
            dynamic: boolean;
            parsed: boolean;
            ownerDocument: boolean;
          };
        };
      const first = (elements[0] as HTMLElement & { contentWindow: ChildWindow })
        .contentWindow;
      const second = (elements[1] as HTMLElement & { contentWindow: ChildWindow })
        .contentWindow;
      return {
        firstState: first.__childCustomElementState,
        secondState: second.__childCustomElementState,
        isolatedConstructors:
          first.customElements.get("child-greeting") !==
          second.customElements.get("child-greeting"),
        absentFromHost: customElements.get("child-greeting") === undefined,
      };
    }),
  ).toEqual({
    firstState: { dynamic: true, parsed: true, ownerDocument: true },
    secondState: { dynamic: true, parsed: true, ownerDocument: true },
    isolatedConstructors: true,
    absentFromHost: true,
  });
});

test("emits lifecycle errors and ignores stale loads after disconnection", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const events = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & { reload(): void };
    const seen: string[] = [];
    for (const name of ["v-frame-loadstart", "v-frame-load", "v-frame-error"])
      frame.addEventListener(name, () => seen.push(name));
    document.body.append(frame);
    frame.setAttribute("src", `${origin}/documents/first.html`);
    await new Promise((resolve) =>
      frame.addEventListener("v-frame-load", resolve, { once: true }),
    );
    const reloaded = new Promise((resolve) =>
      frame.addEventListener("v-frame-load", resolve, { once: true }),
    );
    frame.reload();
    await reloaded;
    frame.setAttribute("src", `${origin}/documents/broken.html`);
    await new Promise((resolve) =>
      frame.addEventListener("v-frame-error", resolve, { once: true }),
    );
    frame.setAttribute("src", `${origin}/documents/second.html`);
    frame.remove();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return seen;
  }, fixture.origin);

  expect(events).toEqual(
    expect.arrayContaining(["v-frame-loadstart", "v-frame-load", "v-frame-error"]),
  );
  await expect(page.locator("v-frame")).toHaveCount(0);
});

test("bridges document scripts, rewritten CSS, and relative assets", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const scripted = await mountSourceFrame(
    page,
    `${fixture.origin}/documents/scripted.html`,
  );
  await expect(scripted.locator("#script-added")).toHaveText("Script executed");

  const styled = await mountSourceFrame(page, `${fixture.origin}/documents/styled.html`);
  await expect(styled.locator("#relative-image")).toHaveCount(1);
  await expect(styled.locator("#styled-copy")).toHaveCSS("color", "rgb(12, 34, 56)");
  await expect
    .poll(() => fixture.requests.filter((path) => path === "/assets/pixel.png").length)
    .toBeGreaterThan(0);
});

test("forwards fetch-driven DOM changes and iframe history navigation", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountSourceFrame(
    page,
    `${fixture.origin}/documents/application.html`,
  );
  await expect(frame.locator("#load")).toHaveCount(1);
  await frame.evaluate((element) =>
    (element as any).contentWindow.document.querySelector("#load").click(),
  );
  await expect(frame.locator("#result")).toHaveText("Fetched from fixture");

  const navigated = page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        document.querySelector("v-frame")?.addEventListener(
          "v-frame-navigate",
          (event) => {
            resolve((event as CustomEvent<{ to?: string }>).detail?.to ?? "");
          },
          { once: true },
        );
      }),
  );
  await frame.evaluate((element) =>
    (element as any).contentWindow.document.querySelector("#push").click(),
  );
  await expect
    .poll(async () => await frame.evaluate((element) => (element as any).currentURL))
    .toContain("history-state");
  await expect(navigated).resolves.toContain("history-state");
});

test("applies properties assigned before upgrade through their setters", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  const result = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      src: string;
      status: string;
      trustedTypesPolicy: {
        name: string;
        createHTML(source: string): string;
        createScript(source: string): string;
        createScriptURL(source: string): string;
      };
    };
    const trustedTypesPolicy = {
      name: "pre-upgrade-frame",
      createHTML: (source: string) => source,
      createScript: (source: string) => source,
      createScriptURL: (source: string) => source,
    };
    frame.trustedTypesPolicy = trustedTypesPolicy;
    frame.src = `${origin}/documents/first.html`;
    document.querySelector("#host")?.append(frame);

    const bundle = await import(`${origin}/dist/index.js`);
    bundle.defineVFrame();

    const loaded = new Promise<void>((resolve) => {
      frame.addEventListener("v-frame-load", () => resolve(), { once: true });
    });
    const reflected = {
      src: frame.getAttribute("src"),
      ownSrc: Object.prototype.hasOwnProperty.call(frame, "src"),
      policyPreserved: frame.trustedTypesPolicy === trustedTypesPolicy,
      ownPolicy: Object.prototype.hasOwnProperty.call(frame, "trustedTypesPolicy"),
    };
    await loaded;
    return { ...reflected, status: frame.status };
  }, fixture.origin);

  expect(result).toEqual({
    src: `${fixture.origin}/documents/first.html`,
    ownSrc: false,
    policyPreserved: true,
    ownPolicy: false,
    status: "ready",
  });
});

test("keeps noscript content inert while scripts run", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const frame = await mountSourceFrame(page, `${fixture.origin}/documents/noscript.html`);
  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");

  await expect(frame.locator("#noscript-copy")).toHaveText("Scripted");
  await expect(frame.locator("#noscript-fallback")).toHaveCount(0);
  await expect(frame.locator("#noscript-copy")).toHaveCSS("color", "rgb(0, 0, 0)");
  const noscriptTexts = await frame.evaluate((element) =>
    Array.from(
      (element as any).contentWindow.document.querySelectorAll("noscript"),
      (noscript) => (noscript as HTMLElement).textContent ?? "",
    ).join(" "),
  );
  expect(noscriptTexts).toContain("noscript-fallback");
  expect(noscriptTexts).toContain("#noscript-copy");
  expect(fixture.requests).not.toContain("/assets/noscript-only.css");
});

test("loads a network v-frame nested inside a child document", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const outerFrame = await mountDocument(page, "/documents/nested-network.html");
  const innerFrame = outerFrame.locator("#nested-network-frame");

  await expect
    .poll(() =>
      innerFrame.evaluate(
        (element) => (element as HTMLElement & { status: string }).status,
      ),
    )
    .toBe("ready");
  await expect(innerFrame.locator("#nested-network-copy")).toHaveText(
    "Nested network frame loaded",
  );
});

test("reflects the nonce property and attribute", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/nonce.html`,
    nonce: "first-nonce",
    settle: "none",
  });

  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");
  await expect(frame).toHaveAttribute("nonce", "first-nonce");
  expect(await frame.evaluate((element) => (element as HTMLScriptElement).nonce)).toBe(
    "first-nonce",
  );
  await frame.evaluate((element) => element.setAttribute("nonce", "second-nonce"));
  expect(await frame.evaluate((element) => (element as HTMLScriptElement).nonce)).toBe(
    "second-nonce",
  );
});

test("forwards bubbling child-realm scroll events from document to window", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/scroll-events.html");
  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");

  await childValue(frame, (window) => {
    const events: Array<{
      listener: string;
      childRealm: boolean;
      target: boolean;
      currentTarget: boolean;
      bubbles: boolean;
    }> = [];
    window.document.addEventListener("scroll", (event) => {
      events.push({
        listener: "document",
        childRealm: event instanceof window.Event,
        target: event.target === window.document,
        currentTarget: event.currentTarget === window.document,
        bubbles: event.bubbles,
      });
    });
    window.addEventListener("scroll", (event) => {
      events.push({
        listener: "window",
        childRealm: event instanceof window.Event,
        target: event.target === window.document,
        currentTarget: event.currentTarget === window,
        bubbles: event.bubbles,
      });
    });
    (
      window as Window & typeof globalThis & { __viewportScrollEvents: typeof events }
    ).__viewportScrollEvents = events;
  });
  await frame.evaluate((element) => {
    element.setAttribute("style", "height: 100px;");
    element.scrollTop = 40;
  });
  await expect
    .poll(() =>
      childValue(
        frame,
        (window) =>
          (window as Window & typeof globalThis & { __viewportScrollEvents: unknown[] })
            .__viewportScrollEvents,
      ),
    )
    .toEqual([
      {
        listener: "document",
        childRealm: true,
        target: true,
        currentTarget: true,
        bubbles: true,
      },
      {
        listener: "window",
        childRealm: true,
        target: true,
        currentTarget: true,
        bubbles: true,
      },
    ]);
});
