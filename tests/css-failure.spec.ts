import { expect, test } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

interface CSSFailureFixture {
  origin: string;
  close(): Promise<void>;
}

let fixture: CSSFailureFixture;

function reply(response: ServerResponse, status: number, type: string, source: string) {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(source);
}

function documentWith(body: string, head: string) {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

function inlineDocument() {
  return documentWith(
    '<p id="inline-parent">parent</p><p id="inline-imported">imported</p><p id="inline-sibling">sibling</p>',
    '<style>@import url("../styles/inline-nested.css"); #inline-parent { color: rgb(11, 12, 13); }</style>',
  );
}

function linkedDocument() {
  return documentWith(
    '<p id="linked-parent">parent</p><p id="linked-imported">imported</p><p id="linked-sibling">sibling</p>',
    '<link rel="stylesheet" href="../styles/linked.css">',
  );
}

function stylesheetFor(path: string): string | undefined {
  switch (path) {
    case "/styles/inline-nested.css":
      return '@import url("./inline-sibling.css") layer(recovered) supports(display: grid) screen; @import url("./inline-missing.css"); #inline-imported { color: rgb(21, 22, 23); }';
    case "/styles/inline-sibling.css":
      return "#inline-sibling { color: rgb(31, 32, 33); }";
    case "/styles/linked.css":
      return '@import url("./linked-nested.css"); #linked-parent { color: rgb(41, 42, 43); }';
    case "/styles/linked-nested.css":
      return '@import url("./linked-sibling.css") layer(recovered) supports(display: grid) screen; @import url("./linked-missing.css"); #linked-imported { color: rgb(51, 52, 53); }';
    case "/styles/linked-sibling.css":
      return "#linked-sibling { color: rgb(61, 62, 63); }";
    default:
      return undefined;
  }
}

async function startFixture(): Promise<CSSFailureFixture> {
  const bundle = resolve(process.cwd(), "dist/index.js");
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.test").pathname;
    if (path === "/") {
      return reply(response, 200, "text/html", documentWith('<div id="host"></div>', ""));
    }
    if (path === "/dist/index.js") {
      if (!existsSync(bundle)) {
        return reply(response, 404, "text/plain", "Build output not found");
      }
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      createReadStream(bundle).pipe(response);
      return;
    }
    if (path === "/documents/inline.html") {
      return reply(response, 200, "text/html", inlineDocument());
    }
    if (path === "/documents/linked.html") {
      return reply(response, 200, "text/html", linkedDocument());
    }

    const stylesheet = stylesheetFor(path);
    if (stylesheet !== undefined) {
      return reply(response, 200, "text/css", stylesheet);
    }
    return reply(response, 404, "text/plain", `No fixture for ${path}`);
  });

  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("CSS fixture server did not expose a TCP address");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
}

test.beforeAll(async () => {
  fixture = await startFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

async function installBundle(page: import("@playwright/test").Page) {
  await page.goto(fixture.origin);
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
}

async function mountFrame(
  page: import("@playwright/test").Page,
  path: string,
): Promise<Array<{ phase: string; url: string; fatal: boolean }>> {
  return page.evaluate(async ({ origin, documentPath }) => {
    const frame = document.createElement("v-frame") as HTMLElement & { src: string };
    const failures: Array<{ phase: string; url: string; fatal: boolean }> = [];
    frame.addEventListener("v-frame-error", (event) => {
      const detail = (event as CustomEvent<{ phase: string; url: string; fatal: boolean }>).detail;
      failures.push({ phase: detail.phase, url: detail.url, fatal: detail.fatal });
    });
    const loaded = new Promise<void>((resolve) => frame.addEventListener("v-frame-load", () => resolve(), { once: true }));
    frame.src = `${origin}${documentPath}`;
    document.querySelector("#host")?.append(frame);
    await loaded;
    return failures;
  }, { origin: fixture.origin, documentPath: path });
}

test("keeps valid inline stylesheet rules after a nested import fails", async ({ page }) => {
  await installBundle(page);
  const failures = await mountFrame(page, "/documents/inline.html");
  const frame = page.locator("v-frame");

  await expect(frame.locator("#inline-parent")).toHaveCSS("color", "rgb(11, 12, 13)");
  await expect(frame.locator("#inline-imported")).toHaveCSS("color", "rgb(21, 22, 23)");
  await expect(frame.locator("#inline-sibling")).toHaveCSS("color", "rgb(31, 32, 33)");
  expect(failures).toEqual([{
    phase: "stylesheet",
    url: `${fixture.origin}/styles/inline-missing.css`,
    fatal: false,
  }]);
});

test("keeps valid linked stylesheet rules after a nested import fails", async ({ page }) => {
  await installBundle(page);
  const failures = await mountFrame(page, "/documents/linked.html");
  const frame = page.locator("v-frame");

  await expect(frame.locator("#linked-parent")).toHaveCSS("color", "rgb(41, 42, 43)");
  await expect(frame.locator("#linked-imported")).toHaveCSS("color", "rgb(51, 52, 53)");
  await expect(frame.locator("#linked-sibling")).toHaveCSS("color", "rgb(61, 62, 63)");
  expect(failures).toEqual([{
    phase: "stylesheet",
    url: `${fixture.origin}/styles/linked-missing.css`,
    fatal: false,
  }]);
});
