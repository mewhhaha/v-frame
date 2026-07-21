import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  V_FRAME_GATEWAY_HEADER,
  V_FRAME_GATEWAY_VERSION,
  V_FRAME_REALM_MARKER,
} from "../src/gateway-contract.js";

interface NativeLocationFixture {
  origin: string;
  requests: Array<{ destination: string; path: string }>;
  entryAndMarkerOverlapped(): boolean;
  close(): Promise<void>;
}

function page(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

function reply(
  response: ServerResponse,
  status: number,
  type: string,
  body: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
}

async function startNativeLocationFixture(): Promise<NativeLocationFixture> {
  const requests: NativeLocationFixture["requests"] = [];
  let pendingParallelEntry: ServerResponse | null = null;
  let parallelFallback: ReturnType<typeof setTimeout> | null = null;
  let parallelMarkerRequested = false;
  let parallelRequestsOverlapped = false;
  const bundle = resolve(process.cwd(), "dist/index.js");
  const finishParallelEntry = () => {
    if (pendingParallelEntry === null) {
      return;
    }

    parallelRequestsOverlapped = true;
    if (parallelFallback !== null) {
      clearTimeout(parallelFallback);
      parallelFallback = null;
    }
    pendingParallelEntry.end('<main id="parallel-entry">Parallel entry</main></body></html>');
    pendingParallelEntry = null;
  };
  const scheduleParallelFallback = () => {
    if (parallelFallback !== null || pendingParallelEntry === null) {
      return;
    }
    parallelFallback = setTimeout(() => {
      parallelFallback = null;
      if (pendingParallelEntry !== null) {
        pendingParallelEntry.end(
          '<main id="parallel-entry">Parallel entry</main></body></html>',
        );
        pendingParallelEntry = null;
      }
    }, 1_000);
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    const destination = String(request.headers["sec-fetch-dest"] ?? "");
    requests.push({ destination, path: url.pathname });

    if (url.pathname === "/") {
      return reply(response, 200, "text/html", page('<div id="host"></div>'));
    }
    if (url.pathname === "/adopted") {
      return reply(response, 200, "text/html", page(`
        <v-frame id="adopted-native-frame" adopt src="/routes/entry.html">
          <template shadowrootmode="open">
            <v-html><v-head></v-head><v-body>
              <main id="adopted-copy">Server preview</main>
              <script type="application/vnd.v-frame" data-v-frame-script>
                document.querySelector('#adopted-copy').textContent = 'Adopted native route';
              </script>
            </v-body></v-html>
          </template>
        </v-frame>
        <script type="module">
          const bundle = await import('/dist/index.js');
          bundle.defineVFrame();
        </script>
      `));
    }
    if (url.pathname === "/dist/index.js") {
      if (!existsSync(bundle)) {
        return reply(response, 404, "text/plain", "Build output not found");
      }
      response.writeHead(200, {
        "content-type": "text/javascript",
        "cache-control": "no-store",
      });
      createReadStream(bundle).pipe(response);
      return;
    }
    if (url.pathname === "/routes/parallel.html" && destination === "iframe") {
      parallelMarkerRequested = true;
      finishParallelEntry();
      return reply(
        response,
        200,
        "text/html",
        `<!doctype html><meta name="${V_FRAME_REALM_MARKER}" content="${V_FRAME_GATEWAY_VERSION}">`,
        {
          "Vary": "Sec-Fetch-Dest",
          [V_FRAME_GATEWAY_HEADER]: V_FRAME_GATEWAY_VERSION,
        },
      );
    }
    if (url.pathname === "/routes/parallel.html") {
      response.writeHead(200, {
        "content-type": "text/html",
        "cache-control": "no-store",
        "vary": "Sec-Fetch-Dest",
        [V_FRAME_GATEWAY_HEADER]: V_FRAME_GATEWAY_VERSION,
      });
      response.write("<!doctype html><html><body>");
      pendingParallelEntry = response;
      if (parallelMarkerRequested) {
        finishParallelEntry();
        return;
      }
      scheduleParallelFallback();
      return;
    }
    if (url.pathname.startsWith("/routes/") && destination === "iframe") {
      return reply(
        response,
        200,
        "text/html",
        `<!doctype html><meta name="${V_FRAME_REALM_MARKER}" content="${V_FRAME_GATEWAY_VERSION}">`,
        {
          "Vary": "Sec-Fetch-Dest",
          [V_FRAME_GATEWAY_HEADER]: V_FRAME_GATEWAY_VERSION,
        },
      );
    }
    if (url.pathname === "/routes/entry.html") {
      return reply(
        response,
        200,
        "text/html",
        page(`<main id="native-entry">Native entry</main>
          <button id="hard-navigation">Hard navigation</button>
          <script>
            document.querySelector('#hard-navigation').addEventListener('click', () => {
              location.assign('/routes/destination.html');
            });
          </script>`),
        { [V_FRAME_GATEWAY_HEADER]: V_FRAME_GATEWAY_VERSION },
      );
    }
    if (url.pathname === "/routes/destination.html") {
      return reply(response, 200, "text/html", page(
        '<main id="shell-destination">Top-level destination</main>',
      ));
    }
    if (url.pathname === "/ungated/entry.html") {
      return reply(response, 200, "text/html", page(
        '<main id="ungated-entry">Ungated entry</main>',
      ));
    }
    return reply(response, 404, "text/plain", `No fixture for ${url.pathname}`);
  });
  await new Promise<void>((resolveListening) => {
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("The native Location fixture did not expose a TCP address");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    entryAndMarkerOverlapped: () => parallelRequestsOverlapped,
    close: () => closeServer(server),
  };
}

let fixture: NativeLocationFixture;

test.beforeAll(async () => {
  fixture = await startNativeLocationFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

async function mountFrame(
  pageInstance: import("@playwright/test").Page,
  source = "/routes/entry.html",
) {
  await pageInstance.goto(fixture.origin);
  await pageInstance.evaluate(async (bundleURL) => {
    const bundle = await import(bundleURL);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  await pageInstance.evaluate((frameSource) => {
    const frame = document.createElement("v-frame");
    frame.id = "location-frame";
    frame.setAttribute("src", frameSource);
    document.querySelector("#host")?.append(frame);
  }, source);
  const frame = pageInstance.locator("#location-frame");
  await expect.poll(() => frame.evaluate(
    (element) => (element as HTMLElement & { status: string }).status,
  )).toBe("ready");
  return frame;
}

test("uses an advertised route as the native realm Location", async ({ page: pageInstance }) => {
  const requestStart = fixture.requests.length;
  const frame = await mountFrame(pageInstance);

  await expect(frame.locator("#native-entry")).toHaveText("Native entry");
  expect(await frame.evaluate((element) => (
    element as HTMLElement & { contentWindow: Window | null }
  ).contentWindow?.location.href)).toBe(`${fixture.origin}/routes/entry.html`);
  const routeRequests = fixture.requests.slice(requestStart).filter(
    (request) => request.path === "/routes/entry.html",
  );
  expect(routeRequests).toHaveLength(2);
  expect(routeRequests.map((request) => request.destination).sort()).toEqual([
    "empty",
    "iframe",
  ]);
});

test("loads the entry response and realm marker concurrently", async ({ page: pageInstance }) => {
  const frame = await mountFrame(pageInstance, "/routes/parallel.html");

  await expect(frame.locator("#parallel-entry")).toHaveText("Parallel entry");
  expect(fixture.entryAndMarkerOverlapped()).toBe(true);
});

test("rejects a route that does not return the realm marker", async ({ page: pageInstance }) => {
  await pageInstance.goto(fixture.origin);
  await pageInstance.evaluate(async (bundleURL) => {
    const bundle = await import(bundleURL);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  const failure = await pageInstance.evaluate(async () => {
    const frame = document.createElement("v-frame") as HTMLElement & { status: string };
    const reported = new Promise<{ message: string; phase: string }>((resolve) => {
      frame.addEventListener("v-frame-error", (event) => {
        const detail = (event as CustomEvent<{ error: Error; phase: string }>).detail;
        resolve({ message: detail.error.message, phase: detail.phase });
      }, { once: true });
    });
    frame.setAttribute("src", "/ungated/entry.html");
    document.querySelector("#host")?.append(frame);
    return { failure: await reported, status: frame.status };
  });

  expect(failure).toEqual({
    failure: {
      message: `v-frame route ${fixture.origin}/ungated/entry.html did not return the gateway realm marker`,
      phase: "bootstrap",
    },
    status: "error",
  });
});

test("promotes direct Location navigation to the host document", async ({ page: pageInstance }) => {
  const frame = await mountFrame(pageInstance);
  await frame.locator("#hard-navigation").click();

  await expect(pageInstance).toHaveURL(`${fixture.origin}/routes/destination.html`);
  await expect(pageInstance.locator("#shell-destination")).toHaveText("Top-level destination");
});

test("rebuilds the route-backed realm when direct navigation is canceled", async ({ page: pageInstance }) => {
  const frame = await mountFrame(pageInstance);
  const originalWindow = await frame.evaluateHandle((element) => (
    element as HTMLElement & { contentWindow: Window | null }
  ).contentWindow);
  await frame.evaluate((element) => {
    element.addEventListener("v-frame-navigate", (event) => event.preventDefault(), {
      once: true,
    });
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow;
    child?.location.assign("/routes/destination.html");
  });

  await expect(frame.locator("#native-entry")).toHaveText("Native entry");
  await expect.poll(() => frame.evaluate(
    (element) => (element as HTMLElement & { status: string }).status,
  )).toBe("ready");
  expect(await frame.evaluate((element, previousWindow) => (
    element as HTMLElement & { contentWindow: Window | null }
  ).contentWindow !== previousWindow, originalWindow)).toBe(true);
  expect(pageInstance.url()).toBe(`${fixture.origin}/`);
});

test("activates adopted markup with only the iframe gateway request", async ({ page: pageInstance }) => {
  const requestStart = fixture.requests.length;
  await pageInstance.goto(`${fixture.origin}/adopted`);
  const frame = pageInstance.locator("#adopted-native-frame");

  await expect(frame.locator("#adopted-copy")).toHaveText("Adopted native route");
  await expect.poll(() => frame.evaluate(
    (element) => (element as HTMLElement & { status: string }).status,
  )).toBe("ready");
  expect(fixture.requests.slice(requestStart).filter(
    (request) => request.path === "/routes/entry.html",
  )).toEqual([{ destination: "iframe", path: "/routes/entry.html" }]);
});
