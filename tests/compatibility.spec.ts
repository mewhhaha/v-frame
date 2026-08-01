import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

interface CompatibilityFixture {
  origin: string;
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
  return {
    origin: `http://127.0.0.1:${hostAddress.port}`,
    close: () => closeServer(host),
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
  await expect.poll(() => frame.evaluate((element: HTMLElement & { status: string }) => element.status)).toBe("ready");
  return frame;
}

test("rejects a cross-origin application route", async ({ page }) => {
  await installBundle(page);
  const failure = await page.evaluate(async () => {
    const frame = document.createElement("v-frame") as HTMLElement & { status: string };
    const reported = new Promise<{ message: string; phase: string }>((resolve) => {
      frame.addEventListener("v-frame-error", (event) => {
        const detail = (event as CustomEvent<{ error: Error; phase: string }>).detail;
        resolve({ message: detail.error.message, phase: detail.phase });
      }, { once: true });
    });
    frame.setAttribute("src", "https://application.invalid/orders");
    document.querySelector("#host")?.append(frame);
    return { failure: await reported, status: frame.status };
  });

  expect(failure).toEqual({
    failure: {
      message: `v-frame route https://application.invalid/orders must share host origin ${fixture.origin}`,
      phase: "entry",
    },
    status: "error",
  });
});

test("reconstructs a source that declares restrictive CSP and framing headers", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "restrictive-headers", `${fixture.origin}/documents/restrictive-headers.html`);

  await expect(frame.locator("#script-result")).toHaveText("ran");
  await expect.poll(() => frame.evaluate((element: HTMLElement & { currentURL: string | null }) => element.currentURL)).toBe(
    `${fixture.origin}/documents/restrictive-headers.html`,
  );
});

test("loads an allowed same-context GET form inside the guest", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "native-form", `${fixture.origin}/documents/native-form.html`);
  const hostURL = page.url();
  await page.evaluate(() => {
    document.querySelector("#native-form")?.addEventListener("v-frame-navigate", (event) => {
      const detail = (event as CustomEvent<{ kind: string; to: string }>).detail;
      sessionStorage.setItem("compatibility-navigation", JSON.stringify({
        kind: detail.kind,
        to: detail.to,
      }));
    });
  });

  await frame.locator("#native-form button").click();
  await expect(frame.locator("#form-target")).toHaveText("Form destination");
  await expect.poll(() => frame.evaluate((element) =>
    (element as HTMLElement & { currentURL: string | null }).currentURL
  )).toBe(`${fixture.origin}/documents/form-target.html?query=compatibility`);
  expect(page.url()).toBe(hostURL);
  expect(await page.evaluate(() => JSON.parse(
    sessionStorage.getItem("compatibility-navigation") ?? "null",
  ))).toEqual({
    kind: "form",
    to: `${fixture.origin}/documents/form-target.html?query=compatibility`,
  });
});
