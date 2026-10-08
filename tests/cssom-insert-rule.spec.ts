import { expect, test } from "@playwright/test";
import {
  bundleRoute,
  htmlDocument,
  parkRoute,
  startHTTPFixture,
} from "./support/http-fixture";
import type { HTTPFixture } from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";
import type { VFrameElement } from "../src/index";

let fixture: HTTPFixture;
const nestedGate = parkRoute({ type: "text/plain", body: "ready" });

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/guest.html": htmlDocument(
        '<style id="sheet">.seed { color: red; }</style><p id="probe" class="r2999">probe</p>',
      ),
      "/nested.html": htmlDocument(
        '<p id="probe">Nested rules</p>',
        '<style id="sheet">@media all {}</style>',
      ),
      "/staged.html": htmlDocument(
        `
        <p id="probe">Incoming guest</p>
        <script type="module">
          const media = document.querySelector('#sheet').sheet.cssRules[0];
          media.insertRule('@supports (display: block) {}');
          const supports = media.cssRules[0];
          supports.insertRule('body {color: rgb(8, 9, 10)}');
          supports.insertRule('#probe {color: rgb(21, 22, 23)}');
          await fetch('/nested-gate');
        </script>
      `,
        '<style id="sheet">@media all {}</style>',
      ),
      "/nested-gate": nestedGate.route,
    },
  });
});

test.afterAll(async () => {
  nestedGate.abandon();
  await fixture.close();
});

test("nested insertRule rewrites selectors and URLs and installs subsequent mutations", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, { src: `${fixture.origin}/nested.html` });
  const result = await frame.evaluate((element: VFrameElement) => {
    const view = element.contentWindow!;
    const sheet = (view.document.querySelector("#sheet") as HTMLStyleElement).sheet!;
    const media = sheet.cssRules[0] as CSSMediaRule;
    const index = media.insertRule("@supports (display: block) {}");
    const supports = media.cssRules[index] as CSSSupportsRule;
    const inserted = supports.insertRule(
      'body { color: rgb(4, 5, 6); background-image: url("asset.svg") }',
    );
    const rule = supports.cssRules[inserted] as CSSStyleRule;
    const before = {
      color: view.getComputedStyle(view.document.body).color,
      selector: rule.selectorText,
      image: rule.style.backgroundImage,
    };
    rule.selectorText = "html";
    rule.style.cssText = 'color: rgb(7, 8, 9); background-image: url("other.svg")';
    return {
      index,
      inserted,
      before,
      after: {
        color: view.getComputedStyle(view.document.documentElement).color,
        selector: rule.selectorText,
        image: rule.style.backgroundImage,
      },
    };
  });
  expect(result).toEqual({
    index: 0,
    inserted: 0,
    before: {
      color: "rgb(4, 5, 6)",
      selector: "v-body",
      image: `url("${fixture.origin}/asset.svg")`,
    },
    after: {
      color: "rgb(7, 8, 9)",
      selector: "v-html",
      image: `url("${fixture.origin}/other.svg")`,
    },
  });
});

test("nested rules stay scoped during staging and take effect when revealed", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, { src: `${fixture.origin}/guest.html` });
  await frame.evaluate((element: VFrameElement) => {
    element.contentWindow!.document.body.style.color = "rgb(11, 12, 13)";
    element.src = "/staged.html";
  });
  await expect.poll(() => fixture.requests.includes("/nested-gate")).toBe(true);
  const staged = await frame.evaluate((element: VFrameElement) => ({
    status: element.status,
    outgoingColor: element.contentWindow!.getComputedStyle(
      element.contentWindow!.document.querySelector("#probe")!,
    ).color,
  }));
  expect(staged).toEqual({ status: "loading", outgoingColor: "rgb(11, 12, 13)" });
  await nestedGate.release();
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  await expect(frame.locator("#probe")).toHaveCSS("color", "rgb(21, 22, 23)");
  await expect(frame.locator("v-body")).toHaveCSS("color", "rgb(8, 9, 10)");
});

test("insertRule and addRule install only the rule they add", async ({ page }) => {
  await installBundle(page, fixture.origin);
  await mountFrame(page, { src: fixture.origin + "/guest.html", id: "frame" });

  const result = await page.evaluate(() => {
    const view = (
      document.querySelector("#frame") as HTMLElement & {
        contentWindow: Window & typeof globalThis;
      }
    ).contentWindow;
    const sheet = (view.document.querySelector("#sheet") as HTMLStyleElement).sheet!;

    // Installing a rule reads its `type`, so counting those reads while rules pile up
    // shows whether each insert walks the whole sheet again: a walk makes the count
    // quadratic in the number of inserts, installing just the new rule keeps it linear.
    const nativeType = Object.getOwnPropertyDescriptor(view.CSSRule.prototype, "type")!;
    let typeReads = 0;
    Object.defineProperty(view.CSSRule.prototype, "type", {
      ...nativeType,
      get() {
        typeReads += 1;
        return nativeType.get!.call(this);
      },
    });

    const count = 3000;
    for (let index = 0; index < count; index += 1) {
      sheet.insertRule(`.r${index} { color: rgb(1, 2, ${index % 256}); }`, 0);
    }
    (sheet as CSSStyleSheet & { addRule(s: string, d: string): number }).addRule(
      ".added",
      "color: blue",
    );
    Object.defineProperty(view.CSSRule.prototype, "type", nativeType);

    const rules = Array.from(sheet.cssRules) as CSSStyleRule[];
    return {
      length: rules.length,
      first: rules[0]?.selectorText,
      last: rules.at(-1)?.selectorText,
      ownCssText: rules.filter((rule) => Object.hasOwn(rule, "cssText")).length,
      typeReads,
      probeColor: view.getComputedStyle(view.document.querySelector("#probe")!).color,
    };
  });

  expect(result.length).toBe(3002);
  expect(result.first).toBe(".r2999");
  expect(result.last).toBe(".added");
  expect(result.probeColor).toBe("rgb(1, 2, 183)");
  // Every rule, the seed included, went through the installer exactly once.
  expect(result.ownCssText).toBe(3002);
  expect(result.typeReads).toBeLessThan(3001 * 3);
});
