import type { IncomingMessage } from "node:http";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  bundleRoute,
  requestPathname,
  type Route,
  startHTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

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

let fixture: NetworkFixture;

function observeRequest(request: IncomingMessage): Promise<ObservedRequest> {
  return new Promise((resolveObserved) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () =>
      resolveObserved({
        body,
        cookie: request.headers.cookie ?? "",
        method: request.method ?? "",
        path: requestPathname(request),
        requestHeader: String(request.headers["x-network-request"] ?? ""),
      }),
    );
  });
}

/**
 * Anything the route table does not name is echoed back as JSON, which is how the guest
 * observes what its request actually carried.
 */
function echoRequest(
  requests: ObservedRequest[],
  headers?: Record<string, string>,
): Route {
  return async (request) => {
    const path = requestPathname(request);
    if (path.endsWith("/worker.js")) {
      return {
        type: "text/javascript",
        body: "self.postMessage(self.location.pathname);",
      };
    }
    if (path.endsWith("/shared-worker.js")) {
      return {
        type: "text/javascript",
        body: "onconnect = (event) => event.ports[0].postMessage(self.location.pathname);",
      };
    }
    const observed = await observeRequest(request);
    requests.push(observed);
    return {
      type: "application/json",
      body: JSON.stringify(observed),
      ...(headers === undefined ? {} : { headers }),
    };
  };
}

async function startNetworkFixture(): Promise<NetworkFixture> {
  const requests: ObservedRequest[] = [];
  const primary = await startHTTPFixture({
    record: () => undefined,
    routes: {
      "/": '<!doctype html><div id="host"></div>',
      "/dist/index.js": bundleRoute,
      "/documents/network.html":
        '<!doctype html><html><head><base href="http://["><base id="network-base" href="/initial-base/"></head><body></body></html>',
    },
    fallback: echoRequest(requests),
  });
  const cors = await startHTTPFixture({
    record: () => undefined,
    routes: {},
    fallback: echoRequest(requests, {
      "access-control-allow-credentials": "true",
      "access-control-allow-origin": primary.origin,
    }),
  });

  return {
    origin: primary.origin,
    corsOrigin: cors.origin,
    requests,
    close: () => Promise.all([primary.close(), cors.close()]).then(() => undefined),
  };
}

test.beforeAll(async () => {
  fixture = await startNetworkFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

function mountNetworkFrame(
  page: Page,
  id: string,
  credentials: "omit" | "same-origin" | "include",
): Promise<Locator> {
  return mountFrame(page, {
    src: `${fixture.origin}/documents/network.html`,
    id,
    credentials,
  });
}

test("network constructors and requests follow the live first-valid document base", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountNetworkFrame(page, "dynamic-base", "same-origin");

  const result = await frame.evaluate(async (element) => {
    const window = (
      element as HTMLElement & {
        contentWindow: Window & typeof globalThis & typeof globalThis;
      }
    ).contentWindow;
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
      const sharedWorker = new window.SharedWorker("shared-worker.js", {
        name: basePath,
      });
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
  await expect
    .poll(() =>
      fixture.requests
        .filter((request) => request.path.endsWith("/beacon"))
        .map((request) => request.path),
    )
    .toEqual(["/first-base/beacon", "/second-base/beacon"]);
});

test("foreign-realm POST Requests preserve metadata, consume bodies, and use child-realm TypeErrors", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await mountNetworkFrame(page, "foreign-request", "same-origin");

  const result = await page.evaluate(
    async ({ origin }) => {
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
    },
    { origin: fixture.origin },
  );

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

test("include-mode XHR keeps an explicit withCredentials opt-out", async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: "network_cross_origin",
      value: "present",
      url: fixture.corsOrigin,
      sameSite: "Lax",
    },
  ]);
  await installBundle(page, fixture.origin);
  const frame = await mountNetworkFrame(page, "xhr-opt-out", "include");

  const result = await frame.evaluate(async (element, corsOrigin) => {
    const window = (
      element as HTMLElement & {
        contentWindow: Window & typeof globalThis & typeof globalThis;
      }
    ).contentWindow;
    const request = (path: string, optOut: boolean) =>
      new Promise<{ response: unknown; withCredentials: boolean }>((resolveRequest) => {
        const xhr = new window.XMLHttpRequest();
        xhr.open("GET", `${corsOrigin}${path}`);
        if (optOut) {
          xhr.withCredentials = false;
        }
        xhr.responseType = "json";
        xhr.onloadend = () =>
          resolveRequest({
            response: xhr.response,
            withCredentials: xhr.withCredentials,
          });
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
  expect(
    fixture.requests.filter((request) => request.path.startsWith("/credentials/")),
  ).toEqual([
    expect.objectContaining({
      cookie: "network_cross_origin=present",
      path: "/credentials/default",
    }),
    expect.objectContaining({ cookie: "", path: "/credentials/opt-out" }),
  ]);
});
