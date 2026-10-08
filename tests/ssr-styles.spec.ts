import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { rolldown } from "rolldown";
import type { VFrameElement } from "../src/index";

// Workers and Miniflare are pinned by the SSR workspace, which CI installs too.
const workspace = createRequire(resolve("examples/ssr/package.json"));
const wrangler = createRequire(workspace.resolve("wrangler"));
const { Miniflare, convertV4MiniflareOptions } = wrangler("miniflare") as {
  convertV4MiniflareOptions(options: object): object;
  Miniflare: new (options: object) => { ready: Promise<URL>; dispose(): Promise<void> };
};

let worker: InstanceType<typeof Miniflare>;
let origin: string;

test.beforeAll(async () => {
  const bundle = await rolldown({
    input: resolve("tests/support/server-materializer-worker.js"),
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
          bindings: { BUNDLE: readFileSync("dist/index.js", "utf8") },
        },
      ],
    }),
  );
  origin = (await worker.ready).origin;
});
test.afterAll(async () => {
  await worker?.dispose();
});

const styleText = (page: Page, id: string) =>
  page
    .locator("#frame")
    .evaluate(
      (element, target) => element.shadowRoot!.querySelector(`#${target}`)!.textContent,
      id,
    );

async function activate(page: Page) {
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${origin}/dist/index.js`);
  await expect
    .poll(() => page.locator("#frame").evaluate((e) => (e as VFrameElement).status))
    .toBe("ready");
}

test("the runtime rewrites a guest style the server could not materialize, and leaves the rest", async ({
  page,
}) => {
  await page.goto(`${origin}/host`);
  const guest = `${origin}/apps/orders/`;
  // Before activation the server's output is shown as materialized: the good
  // sheet is already absolute, the failed one is as authored.
  expect(await styleText(page, "good")).toContain(`url(${guest}good.png)`);
  expect(await styleText(page, "failed")).toContain("url(failed.png)");

  await activate(page);

  expect(await styleText(page, "failed")).toContain(`url(${guest}failed.png)`);
  expect(await styleText(page, "good")).toContain(`url(${guest}good.png)`);
  // The markers are wire format, not guest DOM.
  expect(
    await page
      .locator("#frame")
      .evaluate(
        (e) => e.shadowRoot!.querySelectorAll("[data-v-frame-materialized]").length,
      ),
  ).toBe(0);
});

test("an alternate stylesheet stays unapplied after activation", async ({ page }) => {
  await page.goto(`${origin}/host`);
  await activate(page);
  await expect(page.locator("#frame").locator("#alt")).not.toHaveCSS(
    "color",
    "rgb(1, 2, 3)",
  );
});
