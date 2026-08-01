import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

interface ObservedRequest {
  body: string;
  cookie: string;
  method: string;
  path: string;
  requestHeader: string;
}

interface NetworkFixture {
  origin: string;
  corsOrigin: string;
  requests: ObservedRequest[];
  close(): Promise<void>;
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

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://network-fixture.test").pathname;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The network fixture did not expose a TCP port"));
        return;
      }
      resolveListening(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
}

function observeRequest(request: IncomingMessage): Promise<ObservedRequest> {
  return new Promise((resolveObserved) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolveObserved({
      body,
      cookie: request.headers.cookie ?? "",
      method: request.method ?? "",
      path: requestPath(request),
      requestHeader: String(request.headers["x-network-request"] ?? ""),
    }));
  });
}

async function startNetworkFixture(): Promise<NetworkFixture> {
  const requests: ObservedRequest[] = [];
  const bundle = resolve(process.cwd(), "dist/index.js");
  let origin = "";

  const primary = createServer(async (request, response) => {
    const path = requestPath(request);
    if (path === "/") {
      reply(response, 200, "text/html", '<!doctype html><div id="host"></div>');
      return;
    }
    if (path === "/dist/index.js") {
      if (!existsSync(bundle)) {
        reply(response, 404, "text/plain", "Build output not found");
        return;
      }
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      createReadStream(bundle).pipe(response);
      return;
    }
    if (path === "/documents/network.html") {
      reply(
        response,
        200,
        "text/html",
        '<!doctype html><html><head><base href="http://["><base id="network-base" href="/initial-base/"></head><body></body></html>',
      );
      return;
    }
    if (path.endsWith("/worker.js")) {
      reply(response, 200, "text/javascript", "self.postMessage(self.location.pathname);");
      return;
    }
    if (path.endsWith("/shared-worker.js")) {
      reply(response, 200, "text/javascript", "onconnect = (event) => event.ports[0].postMessage(self.location.pathname);");
      return;
    }

    const observed = await observeRequest(request);
    requests.push(observed);
    reply(response, 200, "application/json", JSON.stringify(observed));
  });
  const primaryPort = await listen(primary);
  origin = `http://127.0.0.1:${primaryPort}`;

  const cors = createServer(async (request, response) => {
    const observed = await observeRequest(request);
    requests.push(observed);
    reply(response, 200, "application/json", JSON.stringify(observed), {
      "access-control-allow-credentials": "true",
      "access-control-allow-origin": origin,
    });
  });
  const corsPort = await listen(cors);

  return {
    origin,
    corsOrigin: `http://127.0.0.1:${corsPort}`,
    requests,
    close: () => Promise.all([close(primary), close(cors)]).then(() => undefined),
  };
}

let fixture: NetworkFixture;

test.beforeAll(async () => {
  fixture = await startNetworkFixture();
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
  credentials: "omit" | "same-origin" | "include",
): Promise<import("@playwright/test").Locator> {
  await page.evaluate(({ frameID, frameCredentials, source }) => {
    const frame = document.createElement("v-frame");
    frame.id = frameID;
    frame.setAttribute("credentials", frameCredentials);
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
  }, {
    frameID: id,
    frameCredentials: credentials,
    source: `${fixture.origin}/documents/network.html`,
  });
  const frame = page.locator(`v-frame#${id}`);
  await expect.poll(() => frame.evaluate((element: HTMLElement & { status: string }) => element.status)).toBe("ready");
  return frame;
}

test("network constructors and requests follow the live first-valid document base", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "dynamic-base", "same-origin");

  const result = await frame.evaluate(async (element) => {
    const window = (element as HTMLElement & { contentWindow: Window & typeof globalThis & typeof globalThis }).contentWindow;
    const run = async (basePath: string) => {
      window.document.querySelector("#network-base")?.setAttribute("href", basePath);

      const requestURL = new window.Request("request").url;
      const fetchURL = (await window.fetch("fetch")).url;
      const xhrURL = await new Promise<string>((resolveResponse) => {
        const xhr = new window.XMLHttpRequest();
        xhr.open("GET", "xhr");
        xhr.onloadend = () => resolveResponse(xhr.responseURL);
        xhr.send();
      });
      const webSocket = new window.WebSocket("socket");
      const webSocketURL = webSocket.url;
      webSocket.close();
      const eventSource = new window.EventSource("events");
      const eventSourceURL = eventSource.url;
      eventSource.close();
      const worker = new window.Worker("worker.js");
      const workerPath = await new Promise<string>((resolvePath) => {
        worker.onmessage = (event) => resolvePath(String(event.data));
      });
      worker.terminate();
      const sharedWorker = new window.SharedWorker("shared-worker.js", { name: basePath });
      const sharedWorkerPath = await new Promise<string>((resolvePath) => {
        sharedWorker.port.onmessage = (event) => resolvePath(String(event.data));
        sharedWorker.port.start();
      });
      sharedWorker.port.close();
      const beaconAccepted = window.navigator.sendBeacon("beacon", basePath);

      return {
        beaconAccepted,
        eventSourceURL,
        fetchURL,
        requestURL,
        sharedWorkerPath,
        webSocketURL,
        workerPath,
        xhrURL,
      };
    };

    return [await run("/first-base/"), await run("/second-base/")];
  });

  expect(result).toEqual([
    {
      beaconAccepted: true,
      eventSourceURL: `${fixture.origin}/first-base/events`,
      fetchURL: `${fixture.origin}/first-base/fetch`,
      requestURL: `${fixture.origin}/first-base/request`,
      sharedWorkerPath: "/first-base/shared-worker.js",
      webSocketURL: fixture.origin.replace("http:", "ws:") + "/first-base/socket",
      workerPath: "/first-base/worker.js",
      xhrURL: `${fixture.origin}/first-base/xhr`,
    },
    {
      beaconAccepted: true,
      eventSourceURL: `${fixture.origin}/second-base/events`,
      fetchURL: `${fixture.origin}/second-base/fetch`,
      requestURL: `${fixture.origin}/second-base/request`,
      sharedWorkerPath: "/second-base/shared-worker.js",
      webSocketURL: fixture.origin.replace("http:", "ws:") + "/second-base/socket",
      workerPath: "/second-base/worker.js",
      xhrURL: `${fixture.origin}/second-base/xhr`,
    },
  ]);
  await expect.poll(() => fixture.requests.filter((request) => request.path.endsWith("/beacon")).map((request) => request.path)).toEqual([
    "/first-base/beacon",
    "/second-base/beacon",
  ]);
});

test("foreign-realm POST Requests preserve metadata, consume bodies, and use child-realm TypeErrors", async ({ page }) => {
  await installBundle(page);
  await mountFrame(page, "foreign-request", "same-origin");

  const result = await page.evaluate(async ({ origin }) => {
    const frame = document.querySelector("v-frame#foreign-request") as HTMLElement & {
      contentWindow: Window & typeof globalThis & typeof globalThis;
    };
    const childWindow = frame.contentWindow;
    const directRequest = new Request(`${origin}/foreign/direct`, {
      body: "direct body",
      credentials: "include",
      headers: { "x-network-request": "direct header" },
      method: "POST",
    });
    const directResponse = await childWindow.fetch(directRequest);
    const directRequestBodyUsed = directRequest.bodyUsed;

    const sourceRequest = new Request(`${origin}/foreign/constructed`, {
      body: "constructed body",
      credentials: "include",
      headers: { "x-network-request": "constructed header" },
      method: "POST",
    });
    const childRequest = new childWindow.Request(sourceRequest);
    const constructedResponse = await childWindow.fetch(childRequest);
    const constructedRequestBodyUsed = childRequest.bodyUsed;

    const usedRequest = new Request(`${origin}/foreign/used`, {
      body: "used body",
      method: "POST",
    });
    await usedRequest.text();
    let usedRequestError: { isChildTypeError: boolean; name: string } | null = null;
    try {
      new childWindow.Request(usedRequest);
    } catch (error) {
      usedRequestError = {
        isChildTypeError: error instanceof childWindow.TypeError,
        name: (error as Error).name,
      };
    }

    return {
      constructed: await constructedResponse.json(),
      constructedRequest: {
        bodyUsed: constructedRequestBodyUsed,
        credentials: childRequest.credentials,
        method: childRequest.method,
        requestHeader: childRequest.headers.get("x-network-request"),
        url: childRequest.url,
      },
      direct: await directResponse.json(),
      directRequestBodyUsed,
      usedRequestError,
    };
  }, { origin: fixture.origin });

  expect(result).toEqual({
    constructed: {
      body: "constructed body",
      cookie: "",
      method: "POST",
      path: "/foreign/constructed",
      requestHeader: "constructed header",
    },
    constructedRequest: {
      bodyUsed: true,
      credentials: "include",
      method: "POST",
      requestHeader: "constructed header",
      url: `${fixture.origin}/foreign/constructed`,
    },
    direct: {
      body: "direct body",
      cookie: "",
      method: "POST",
      path: "/foreign/direct",
      requestHeader: "direct header",
    },
    directRequestBodyUsed: true,
    usedRequestError: { isChildTypeError: true, name: "TypeError" },
  });
});

test("include-mode XHR keeps an explicit withCredentials opt-out", async ({ page, context }) => {
  await context.addCookies([{
    name: "network_cross_origin",
    value: "present",
    url: fixture.corsOrigin,
    sameSite: "Lax",
  }]);
  await installBundle(page);
  const frame = await mountFrame(page, "xhr-opt-out", "include");

  const result = await frame.evaluate(async (element, corsOrigin) => {
    const window = (element as HTMLElement & { contentWindow: Window & typeof globalThis & typeof globalThis }).contentWindow;
    const request = (path: string, optOut: boolean) => new Promise<{ response: unknown; withCredentials: boolean }>((resolveRequest) => {
      const xhr = new window.XMLHttpRequest();
      xhr.open("GET", `${corsOrigin}${path}`);
      if (optOut) {
        xhr.withCredentials = false;
      }
      xhr.responseType = "json";
      xhr.onloadend = () => resolveRequest({ response: xhr.response, withCredentials: xhr.withCredentials });
      xhr.send();
    });

    return {
      defaulted: await request("/credentials/default", false),
      optedOut: await request("/credentials/opt-out", true),
    };
  }, fixture.corsOrigin);

  expect(result).toEqual({
    defaulted: {
      response: {
        body: "",
        cookie: "network_cross_origin=present",
        method: "GET",
        path: "/credentials/default",
        requestHeader: "",
      },
      withCredentials: true,
    },
    optedOut: {
      response: {
        body: "",
        cookie: "",
        method: "GET",
        path: "/credentials/opt-out",
        requestHeader: "",
      },
      withCredentials: false,
    },
  });
  expect(fixture.requests.filter((request) => request.path.startsWith("/credentials/"))).toEqual([
    expect.objectContaining({ cookie: "network_cross_origin=present", path: "/credentials/default" }),
    expect.objectContaining({ cookie: "", path: "/credentials/opt-out" }),
  ]);
});
