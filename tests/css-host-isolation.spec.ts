import { expect, test } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

interface HostIsolationFixture {
  origin: string;
  close(): Promise<void>;
}

let fixture: HostIsolationFixture;

function reply(response: ServerResponse, status: number, type: string, source: string) {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(source);
}

function documentSource() {
  return `<!doctype html><html><head><link rel="stylesheet" href="/assets/css-host-isolation.css"></head><body><p id="page-content">Page content</p></body></html>`;
}

function stylesheetSource() {
  return `
    :host { background-color: rgb(201, 2, 3) !important; }
    :host-context(.host-context) { width: 1px !important; }
    :host, body { color: rgb(4, 5, 6); min-height: 40px; }
  `;
}

async function startFixture(): Promise<HostIsolationFixture> {
  const bundle = resolve(process.cwd(), "dist/index.js");
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.test").pathname;
    if (path === "/") {
      return reply(response, 200, "text/html", '<!doctype html><div id="host" class="host-context" style="width: 240px"></div>');
    }
    if (path === "/dist/index.js") {
      if (!existsSync(bundle)) {
        return reply(response, 404, "text/plain", "Build output not found");
      }
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      createReadStream(bundle).pipe(response);
      return;
    }
    if (path === "/documents/css-host-isolation.html") {
      return reply(response, 200, "text/html", documentSource());
    }
    if (path === "/assets/css-host-isolation.css") {
      return reply(response, 200, "text/css", stylesheetSource());
    }
    return reply(response, 404, "text/plain", `No fixture for ${path}`);
  });

  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("CSS host-isolation fixture did not expose a TCP address");
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

test("page :host and :host-context selectors cannot style the v-frame host", async ({ page }) => {
  await page.goto(fixture.origin);
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);

  await page.evaluate((origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & { src: string };
    frame.src = `${origin}/documents/css-host-isolation.html`;
    document.querySelector("#host")?.append(frame);
  }, fixture.origin);

  const frame = page.locator("v-frame");
  await expect.poll(() => frame.evaluate((element) => (element as any).status)).toBe("ready");
  await expect(frame).toHaveCSS("display", "block");
  await expect(frame).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(frame).toHaveJSProperty("offsetWidth", 240);
  await expect(frame.locator("#page-content")).toHaveCSS("color", "rgb(4, 5, 6)");
  await expect(frame.locator("v-body")).toHaveCSS("min-height", "40px");
});
