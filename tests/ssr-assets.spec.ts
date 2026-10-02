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
  const before = await screenshot(page, frame);
  const stylesheetRequests = assets.requests
    .slice(start)
    .filter((path) => path.endsWith(".css"));
  await activate();
  await ready(frame);
  const after = await screenshot(page, frame);
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
