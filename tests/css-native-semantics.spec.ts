import { expect, test } from "@playwright/test";
import {
  bundleRoute,
  type HTTPFixture,
  type Route,
  startHTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";
import { settleAfterRoundTrip } from "./support/settle";

let fixture: HTTPFixture;

const importDocument = `<!doctype html><html><head>
    <style>
      @charset "UTF-8";
      @layer reset;
      @import url("../styles/inline-leading.css");
      @import url("../styles/imported-parent.css");
      #inline-boundary { color: rgb(11, 12, 13); }
      @import url("../styles/inline-late.css");
    </style>
    <link rel="stylesheet" href="../styles/linked.css">
  </head><body>
    <p id="inline-leading">inline leading</p>
    <p id="inline-late">inline late</p>
    <p id="imported-leading">imported leading</p>
    <p id="imported-late">imported late</p>
    <p id="linked-leading">linked leading</p>
    <p id="linked-late">linked late</p>
    <p id="dynamic-inline-leading">dynamic inline leading</p>
    <p id="dynamic-inline-late">dynamic inline late</p>
    <p id="dynamic-linked-leading">dynamic linked leading</p>
    <p id="dynamic-linked-late">dynamic linked late</p>
  </body></html>`;

const fragmentDocument = `<!doctype html><html><head>
    <style id="fragment-style">
      #stylesheet-unquoted { fill: url(#paint); }
      #stylesheet-quoted { fill: url("#paint"); }
      #cssom-target { fill: rgb(1, 2, 3); }
    </style>
  </head><body>
    <svg width="100" height="100" viewBox="0 0 100 100">
      <defs>
        <linearGradient id="paint">
          <stop offset="0" stop-color="rgb(12, 34, 56)"></stop>
          <stop offset="1" stop-color="rgb(65, 43, 21)"></stop>
        </linearGradient>
      </defs>
      <rect id="stylesheet-unquoted" width="20" height="20"></rect>
      <rect id="stylesheet-quoted" x="20" width="20" height="20"></rect>
      <rect id="attribute-unquoted" x="40" width="20" height="20" style="fill: url(#paint)"></rect>
      <rect id="cssom-target" x="60" width="20" height="20"></rect>
    </svg>
  </body></html>`;

function stylesheet(body: string): Route {
  return { type: "text/css", body };
}

function startFixture(): Promise<HTTPFixture> {
  return startHTTPFixture({
    routes: {
      "/": '<!doctype html><div id="host"></div>',
      "/dist/index.js": bundleRoute,
      "/documents/imports.html": importDocument,
      "/documents/fragments.html": fragmentDocument,
      "/styles/inline-leading.css": stylesheet(
        "#inline-leading { color: rgb(21, 22, 23); }",
      ),
      "/styles/inline-late.css": stylesheet("#inline-late { color: rgb(31, 32, 33); }"),
      "/styles/imported-parent.css": stylesheet(
        '@import url("./imported-leading.css"); #imported-boundary { color: rgb(41, 42, 43); } @import url("./imported-late.css");',
      ),
      "/styles/imported-leading.css": stylesheet(
        "#imported-leading { color: rgb(51, 52, 53); }",
      ),
      "/styles/imported-late.css": stylesheet(
        "#imported-late { color: rgb(61, 62, 63); }",
      ),
      "/styles/linked.css": stylesheet(
        '@import url("./linked-leading.css"); #linked-boundary { color: rgb(71, 72, 73); } @import url("./linked-late.css");',
      ),
      "/styles/linked-leading.css": stylesheet(
        "#linked-leading { color: rgb(81, 82, 83); }",
      ),
      "/styles/linked-late.css": stylesheet("#linked-late { color: rgb(91, 92, 93); }"),
      "/styles/dynamic-inline-leading.css": stylesheet(
        "#dynamic-inline-leading { color: rgb(101, 102, 103); }",
      ),
      "/styles/dynamic-inline-late.css": stylesheet(
        "#dynamic-inline-late { color: rgb(111, 112, 113); }",
      ),
      "/styles/dynamic-linked.css": stylesheet(
        '@import url("./dynamic-linked-leading.css"); #dynamic-linked-boundary { color: rgb(121, 122, 123); } @import url("./dynamic-linked-late.css");',
      ),
      "/styles/dynamic-linked-leading.css": stylesheet(
        "#dynamic-linked-leading { color: rgb(131, 132, 133); }",
      ),
      "/styles/dynamic-linked-late.css": stylesheet(
        "#dynamic-linked-late { color: rgb(141, 142, 143); }",
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

test("ignores late imports in initial, imported, linked, and dynamic stylesheets", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  fixture.requests.length = 0;
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/imports.html`,
    settle: "load",
  });

  await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const inlineStyle = child.document.createElement("style");
    inlineStyle.textContent = `
      @import url("../styles/dynamic-inline-leading.css");
      #dynamic-inline-boundary { color: rgb(151, 152, 153); }
      @import url("../styles/dynamic-inline-late.css");
    `;
    child.document.head.append(inlineStyle);

    const linkedStyle = child.document.createElement("link");
    linkedStyle.rel = "stylesheet";
    linkedStyle.href = "../styles/dynamic-linked.css";
    child.document.head.append(linkedStyle);
  });

  const expectedLeadingColors = new Map([
    ["#inline-leading", "rgb(21, 22, 23)"],
    ["#imported-leading", "rgb(51, 52, 53)"],
    ["#linked-leading", "rgb(81, 82, 83)"],
    ["#dynamic-inline-leading", "rgb(101, 102, 103)"],
    ["#dynamic-linked-leading", "rgb(131, 132, 133)"],
  ]);
  for (const [selector, color] of expectedLeadingColors) {
    await expect(frame.locator(selector)).toHaveCSS("color", color);
  }

  for (const selector of [
    "#inline-late",
    "#imported-late",
    "#linked-late",
    "#dynamic-inline-late",
    "#dynamic-linked-late",
  ]) {
    await expect(frame.locator(selector)).toHaveCSS("color", "rgb(0, 0, 0)");
  }

  const stylesheetRequests = fixture.requests.filter((pathname) =>
    pathname.startsWith("/styles/"),
  );
  expect(stylesheetRequests).toEqual(
    expect.arrayContaining([
      "/styles/inline-leading.css",
      "/styles/imported-parent.css",
      "/styles/imported-leading.css",
      "/styles/linked.css",
      "/styles/linked-leading.css",
      "/styles/dynamic-inline-leading.css",
      "/styles/dynamic-linked.css",
      "/styles/dynamic-linked-leading.css",
    ]),
  );
  expect(stylesheetRequests.filter((pathname) => pathname.includes("-late.css"))).toEqual(
    [],
  );
});

test("keeps quoted and unquoted fragment URLs local across stylesheet and CSSOM rewrites", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  fixture.requests.length = 0;
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/fragments.html`,
    settle: "load",
  });

  const fills = await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const fragmentStyle = child.document.querySelector(
      "#fragment-style",
    ) as HTMLStyleElement;
    const rules = Array.from(fragmentStyle.sheet!.cssRules) as CSSStyleRule[];
    const cssomRule = rules[2]!;
    cssomRule.style.cssText = "fill: url('#paint')";

    const dynamicAttribute = child.document.querySelector(
      "#attribute-unquoted",
    ) as SVGRectElement;
    dynamicAttribute.setAttribute("style", "fill: url(#paint)");

    return {
      stylesheetUnquoted: rules[0]!.style.fill,
      stylesheetQuoted: rules[1]!.style.fill,
      attributeUnquoted: dynamicAttribute.style.fill,
      cssom: cssomRule.style.fill,
      computed: child.getComputedStyle(child.document.querySelector("#cssom-target")!)
        .fill,
    };
  });

  for (const [source, fill] of Object.entries(fills)) {
    expect(fill, source).toMatch(/^url\(["']?#paint["']?\)$/);
  }

  await settleAfterRoundTrip(page, `${fixture.origin}/`);
  expect(
    fixture.requests.filter((pathname) => pathname === "/documents/fragments.html"),
  ).toHaveLength(1);
});
