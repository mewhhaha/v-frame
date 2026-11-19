import { expect, type Locator, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import type { VFrameElement } from "../../src/index.js";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./http-fixture";
import { installBundle, mountFrame } from "./mount-frame";

const pinnedCSS = "#target { color: rgb(44, 55, 66); }";
export const stylesheetIntegrity = `sha384-${createHash("sha384").update(pinnedCSS).digest("base64")}`;
export const differentStylesheetIntegrity = `sha384-${createHash("sha384").update("#target { color: black; }").digest("base64")}`;

/** A host page, two linked guest documents and a redirected stylesheet chain. */
export function startGuestDocumentFixture(): Promise<HTTPFixture> {
  return startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/first": htmlDocument(
        '<a id="next" href="/second">Next</a><div id="target">First</div>',
      ),
      "/second": htmlDocument('<div id="target">Second</div>'),
      "/linked": htmlDocument(
        '<p id="target">Styled</p>',
        '<link id="theme" rel="stylesheet" href="/old/theme.css">',
      ),
      "/linked-integrity": htmlDocument(
        '<p id="target">Styled</p>',
        `<link id="rejected" rel="stylesheet" href="/blue.css" integrity="${differentStylesheetIntegrity}"><link id="pinned" rel="stylesheet" href="/blue.css" integrity="${stylesheetIntegrity}">`,
      ),
      "/old/theme.css": { status: 302, headers: { location: "/new/theme.css" } },
      "/new/theme.css": {
        type: "text/css",
        body: '@import "nested.css"; #target { background-image: url("asset.svg"); }',
      },
      "/new/nested.css": {
        type: "text/css",
        body: "#target { color: rgb(11, 22, 33); }",
      },
      "/blue.css": { type: "text/css", body: pinnedCSS },
      "/new/asset.svg": {
        type: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg"/>',
      },
    },
  });
}

export async function mountGuestDocument(
  page: Page,
  fixture: HTTPFixture,
  route = "/first",
): Promise<Locator> {
  await installBundle(page, fixture.origin);
  return mountFrame(page, { src: `${fixture.origin}${route}` });
}

/** Mounts the first guest document and follows its link to the second. */
export async function mountAtSecondDocument(
  page: Page,
  fixture: HTTPFixture,
): Promise<Locator> {
  const frame = await mountGuestDocument(page, fixture);
  await frame.locator("#next").click();
  await expect(frame.locator("#target")).toHaveText("Second");
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  return frame;
}
