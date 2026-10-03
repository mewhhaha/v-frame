import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { rolldown } from "rolldown";
import { startHTTPFixture, type HTTPFixture } from "./support/http-fixture";
import { auditAccessibility } from "./support/accessibility";
import type { VFrameElement } from "../src/index";

// Workers and Miniflare are pinned by the SSR workspace, which CI installs too.
const workspace = createRequire(resolve("examples/ssr/package.json"));
const wrangler = createRequire(workspace.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions } = wrangler("miniflare") as {
  convertV4MiniflareOptions(options: object): object;
  Miniflare: new (options: object) => { ready: Promise<URL>; dispose(): Promise<void> };
};
let assets: HTTPFixture;
let worker: InstanceType<typeof Miniflare>;
let origin: string;
test.beforeAll(async () => {
  const font = execFileSync("fc-match", ["-f", "%{file}", "DejaVu Sans"], {
    encoding: "utf8",
  });
  assets = await startHTTPFixture({
    routes: {
      "/apps/public/css/site.css": {
        status: 302,
        headers: { location: "/apps/public/redirected/site.css" },
      },
      "/apps/public/redirected/site.css": {
        type: "text/css",
        body: `@import "imported.css"; @font-face{font-family:AssetFont;src:url(../fonts/test.ttf);font-display:block}.copy{font:24px AssetFont,serif;color:rgb(21,84,63)}`,
      },
      "/apps/public/redirected/imported.css": {
        type: "text/css",
        body: ".inline{border-width:4px!important}",
      },
      "/apps/public/fonts/test.ttf": { type: "font/ttf", file: font },
      "/apps/public/images/tile.svg": {
        type: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><path fill="#177f7f" d="M0 0h120v40H0z"/></svg>',
      },
      "/apps/public/images/lazy.svg": {
        type: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><path fill="#177f7f" d="M0 0h120v40H0z"/></svg>',
      },
      "/apps/public/css/missing.css": {
        type: "text/css",
        status: 503,
        body: "unavailable",
      },
    },
  });
  const bundle = await rolldown({
    input: resolve("tests/support/ssr-asset-worker.js"),
    platform: "neutral",
  });
  let script: string;
  try {
    script = (await bundle.generate({ format: "es" })).output.find(
      (item) => item.type === "chunk",
    )!.code;
  } finally {
    await bundle.close();
  }
  worker = new Miniflare(
    convertV4MiniflareOptions({
      host: "127.0.0.1",
      port: 0,
      workers: [
        {
          modules: true,
          script,
          compatibilityDate: "2026-09-30",
          bindings: {
            ASSET_ORIGIN: assets.origin,
            BUNDLE: readFileSync("dist/index.js", "utf8"),
          },
        },
      ],
    }),
  );
  origin = (await worker.ready).origin;
});
test.afterAll(async () => {
  await worker?.dispose();
  await assets?.close();
});

async function pending(page: Page, path = "/") {
  let registration: Route | undefined;
  await page.route("**/dist/register.js", (route) => {
    registration = route;
  });
  const response = await page.goto(origin + path, { waitUntil: "commit" });
  const frame = page.locator("#frame");
  await expect(frame.getByRole("heading", { name: "Relative assets" })).toBeVisible();
  return {
    frame,
    response,
    activate: async () => {
      // Request the real entry only when activation is released. WebKit's
      // screenshot protocol waits for document loading; a pending module fetch
      // would prevent recording the inert preview, despite its visible paint.
      await page.evaluate(() => {
        const entry = "/dist/register.js";
        void import(entry);
      });
      await expect.poll(() => !!registration).toBe(true);
      await registration!.continue();
    },
  };
}
const ready = (frame: Locator) =>
  expect
    .poll(() => frame.evaluate((element) => (element as VFrameElement).status))
    .toBe("ready");
async function screenshot(page: Page, frame: Locator) {
  const clip = await frame.boundingBox();
  if (!clip) throw new Error("Missing frame bounds");
  return page.screenshot({ clip });
}

test("cold relative images, SVG, linked CSS, imports, redirects and webfonts paint identically at activation", async ({
  page,
}) => {
  const start = assets.requests.length;
  const { frame, activate } = await pending(page);
  await frame.evaluate(async () => {
    await document.fonts.load("24px AssetFont", "Relative assets");
  });
  await expect
    .poll(() =>
      frame
        .locator("#photo")
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
    )
    .toBe(true);
  await expect(frame.locator("h1")).toHaveCSS("color", "rgb(21, 84, 63)");
  await expect(frame.locator("#decoration")).toHaveCSS("border-top-width", "4px");
  for (const id of ["local-icon", "local-xlink"]) {
    await expect
      .poll(() =>
        frame.locator(`#${id}`).evaluate((use: SVGUseElement) => use.getBBox().width),
      )
      .toBe(24);
  }
  const before = await screenshot(page, frame);
  const stylesheetRequests = assets.requests
    .slice(start)
    .filter((path) => path.endsWith(".css"));
  await activate();
  await ready(frame);
  const after = await screenshot(page, frame);
  for (const id of ["local-icon", "local-xlink"]) {
    expect(
      await frame.locator(`#${id}`).evaluate((use: SVGUseElement) => use.getBBox().width),
    ).toBe(24);
  }
  await test.info().attach("before", { body: before, contentType: "image/png" });
  await test.info().attach("after", { body: after, contentType: "image/png" });
  expect(after.equals(before), "SSR asset paint changed at activation").toBe(true);
  expect(assets.requests.slice(start).filter((path) => path.endsWith(".css"))).toEqual(
    stylesheetRequests,
  );
  expect(
    await frame.evaluate(
      (element) =>
        ((element as VFrameElement).contentWindow! as Window & { authored: object })
          .authored,
    ),
  ).toEqual({
    src: "images/tile.svg",
    srcset: "images/tile.svg 1x, images/tile.svg 2x",
    style: "width:120px;height:24px;background-image:url(images/tile.svg)",
    rel: "stylesheet",
  });
  await frame.locator("#interactive").click();
  await expect(frame.locator("#result")).toHaveText("Clicked");
  expect(
    assets.requests.slice(start).every((path) => path.startsWith("/apps/public/")),
  ).toBe(true);
  expect((await auditAccessibility(page)).violations).toEqual([]);
});

test("an initial fragment target paints identically before and after SSR activation", async ({
  page,
}) => {
  const { frame, activate } = await pending(page, "/?target");
  await frame.evaluate(async () => {
    await document.fonts.load("24px AssetFont", "Relative assets");
  });
  await expect(frame.locator("h1.copy")).toHaveCSS(
    "background-color",
    "rgb(240, 200, 100)",
  );
  await expect
    .poll(() =>
      frame
        .locator("#photo")
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  const before = await screenshot(page, frame);
  await activate();
  await ready(frame);
  await expect(frame.locator("h1.copy")).toHaveCSS(
    "background-color",
    "rgb(240, 200, 100)",
  );
  const after = await screenshot(page, frame);
  expect(after.equals(before), "Fragment target paint changed at activation").toBe(true);
  expect(
    await frame.evaluate(
      (element: VFrameElement) =>
        element.contentWindow!.document.querySelector(":target")?.id,
    ),
  ).toBe("copy");
});

test("a deep SSR fragment preserves preview scrolling and pixels throughout activation", async ({
  page,
}) => {
  let guestScript: Route | undefined;
  await page.route("**/apps/public/main.js", (route) => {
    guestScript = route;
  });
  const { frame, activate } = await pending(page, "/?target=deep");
  await frame.evaluate(async () => {
    await document.fonts.load("24px AssetFont", "Relative assets");
  });
  await expect
    .poll(() =>
      frame
        .locator("#photo")
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  await expect(frame.locator("#deep")).toHaveCSS(
    "background-color",
    "rgb(240, 200, 100)",
  );
  await frame.evaluate((element) => {
    element.scrollTo({ top: 50, behavior: "instant" });
    const observed = element as VFrameElement & { scrollSamples: number[] };
    observed.scrollSamples = [];
    function record() {
      observed.scrollSamples.push(element.scrollTop);
      if (observed.status !== "ready") requestAnimationFrame(record);
    }
    requestAnimationFrame(record);
  });
  const before = await screenshot(page, frame);
  await activate();
  await expect.poll(() => !!guestScript).toBe(true);
  const staged = await screenshot(page, frame);
  await test.info().attach("staged-deep", { body: staged, contentType: "image/png" });
  expect(staged.equals(before), "Deep fragment preview jumped during staging").toBe(true);
  await guestScript!.continue();
  await ready(frame);
  const after = await screenshot(page, frame);
  await test.info().attach("before-deep", { body: before, contentType: "image/png" });
  await test.info().attach("after-deep", { body: after, contentType: "image/png" });
  expect(
    await frame.evaluate((element: VFrameElement & { scrollSamples: number[] }) => ({
      scroll: element.scrollTop,
      samples: [...new Set(element.scrollSamples)],
      target: element.contentWindow!.document.querySelector(":ta\\72 get")?.id,
    })),
  ).toEqual({ scroll: 50, samples: [50], target: "deep" });
  expect(await page.evaluate(() => scrollY)).toBe(0);
  expect(after.equals(before), "Deep fragment preview jumped at activation").toBe(true);
});

test("foreign-namespace head/base elements do not rebase Worker-materialized SSR assets", async ({
  page,
}) => {
  const { frame, response, activate } = await pending(page, "/?foreign-base");
  expect(response!.headers()["x-stylesheet-failures"]).toBe("0");
  await expect(frame.locator("h1")).toHaveCSS("color", "rgb(21, 84, 63)");
  await expect(frame.locator("#photo")).toHaveAttribute(
    "src",
    `${origin}/apps/public/images/tile.svg`,
  );
  await expect
    .poll(() =>
      frame
        .locator("#photo")
        .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
    )
    .toBe(true);
  await activate();
  await ready(frame);
  expect(
    await frame.evaluate(
      (element) => (element as VFrameElement).contentWindow!.document.baseURI,
    ),
  ).toBe(`${origin}/apps/public/page.html`);
  await expect(frame.locator("h1")).toHaveCSS("color", "rgb(21, 84, 63)");
  await frame.locator("#interactive").click();
  await expect(frame.locator("#result")).toHaveText("Clicked");
});

test("an unloaded off-screen lazy image does not delay SSR activation or lose lazy loading", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Chromium defers this off-screen lazy resource");
  const held: Route[] = [];
  const resource = "**/apps/public/images/lazy.svg";
  await page.route(resource, (route) => {
    held.push(route);
  });
  const { frame, activate } = await pending(page, "/?lazy=offscreen");
  await activate();
  await expect
    .poll(() => frame.evaluate((element) => (element as VFrameElement).status), {
      timeout: 4_000,
    })
    .toBe("ready");
  expect(held).toHaveLength(0);
  await expect(frame.locator("#lazy")).toHaveAttribute("loading", "lazy");
  await frame.locator("#interactive").click();
  await expect(frame.locator("#result")).toHaveText("Clicked");
  await frame.locator("#lazy").scrollIntoViewIfNeeded();
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await page.unroute(resource);
  await Promise.all(held.map((route) => route.continue()));
  await expect
    .poll(() =>
      frame
        .locator("#lazy")
        .evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth === 120,
        ),
    )
    .toBe(true);
});

test("a visible lazy image keeps its painted preview and loading attribute at SSR handoff", async ({
  page,
}) => {
  const { frame, activate } = await pending(page, "/?lazy=visible");
  await frame.locator("#lazy").scrollIntoViewIfNeeded();
  await expect
    .poll(() =>
      frame
        .locator("#lazy")
        .evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth === 120,
        ),
    )
    .toBe(true);
  await frame.evaluate(async () => {
    await document.fonts.load("24px AssetFont", "Relative assets");
  });
  const before = await screenshot(page, frame);
  await activate();
  await ready(frame);
  await expect(frame.locator("#lazy")).toHaveAttribute("loading", "lazy");
  expect(
    await frame
      .locator("#lazy")
      .evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth === 120,
      ),
  ).toBe(true);
  expect(
    (await screenshot(page, frame)).equals(before),
    "Lazy image changed at handoff",
  ).toBe(true);
});

test("delayed font and image responses keep the preview visible until resource readiness", async ({
  page,
}) => {
  const held: Route[] = [];
  await page.route(/\/(?:fonts\/test\.ttf|images\/tile\.svg)$/, (route) => {
    held.push(route);
  });
  const { frame, activate } = await pending(page);
  await expect.poll(() => held.length).toBeGreaterThanOrEqual(2);
  await activate();
  await expect(frame.locator("v-html")).toHaveCount(2);
  await expect(frame.locator("v-html").first().locator("#decoration")).toBeVisible();
  expect(await frame.evaluate((element) => (element as VFrameElement).status)).toBe(
    "loading",
  );
  // Both preview and staged tree can request the same cold resource.
  await page.unroute(/\/(?:fonts\/test\.ttf|images\/tile\.svg)$/);
  await Promise.all(held.map((route) => route.continue()));
  await ready(frame);
  await expect(frame.locator("v-html")).toHaveCount(1);
  await expect(frame.locator("#photo")).toBeVisible();
});

test("failed linked CSS and image/font resources settle and leave an interactive guest", async ({
  page,
}) => {
  await page.route(/\/(?:fonts\/test\.ttf|images\/tile\.svg)$/, (route) =>
    route.fulfill({ status: 503, body: "unavailable" }),
  );
  const { frame, response, activate } = await pending(page, "/?failure");
  expect(response!.headers()["x-stylesheet-failures"]).toBe("1");
  await activate();
  await ready(frame);
  await frame.locator("#interactive").click();
  await expect(frame.locator("#result")).toHaveText("Clicked");
  await expect(frame.locator("#photo")).toHaveAttribute("alt", "Teal tile");
  expect(
    assets.requests.filter((path) => path.endsWith("missing.css")).length,
  ).toBeGreaterThanOrEqual(2);
});
