import { expect, test, type Page } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { serveRealmMarker } from "./support/gateway-fixture.js";

interface CSSOMFixture {
  origin: string;
  close(): Promise<void>;
}

let fixture: CSSOMFixture;

function reply(response: ServerResponse, status: number, type: string, source: string): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": type });
  response.end(source);
}

function documentSource(): string {
  return `<!doctype html><html><head>
    <style id="initial-style">#selector-target { color: rgb(1, 2, 3); }</style>
  </head><body>
    <p id="insert-rule-target">insertRule</p>
    <p id="add-rule-target">addRule</p>
    <p id="selector-target">selectorText</p>
  </body></html>`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
}

async function startFixture(): Promise<CSSOMFixture> {
  const bundle = resolve(process.cwd(), "dist/index.js");
  const server = createServer((request, response) => {
    if (serveRealmMarker(request, response)) return;
    const pathname = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
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
    if (pathname === "/documents/cssom.html") {
      reply(response, 200, "text/html", documentSource());
      return;
    }
    if (pathname === "/documents/asset.png") {
      reply(response, 200, "image/png", "");
      return;
    }
    reply(response, 404, "text/plain", `Unknown fixture path ${pathname}`);
  });

  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("CSSOM fixture did not expose a TCP address");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
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

test("rewrites virtual style CSSOM mutations and rejects unsupported stylesheet APIs", async ({ page }) => {
  await installBundle(page);
  const result = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: Window | null;
      status: string;
    };
    const loaded = new Promise<void>((resolveLoaded) => {
      frame.addEventListener("v-frame-load", () => resolveLoaded(), { once: true });
    });
    frame.src = `${origin}/documents/cssom.html`;
    document.querySelector("#host")?.append(frame);
    await loaded;

    const child = frame.contentWindow!;
    const style = child.document.createElement("style");
    child.document.head.append(style);
    const sheet = style.sheet!;
    sheet.insertRule('body #insert-rule-target { color: rgb(11, 12, 13); background-image: url("./asset.png"); }');
    (sheet as CSSStyleSheet & {
      addRule(selector: string, declarations: string, index?: number): number;
    }).addRule("body #add-rule-target", "color: rgb(21, 22, 23)");

    const initialRule = (child.document.querySelector("#initial-style") as HTMLStyleElement)
      .sheet!.cssRules[0] as CSSStyleRule;
    initialRule.selectorText = "html #selector-target";
    initialRule.style.cssText = 'color: rgb(31, 32, 33); background-image: url("./asset.png");';

    const importError = (() => {
      try {
        sheet.insertRule('@import url("./asset.png");');
        return null;
      } catch (error) {
        return {
          childRealm: error instanceof child.DOMException,
          name: (error as DOMException).name,
        };
      }
    })();
    const adoptedErrors = [
      (() => {
        try {
          void child.document.adoptedStyleSheets;
          return null;
        } catch (error) {
          return {
            childRealm: error instanceof child.DOMException,
            name: (error as DOMException).name,
          };
        }
      })(),
      (() => {
        try {
          child.document.adoptedStyleSheets = [];
          return null;
        } catch (error) {
          return {
            childRealm: error instanceof child.DOMException,
            name: (error as DOMException).name,
          };
        }
      })(),
    ];

    await new Promise((resolveLater) => setTimeout(resolveLater, 0));
    return {
      addRuleSelector: (sheet.cssRules[1] as CSSStyleRule).selectorText,
      importError,
      adoptedErrors,
      insertRuleBackground: (sheet.cssRules[0] as CSSStyleRule).style.backgroundImage,
      insertRuleSelector: (sheet.cssRules[0] as CSSStyleRule).selectorText,
      selectorText: initialRule.selectorText,
      cssTextBackground: initialRule.style.backgroundImage,
    };
  }, fixture.origin);

  const assetURL = `${fixture.origin}/documents/asset.png`;
  expect(result.insertRuleSelector).toBe("v-body #insert-rule-target");
  expect(result.addRuleSelector).toBe("v-body #add-rule-target");
  expect(result.insertRuleBackground).toContain(assetURL);
  expect(result.selectorText).toBe("v-html #selector-target");
  expect(result.cssTextBackground).toContain(assetURL);
  expect(result.importError).toEqual({ childRealm: true, name: "NotSupportedError" });
  expect(result.adoptedErrors).toEqual([
    { childRealm: true, name: "NotSupportedError" },
    { childRealm: true, name: "NotSupportedError" },
  ]);

  const frame = page.locator("v-frame");
  await expect(frame.locator("#insert-rule-target")).toHaveCSS("color", "rgb(11, 12, 13)");
  await expect(frame.locator("#add-rule-target")).toHaveCSS("color", "rgb(21, 22, 23)");
  await expect(frame.locator("#selector-target")).toHaveCSS("color", "rgb(31, 32, 33)");
});

test("applies, clears, and rejects shorthand values through the inline style declaration", async ({ page }) => {
  await installBundle(page);
  const result = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: Window | null;
    };
    const loaded = new Promise<void>((resolveLoaded) => {
      frame.addEventListener("v-frame-load", () => resolveLoaded(), { once: true });
    });
    frame.setAttribute("src", `${origin}/documents/cssom.html`);
    document.querySelector("#host")?.append(frame);
    await loaded;

    const child = frame.contentWindow!;
    const idlTarget = child.document.querySelector("#insert-rule-target") as HTMLElement;
    idlTarget.style.margin = "10px";

    const setPropertyTarget = child.document.querySelector("#add-rule-target") as HTMLElement;
    setPropertyTarget.style.setProperty("padding", "4px 8px");

    const clearedTarget = child.document.querySelector("#selector-target") as HTMLElement;
    clearedTarget.setAttribute("style", "background: rgb(9, 9, 9); color: rgb(5, 6, 7)");
    clearedTarget.style.background = "";
    clearedTarget.style.setProperty("color", "notacolor");

    return {
      idlMargin: idlTarget.style.margin,
      setPropertyPadding: setPropertyTarget.style.getPropertyValue("padding"),
      clearedColor: clearedTarget.style.getPropertyValue("color"),
      clearedAttribute: clearedTarget.getAttribute("style"),
    };
  }, fixture.origin);

  expect(result.idlMargin).toBe("10px");
  expect(result.setPropertyPadding).toBe("4px 8px");
  expect(result.clearedColor).toBe("rgb(5, 6, 7)");
  expect(result.clearedAttribute).not.toContain("background");
  expect(result.clearedAttribute).toContain("color:rgb(5,6,7)");

  const frame = page.locator("v-frame");
  await expect(frame.locator("#insert-rule-target")).toHaveCSS("margin-top", "10px");
  await expect(frame.locator("#insert-rule-target")).toHaveCSS("margin-left", "10px");
  await expect(frame.locator("#add-rule-target")).toHaveCSS("padding-top", "4px");
  await expect(frame.locator("#add-rule-target")).toHaveCSS("padding-left", "8px");
  await expect(frame.locator("#selector-target")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(frame.locator("#selector-target")).toHaveCSS("color", "rgb(5, 6, 7)");
});
