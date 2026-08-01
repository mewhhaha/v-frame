import { expect, test } from "@playwright/test";
import {
  bundleRoute,
  htmlDocument,
  type HTTPFixture,
  type Route,
  startHTTPFixture,
} from "./support/http-fixture";
import { frameFailures, installBundle, mountFrame } from "./support/mount-frame";

let fixture: HTTPFixture;

function stylesheet(body: string): Route {
  return { type: "text/css", body };
}

function startFixture(): Promise<HTTPFixture> {
  return startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/documents/inline.html": htmlDocument(
        '<p id="inline-parent">parent</p><p id="inline-imported">imported</p><p id="inline-sibling">sibling</p>',
        '<style>@import url("../styles/inline-nested.css"); #inline-parent { color: rgb(11, 12, 13); }</style>',
      ),
      "/documents/linked.html": htmlDocument(
        '<p id="linked-parent">parent</p><p id="linked-imported">imported</p><p id="linked-sibling">sibling</p>',
        '<link rel="stylesheet" href="../styles/linked.css">',
      ),
      "/styles/inline-nested.css": stylesheet(
        '@import url("./inline-sibling.css") layer(recovered) supports(display: grid) screen; @import url("./inline-missing.css"); #inline-imported { color: rgb(21, 22, 23); }',
      ),
      "/styles/inline-sibling.css": stylesheet(
        "#inline-sibling { color: rgb(31, 32, 33); }",
      ),
      "/styles/linked.css": stylesheet(
        '@import url("./linked-nested.css"); #linked-parent { color: rgb(41, 42, 43); }',
      ),
      "/styles/linked-nested.css": stylesheet(
        '@import url("./linked-sibling.css") layer(recovered) supports(display: grid) screen; @import url("./linked-missing.css"); #linked-imported { color: rgb(51, 52, 53); }',
      ),
      "/styles/linked-sibling.css": stylesheet(
        "#linked-sibling { color: rgb(61, 62, 63); }",
      ),
    },
  });
}

test.beforeAll(async () => {
  fixture = await startFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

test("keeps valid inline stylesheet rules after a nested import fails", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/inline.html`,
    settle: "load",
  });
  const failures = await frameFailures(frame);

  await expect(frame.locator("#inline-parent")).toHaveCSS("color", "rgb(11, 12, 13)");
  await expect(frame.locator("#inline-imported")).toHaveCSS("color", "rgb(21, 22, 23)");
  await expect(frame.locator("#inline-sibling")).toHaveCSS("color", "rgb(31, 32, 33)");
  expect(failures).toEqual([
    {
      phase: "stylesheet",
      url: `${fixture.origin}/styles/inline-missing.css`,
      fatal: false,
    },
  ]);
});

test("keeps valid linked stylesheet rules after a nested import fails", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/linked.html`,
    settle: "load",
  });
  const failures = await frameFailures(frame);

  await expect(frame.locator("#linked-parent")).toHaveCSS("color", "rgb(41, 42, 43)");
  await expect(frame.locator("#linked-imported")).toHaveCSS("color", "rgb(51, 52, 53)");
  await expect(frame.locator("#linked-sibling")).toHaveCSS("color", "rgb(61, 62, 63)");
  expect(failures).toEqual([
    {
      phase: "stylesheet",
      url: `${fixture.origin}/styles/linked-missing.css`,
      fatal: false,
    },
  ]);
});
