import { expect, test } from "@playwright/test";
import { bundleRoute, type HTTPFixture, startHTTPFixture } from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: HTTPFixture;

const hostIsolationStylesheet = `
    :host { background-color: rgb(201, 2, 3) !important; }
    :host-context(.host-context) { width: 1px !important; }
    :host, body { color: rgb(4, 5, 6); min-height: 40px; }
  `;

function startFixture(): Promise<HTTPFixture> {
  return startHTTPFixture({
    routes: {
      "/": '<!doctype html><div id="host" class="host-context" style="width: 240px"></div>',
      "/dist/index.js": bundleRoute,
      "/documents/css-host-isolation.html": `<!doctype html><html><head><link rel="stylesheet" href="/assets/css-host-isolation.css"></head><body><p id="page-content">Page content</p></body></html>`,
      "/assets/css-host-isolation.css": {
        type: "text/css",
        body: hostIsolationStylesheet,
      },
    },
  });
}

test.beforeAll(async () => {
  fixture = await startFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

test("page :host and :host-context selectors cannot style the v-frame host", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/css-host-isolation.html`,
  });

  await expect(frame).toHaveCSS("display", "block");
  await expect(frame).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(frame).toHaveJSProperty("offsetWidth", 240);
  await expect(frame.locator("#page-content")).toHaveCSS("color", "rgb(4, 5, 6)");
  await expect(frame.locator("v-body")).toHaveCSS("min-height", "40px");
});
