import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

interface CompatibilityFixture {
  origin: string;
  sourceOrigin: string;
  close(): Promise<void>;
}

function documentPage(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

function pathname(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://fixture.test").pathname;
}

function reply(
  response: ServerResponse,
  status: number,
  type: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  response.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
}

async function startCompatibilityFixture(): Promise<CompatibilityFixture> {
  const bundle = resolve(process.cwd(), "dist/index.js");
  let origin = "";
  const host = createServer((request, response) => {
    const path = pathname(request);
    if (path === "/") return reply(response, 200, "text/html", documentPage('<div id="host"></div>'));
    if (path === "/dist/index.js") {
      if (!existsSync(bundle)) return reply(response, 404, "text/plain", "Build output not found");
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      createReadStream(bundle).pipe(response);
      return;
    }
    if (path === "/documents/restrictive-headers.html") {
      return reply(
        response,
        200,
        "text/html",
        documentPage('<output id="script-result">pending</output><script>document.querySelector("#script-result").textContent = "ran";</script>'),
        {
          "content-security-policy": "default-src 'none'; script-src 'none'; frame-ancestors 'none'",
          "x-frame-options": "DENY",
        },
      );
    }
    if (path === "/documents/native-form.html") {
      return reply(
        response,
        200,
        "text/html",
        documentPage('<form id="native-form" action="/documents/form-target.html" method="get" target="_self"><input name="query" value="compatibility"><button>Submit</button></form>'),
      );
    }
    if (path === "/documents/form-target.html") {
      return reply(
        response,
        200,
        "text/html",
        documentPage('<main id="form-target">Form destination</main>'),
      );
    }
    return reply(response, 404, "text/plain", `No host fixture for ${path}`);
  });
  await new Promise<void>((resolveListening) => host.listen(0, "127.0.0.1", resolveListening));
  const hostAddress = host.address();
  if (hostAddress === null || typeof hostAddress === "string") {
    throw new Error("The compatibility host fixture did not expose a TCP address");
  }
  origin = `http://127.0.0.1:${hostAddress.port}`;

  const source = createServer((request, response) => {
    const path = pathname(request);
    const corsHeaders = { "access-control-allow-origin": origin };
    if (path === "/documents/cross-origin.html") {
      return reply(
        response,
        200,
        "text/html",
        documentPage(`<output id="entry-origin">pending</output><script>
          document.cookie = "vframe_compatibility_cookie=host-origin; Path=/; SameSite=Lax";
          localStorage.setItem("vframe_compatibility_storage", "host-origin");
          sessionStorage.setItem("vframe_compatibility_session", "host-origin");
          document.querySelector("#entry-origin").textContent = location.origin;
        </script>`),
        corsHeaders,
      );
    }
    return reply(response, 404, "text/plain", `No source fixture for ${path}`, corsHeaders);
  });
  await new Promise<void>((resolveListening) => source.listen(0, "127.0.0.1", resolveListening));
  const sourceAddress = source.address();
  if (sourceAddress === null || typeof sourceAddress === "string") {
    await closeServer(host);
    throw new Error("The compatibility source fixture did not expose a TCP address");
  }

  return {
    origin,
    sourceOrigin: `http://127.0.0.1:${sourceAddress.port}`,
    async close() {
      await Promise.all([closeServer(host), closeServer(source)]);
    },
  };
}

let fixture: CompatibilityFixture;

test.beforeAll(async () => {
  fixture = await startCompatibilityFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

async function installBundle(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(fixture.origin);
  await page.evaluate(async (bundleURL) => {
    const bundle = await import(bundleURL);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  await expect.poll(() => page.evaluate(() => Boolean(customElements.get("v-frame")))).toBe(true);
}

async function mountFrame(
  page: import("@playwright/test").Page,
  id: string,
  source: string,
) {
  await page.evaluate(({ frameID, frameSource }) => {
    const frame = document.createElement("v-frame");
    frame.id = frameID;
    frame.setAttribute("src", frameSource);
    document.querySelector("#host")?.append(frame);
  }, { frameID: id, frameSource: source });
  const frame = page.locator(`v-frame#${id}`);
  await expect.poll(() => frame.evaluate((element) => (element as { status: string }).status)).toBe("ready");
  return frame;
}

async function childValue<T>(
  frame: import("@playwright/test").Locator,
  expression: (window: Window & typeof globalThis) => T,
): Promise<T> {
  return frame.evaluate((element, source) => {
    const evaluate = new Function("window", `return (${source})(window)`);
    return evaluate((element as HTMLElement & { contentWindow: Window | null }).contentWindow);
  }, expression.toString()) as Promise<T>;
}

test("runs a CORS entry with host-origin location, storage, and cookies", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "cross-origin", `${fixture.sourceOrigin}/documents/cross-origin.html`);

  try {
    await expect(frame.locator("#entry-origin")).toHaveText(fixture.origin);
    const childState = await childValue(frame, (window) => ({
      origin: window.location.origin,
      localStorage: window.localStorage.getItem("vframe_compatibility_storage"),
      sessionStorage: window.sessionStorage.getItem("vframe_compatibility_session"),
      cookie: window.document.cookie,
    }));
    const hostState = await page.evaluate(() => ({
      origin: location.origin,
      localStorage: localStorage.getItem("vframe_compatibility_storage"),
      sessionStorage: sessionStorage.getItem("vframe_compatibility_session"),
      cookie: document.cookie,
    }));

    expect(childState).toEqual({
      origin: fixture.origin,
      localStorage: "host-origin",
      sessionStorage: "host-origin",
      cookie: expect.stringContaining("vframe_compatibility_cookie=host-origin"),
    });
    expect(hostState).toEqual({
      origin: fixture.origin,
      localStorage: "host-origin",
      sessionStorage: "host-origin",
      cookie: expect.stringContaining("vframe_compatibility_cookie=host-origin"),
    });
  } finally {
    await page.evaluate(() => {
      localStorage.removeItem("vframe_compatibility_storage");
      sessionStorage.removeItem("vframe_compatibility_session");
      document.cookie = "vframe_compatibility_cookie=; Max-Age=0; Path=/; SameSite=Lax";
    });
  }
});

test("reconstructs a source that declares restrictive CSP and framing headers", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "restrictive-headers", `${fixture.origin}/documents/restrictive-headers.html`);

  await expect(frame.locator("#script-result")).toHaveText("ran");
  await expect.poll(() => frame.evaluate((element) => (element as { currentURL: string | null }).currentURL)).toBe(
    `${fixture.origin}/documents/restrictive-headers.html`,
  );
});

test("loads an allowed same-context GET form destination", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "native-form", `${fixture.origin}/documents/native-form.html`);
  const hostURL = page.url();

  await page.evaluate(() => {
    const navigations: Array<{ kind: string; to: string }> = [];
    document.querySelector("#native-form")?.addEventListener("v-frame-navigate", (event) => {
      const detail = (event as CustomEvent<{ kind: string; to: string }>).detail;
      navigations.push({ kind: detail.kind, to: detail.to });
    });
    (window as Window & { compatibilityNavigations?: typeof navigations }).compatibilityNavigations = navigations;
  });

  await frame.locator("#native-form button").click();
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { compatibilityNavigations?: unknown[] }).compatibilityNavigations?.length ?? 0,
  )).toBe(1);

  expect(await page.evaluate(() => (window as Window & {
    compatibilityNavigations: Array<{ kind: string; to: string }>;
  }).compatibilityNavigations)).toEqual([{
    kind: "form",
    to: `${fixture.origin}/documents/form-target.html?query=compatibility`,
  }]);
  await expect.poll(() => frame.evaluate(
    (element) => (element as { currentURL: string | null }).currentURL,
  )).toBe(`${fixture.origin}/documents/form-target.html?query=compatibility`);
  expect(page.url()).toBe(hostURL);
  await expect(frame.locator("#form-target")).toHaveText("Form destination");
});
