import { auditAccessibility } from "../../../tests/support/accessibility";
import { expect, test, type Locator, type Page } from "@playwright/test";

interface ProbeResult {
  paints: number;
  faults: string[];
}
type ProbeWindow = Window &
  typeof globalThis & { paintProbe: ProbeResult; stopPaintProbe(): ProbeResult };
const pages = [
  {
    path: "/",
    id: "react-router",
    heading: "Migration conversation",
    marker: "data-react-hydrated",
  },
  {
    path: "/usage",
    id: "qwik",
    heading: "Usage",
    marker: "data-qwik-router-ready",
  },
  {
    path: "/angular",
    id: "angular",
    heading: "Delivery readiness",
    marker: null,
  },
  {
    path: "/solid",
    id: "solid",
    heading: "Signal review",
    marker: null,
  },
] as const;

async function ready(frame: Locator, marker: string | null): Promise<void> {
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as HTMLElement & { status: string }).status),
    )
    .toBe("ready");
  if (marker !== null)
    await expect(frame.locator("v-html").first()).toHaveAttribute(marker, "true");
}

async function frameScreenshot(page: Page, frame: Locator): Promise<Buffer> {
  const clip = await frame.boundingBox();
  if (clip === null) throw new Error("The frame has no visible screenshot bounds");
  // Capture the painted viewport region without element-stability heuristics.
  return page.screenshot({ clip });
}

async function paints(page: Page, count = 3): Promise<void> {
  await page.evaluate(
    (remaining) =>
      new Promise<void>((resolve) => {
        const next = () => {
          if (--remaining <= 0) resolve();
          else requestAnimationFrame(next);
        };
        requestAnimationFrame(next);
      }),
    count,
  );
}

/** Sample at paint boundaries: DOM mutation logs alone also count invisible staged work. */
async function startPaintProbe(page: Page, selectors: string[]): Promise<void> {
  await page.evaluate((selectors) => {
    const nativeRect = Element.prototype.getBoundingClientRect;
    const result: ProbeResult = { paints: 0, faults: [] };
    const snapshot = (selector: string) => {
      const frame = document.querySelector(selector);
      if (!frame?.shadowRoot) return null;
      const roots = Array.from(frame.shadowRoot.children).filter((element) => {
        const style = getComputedStyle(element);
        return (
          element.localName === "v-html" &&
          style.visibility === "visible" &&
          style.opacity !== "0"
        );
      });
      if (roots.length !== 1) return { roots: roots.length, nodes: [] };
      const nodes = Array.from(
        roots[0]!.querySelectorAll("h1,h2,textarea,main,button,.composer-widget > p"),
      )
        .filter((element) => {
          const rect = nativeRect.call(element);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            getComputedStyle(element).visibility === "visible"
          );
        })
        .map((element) => {
          const rect = nativeRect.call(element);
          const style = getComputedStyle(element);
          return {
            text: element.matches("main") ? null : element.textContent,
            rect: [rect.x, rect.y, rect.width, rect.height].map(
              (value) => Math.round(value * 100) / 100,
            ),
            color: style.color,
            background: style.backgroundColor,
            font: style.font,
            display: style.display,
          };
        });
      return { roots: roots.length, nodes };
    };
    const baseline = selectors.map((selector) => JSON.stringify(snapshot(selector)));
    let running = true;
    const sample = () => {
      if (!running) return;
      result.paints++;
      selectors.forEach((selector, index) => {
        const next = JSON.stringify(snapshot(selector));
        if (next !== baseline[index] && result.faults.length < 10)
          result.faults.push(`${selector}: ${baseline[index]} -> ${next}`);
      });
      requestAnimationFrame(sample);
    };
    (window as ProbeWindow).paintProbe = result;
    (window as ProbeWindow).stopPaintProbe = () => {
      running = false;
      return result;
    };
    requestAnimationFrame(sample);
  }, selectors);
}

for (const viewport of [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
]) {
  for (const scenario of pages) {
    test(`${scenario.id} preserves first paint through delayed activation on ${viewport.name}`, async ({
      page,
      browserName,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error" && !message.text().includes("favicon.ico"))
          errors.push(message.text());
      });
      const entries: string[] = [];
      page.on("request", (request) => {
        if (
          request.resourceType() === "fetch" &&
          /^\/widgets\/[^/]+\/(activity|inventory|catalog|dashboard|signals)$/.test(
            new URL(request.url()).pathname,
          )
        )
          entries.push(request.url());
      });
      let releaseHost!: () => void;
      let releaseGuest!: () => void;
      const hostGate = new Promise<void>((resolve) => {
        releaseHost = resolve;
      });
      const guestGate = new Promise<void>((resolve) => {
        releaseGuest = resolve;
      });
      await page.route("**/assets/v-frame.js", async (route) => {
        if (browserName === "webkit") {
          // WebKit's snapshot protocol waits for document loading to finish.
          // Delay the real module's startup instead of leaving an async host
          // script fetch pending; the class remains undefined in the preview.
          await route.fulfill({
            contentType: "text/javascript",
            body: "globalThis.activateHost = () => import('/assets/v-frame-activation.js')",
          });
          return;
        }
        await hostGate;
        await route.continue();
      });
      if (browserName === "webkit") {
        await page.route("**/assets/v-frame-activation.js", async (route) => {
          const response = await route.fetch({
            url: new URL("/assets/v-frame.js", route.request().url()).href,
          });
          await route.fulfill({ response });
        });
      }
      await page.route(
        (url) => url.pathname.startsWith("/widgets/") && url.pathname.endsWith(".js"),
        async (route) => {
          await guestGate;
          await route.continue();
        },
      );
      try {
        await page.goto(scenario.path, { waitUntil: "commit" });
        const frame = page.locator(`v-frame[data-frame-id="${scenario.id}"]`);
        await expect(
          frame.getByRole("heading", { name: scenario.heading, exact: true }),
        ).toBeVisible();
        await expect
          .poll(() =>
            frame.evaluate(
              (element) =>
                customElements.get("v-frame") === undefined &&
                element.shadowRoot?.querySelector("v-html") !== null,
            ),
          )
          .toBe(true);
        const before = await frameScreenshot(page, frame);
        const selectors = [`v-frame[data-frame-id="${scenario.id}"]`];
        if (scenario.path === "/") selectors.push('v-frame[data-frame-id="qwik"]');
        if (viewport.name === "desktop")
          selectors.push('v-frame[data-frame-id="account"]');
        await startPaintProbe(page, selectors);
        await paints(page);
        releaseHost();
        if (browserName === "webkit")
          await page.evaluate(() => {
            void (
              window as Window & typeof globalThis & { activateHost(): Promise<void> }
            ).activateHost();
          });
        await expect
          .poll(() =>
            frame.evaluate(
              (element) =>
                Array.from(element.shadowRoot?.children ?? []).filter(
                  (child) => child.localName === "v-html",
                ).length,
            ),
          )
          .toBe(2);
        await expect(
          frame.getByRole("heading", { name: scenario.heading, exact: true }),
        ).toBeVisible();
        await paints(page);
        releaseGuest();
        await ready(frame, scenario.marker);
        if (scenario.path === "/")
          await ready(
            page.locator('v-frame[data-frame-id="qwik"]'),
            "data-qwik-router-ready",
          );
        if (viewport.name === "desktop")
          await ready(
            page.locator('v-frame[data-frame-id="account"]'),
            "data-qwik-router-ready",
          );
        await paints(page, 5);
        const after = await frameScreenshot(page, frame);
        const probe = await page.evaluate(() => (window as ProbeWindow).stopPaintProbe());
        expect(probe.paints).toBeGreaterThanOrEqual(6);
        expect(probe.faults).toEqual([]);
        if (!before.equals(after)) {
          await testInfo.attach("server-preview", {
            body: before,
            contentType: "image/png",
          });
          await testInfo.attach("activated-content", {
            body: after,
            contentType: "image/png",
          });
        }
        expect(before.equals(after), "Activation must preserve the rendered pixels").toBe(
          true,
        );
        expect(entries).toEqual([]);
        expect(errors).toEqual([]);
        await expect(
          frame.locator('v-html[data-react-hydration-error="true"]'),
        ).toHaveCount(0);
        if (scenario.id === "angular" || scenario.id === "solid") {
          const button = frame.getByRole("button", {
            name: scenario.id === "angular" ? /Record review/ : /Reviewed signals/,
          });
          await button.click();
          await expect(button).toHaveText(
            scenario.id === "angular" ? "Record review · 1" : "Reviewed signals: 1",
          );
        }
      } finally {
        releaseHost();
        releaseGuest();
      }
    });
  }
}

for (const scenario of pages) {
  test(`${scenario.id} server content remains useful with JavaScript disabled`, async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:44500${scenario.path}`);
      await expect(
        page
          .locator(`v-frame[data-frame-id="${scenario.id}"]`)
          .getByRole("heading", { name: scenario.heading, exact: true }),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test(`${scenario.id} composed page passes WCAG accessibility rules`, async ({
    page,
  }) => {
    await page.goto(scenario.path);
    await ready(page.locator(`v-frame[data-frame-id="${scenario.id}"]`), scenario.marker);
    const result = await auditAccessibility(page);
    expect(
      result.violations.map(({ id, nodes }) => ({
        id,
        targets: nodes.map((node) => node.target),
        summary: nodes.map((node) => node.failureSummary),
      })),
    ).toEqual([]);
  });
}

test("client composition commits stay nonblank while scripts are delayed", async ({
  page,
}) => {
  await page.goto("/plugins");
  await ready(
    page.locator('v-frame[data-frame-id="react-router"]'),
    "data-react-hydrated",
  );
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/widgets/angular/*.js", async (route) => {
    await gate;
    await route.continue();
  });
  const observations: string[][] = [];
  await page.exposeFunction("recordCompositionPaint", (titles: string[]) =>
    observations.push(titles),
  );
  await page.evaluate(() => {
    const observe = () => {
      const visible = document.querySelector(
        "[data-host-composition]:not(.navigation-stage)",
      );
      const titles = Array.from(visible?.querySelectorAll("v-frame") ?? []).flatMap(
        (frame) =>
          Array.from(frame.shadowRoot?.querySelectorAll("h1,h2") ?? [])
            .filter((heading) => getComputedStyle(heading).visibility === "visible")
            .map((heading) => heading.textContent ?? ""),
      );
      (
        window as Window &
          typeof globalThis & { recordCompositionPaint(titles: string[]): void }
      ).recordCompositionPaint(titles);
      requestAnimationFrame(observe);
    };
    requestAnimationFrame(observe);
  });
  try {
    await page
      .locator(".host-sidebar")
      .getByRole("link", { name: /Delivery/ })
      .click();
    const pending = page.locator('.navigation-stage v-frame[data-frame-id="angular"]');
    await expect(pending.locator(".angular-dashboard")).toHaveCount(1);
    await paints(page, 5);
    await expect(page).toHaveURL("/plugins");
    await expect(page.locator(".navigation-stage")).toHaveAttribute("inert", "");
    release();
    await expect(page).toHaveURL("/angular");
    await expect(
      page
        .locator('v-frame[data-frame-id="angular"]')
        .getByRole("heading", { name: "Delivery readiness" }),
    ).toBeVisible();
    await paints(page, 5);
    expect(observations.length).toBeGreaterThan(5);
    expect(
      observations.every(
        (titles) => titles.includes("Plugins") || titles.includes("Delivery readiness"),
      ),
    ).toBe(true);
  } finally {
    release();
  }
});
