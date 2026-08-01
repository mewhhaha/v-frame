import { expect, test, type Page } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

interface CSSNativeSemanticsFixture {
  origin: string;
  requests: string[];
  close(): Promise<void>;
}

let fixture: CSSNativeSemanticsFixture;

function reply(
  response: ServerResponse,
  status: number,
  type: string,
  source: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": type,
  });
  response.end(source);
}

function importDocument(): string {
  return `<!doctype html><html><head>
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
}

function fragmentDocument(): string {
  return `<!doctype html><html><head>
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
}

function stylesheetFor(pathname: string): string | undefined {
  switch (pathname) {
    case "/styles/inline-leading.css":
      return "#inline-leading { color: rgb(21, 22, 23); }";
    case "/styles/inline-late.css":
      return "#inline-late { color: rgb(31, 32, 33); }";
    case "/styles/imported-parent.css":
      return '@import url("./imported-leading.css"); #imported-boundary { color: rgb(41, 42, 43); } @import url("./imported-late.css");';
    case "/styles/imported-leading.css":
      return "#imported-leading { color: rgb(51, 52, 53); }";
    case "/styles/imported-late.css":
      return "#imported-late { color: rgb(61, 62, 63); }";
    case "/styles/linked.css":
      return '@import url("./linked-leading.css"); #linked-boundary { color: rgb(71, 72, 73); } @import url("./linked-late.css");';
    case "/styles/linked-leading.css":
      return "#linked-leading { color: rgb(81, 82, 83); }";
    case "/styles/linked-late.css":
      return "#linked-late { color: rgb(91, 92, 93); }";
    case "/styles/dynamic-inline-leading.css":
      return "#dynamic-inline-leading { color: rgb(101, 102, 103); }";
    case "/styles/dynamic-inline-late.css":
      return "#dynamic-inline-late { color: rgb(111, 112, 113); }";
    case "/styles/dynamic-linked.css":
      return '@import url("./dynamic-linked-leading.css"); #dynamic-linked-boundary { color: rgb(121, 122, 123); } @import url("./dynamic-linked-late.css");';
    case "/styles/dynamic-linked-leading.css":
      return "#dynamic-linked-leading { color: rgb(131, 132, 133); }";
    case "/styles/dynamic-linked-late.css":
      return "#dynamic-linked-late { color: rgb(141, 142, 143); }";
    default:
      return undefined;
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
}

async function startFixture(): Promise<CSSNativeSemanticsFixture> {
  const bundle = resolve(process.cwd(), "dist/index.js");
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    requests.push(pathname);

    if (pathname === "/") {
      reply(response, 200, "text/html", '<!doctype html><div id="host"></div>');
      return;
    }
    if (pathname === "/dist/index.js") {
      if (!existsSync(bundle)) {
        reply(response, 404, "text/plain", "Build output not found");
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/javascript",
      });
      createReadStream(bundle).pipe(response);
      return;
    }
    if (pathname === "/documents/imports.html") {
      reply(response, 200, "text/html", importDocument());
      return;
    }
    if (pathname === "/documents/fragments.html") {
      reply(response, 200, "text/html", fragmentDocument());
      return;
    }

    const stylesheet = stylesheetFor(pathname);
    if (stylesheet !== undefined) {
      reply(response, 200, "text/css", stylesheet);
      return;
    }
    reply(response, 404, "text/plain", `No fixture for ${pathname}`);
  });

  await new Promise<void>((resolveListening) => {
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("CSS native-semantics fixture did not expose a TCP address");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => closeServer(server),
  };
}

test.beforeAll(async () => {
  fixture = await startFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

async function installBundle(page: Page): Promise<void> {
  await page.goto(fixture.origin);
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
}

async function mountFrame(page: Page, pathname: string): Promise<void> {
  await page.evaluate(async ({ origin, documentPath }) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      src: string;
    };
    const loaded = new Promise<void>((resolveLoaded) => {
      frame.addEventListener("v-frame-load", () => resolveLoaded(), {
        once: true,
      });
    });
    frame.src = `${origin}${documentPath}`;
    document.querySelector("#host")?.append(frame);
    await loaded;
  }, { origin: fixture.origin, documentPath: pathname });
}

test("ignores late imports in initial, imported, linked, and dynamic stylesheets", async ({
  page,
}) => {
  await installBundle(page);
  fixture.requests.length = 0;
  await mountFrame(page, "/documents/imports.html");
  const frame = page.locator("v-frame");

  await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
      .contentWindow!;
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

  const stylesheetRequests = fixture.requests.filter((pathname) => (
    pathname.startsWith("/styles/")
  ));
  expect(stylesheetRequests).toEqual(expect.arrayContaining([
    "/styles/inline-leading.css",
    "/styles/imported-parent.css",
    "/styles/imported-leading.css",
    "/styles/linked.css",
    "/styles/linked-leading.css",
    "/styles/dynamic-inline-leading.css",
    "/styles/dynamic-linked.css",
    "/styles/dynamic-linked-leading.css",
  ]));
  expect(stylesheetRequests.filter((pathname) => pathname.includes("-late.css")))
    .toEqual([]);
});

test("keeps quoted and unquoted fragment URLs local across stylesheet and CSSOM rewrites", async ({
  page,
}) => {
  await installBundle(page);
  fixture.requests.length = 0;
  await mountFrame(page, "/documents/fragments.html");
  const frame = page.locator("v-frame");

  const fills = await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
      .contentWindow!;
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
      computed: child.getComputedStyle(
        child.document.querySelector("#cssom-target")!,
      ).fill,
    };
  });

  for (const [source, fill] of Object.entries(fills)) {
    expect(fill, source).toMatch(/^url\(["']?#paint["']?\)$/);
  }

  await page.waitForTimeout(100);
  expect(fixture.requests.filter((pathname) => (
    pathname === "/documents/fragments.html"
  ))).toHaveLength(1);
});
