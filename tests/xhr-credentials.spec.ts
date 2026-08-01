import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

interface ObservedRequest {
  path: string;
  cookie: string;
}

interface XHRFixture {
  origin: string;
  requests: ObservedRequest[];
  close(): Promise<void>;
}

function reply(
  response: ServerResponse,
  status: number,
  type: string,
  body: string,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    ...headers,
  });
  response.end(body);
}

function page(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://fixture.test").pathname;
}

async function startXHRFixture(): Promise<XHRFixture> {
  const bundle = resolve(process.cwd(), "dist/index.js");
  const requests: ObservedRequest[] = [];
  const server = createServer((request, response) => {
    const path = requestPath(request);
    requests.push({ path, cookie: request.headers.cookie ?? "" });
    if (path === "/")
      return reply(response, 200, "text/html", page('<div id="host"></div>'));
    if (path === "/dist/index.js") {
      if (!existsSync(bundle))
        return reply(response, 404, "text/plain", "Build output not found");
      response.writeHead(200, {
        "content-type": "text/javascript",
        "cache-control": "no-store",
      });
      createReadStream(bundle).pipe(response);
      return;
    }
    if (path === "/documents/xhr.html")
      return reply(
        response,
        200,
        "text/html",
        page('<link rel="stylesheet" href="/styles/guest.css"><main>XHR fixture</main>'),
      );
    if (path === "/styles/guest.css")
      return reply(response, 200, "text/css", "main { color: rgb(1, 2, 3); }");
    if (path === "/api/xhr-echo") {
      return reply(
        response,
        200,
        "application/json",
        JSON.stringify({
          cookie: request.headers.cookie ?? "",
          method: request.method,
          requestHeader: request.headers["x-fixture-request"] ?? "",
        }),
        { "x-fixture-response": "visible" },
      );
    }
    if (path === "/api/slow") {
      setTimeout(() => reply(response, 200, "text/plain", "slow response"), 250);
      return;
    }
    if (path === "/api/slow-stream") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "cache-control": "no-store",
      });
      response.write("first chunk");
      setTimeout(() => response.end("second chunk"), 250);
      return;
    }
    if (path === "/api/teardown-stream") {
      response.writeHead(200, {
        "content-type": "text/plain",
        "cache-control": "no-store",
      });
      response.write("x".repeat(64 * 1024));
      const timer = setTimeout(() => response.end("second chunk"), 5_000);
      response.once("close", () => clearTimeout(timer));
      return;
    }
    return reply(response, 404, "text/plain", `No XHR fixture for ${path}`);
  });
  await new Promise<void>((resolveListening) =>
    server.listen(0, "127.0.0.1", resolveListening),
  );
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The XHR fixture did not expose a TCP address");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      await new Promise<void>((resolveClosed, reject) =>
        server.close((error) => (error ? reject(error) : resolveClosed())),
      );
    },
  };
}

let fixture: XHRFixture;

test.beforeAll(async () => {
  fixture = await startXHRFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

async function installBundle(page: import("@playwright/test").Page) {
  await page.goto(fixture.origin);
  await page.evaluate(async (bundleURL) => {
    const bundle = await import(bundleURL);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);
}

async function addHostCookie(page: import("@playwright/test").Page) {
  await page.context().addCookies([
    {
      name: "xhr_host_cookie",
      value: "present",
      url: fixture.origin,
      sameSite: "Lax",
    },
  ]);
}

async function mountFrame(
  page: import("@playwright/test").Page,
  id: string,
  credentials: "omit" | "same-origin" | "include",
) {
  await page.evaluate(
    ({ frameID, frameSource, frameCredentials }) => {
      const frame = document.createElement("v-frame");
      frame.id = frameID;
      frame.setAttribute("credentials", frameCredentials);
      frame.setAttribute("src", frameSource);
      document.querySelector("#host")?.append(frame);
    },
    {
      frameID: id,
      frameSource: `${fixture.origin}/documents/xhr.html`,
      frameCredentials: credentials,
    },
  );
  const frame = page.locator(`v-frame#${id}`);
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  return frame;
}

async function childValue<T, Argument = undefined>(
  frame: import("@playwright/test").Locator,
  expression: (window: Window & typeof globalThis, argument: Argument) => T,
  argument?: Argument,
): Promise<T> {
  return frame.evaluate(
    (element, values) => {
      const evaluate = new Function(
        "window",
        "argument",
        `return (${values.source})(window, argument)`,
      );
      return evaluate(
        (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
          .contentWindow,
        values.argument,
      );
    },
    { source: expression.toString(), argument },
  ) as Promise<T>;
}

test("applies the credentials mode to the entry document and stylesheet fetches", async ({
  page,
}) => {
  await addHostCookie(page);
  await installBundle(page);

  const observed = new Map<string, ObservedRequest[]>();
  for (const credentials of ["omit", "same-origin", "include"] as const) {
    const before = fixture.requests.length;
    await mountFrame(page, `entry-${credentials}`, credentials);
    observed.set(
      credentials,
      fixture.requests
        .slice(before)
        .filter(
          (request) =>
            request.path === "/documents/xhr.html" ||
            request.path === "/styles/guest.css",
        ),
    );
  }

  expect(observed.get("omit")).toEqual([
    { path: "/documents/xhr.html", cookie: "" },
    { path: "/styles/guest.css", cookie: "" },
  ]);
  expect(observed.get("same-origin")).toEqual([
    { path: "/documents/xhr.html", cookie: "xhr_host_cookie=present" },
    { path: "/styles/guest.css", cookie: "xhr_host_cookie=present" },
  ]);
  expect(observed.get("include")).toEqual([
    { path: "/documents/xhr.html", cookie: "xhr_host_cookie=present" },
    { path: "/styles/guest.css", cookie: "xhr_host_cookie=present" },
  ]);
});

test("resolves native XHR against the guest base and preserves headers, JSON, and events", async ({
  page,
}) => {
  await addHostCookie(page);
  await installBundle(page);

  const frame = await mountFrame(page, "same-origin-xhr", "same-origin");
  const result = await childValue(frame, async (window) => {
    const xhr = new window.XMLHttpRequest();
    const events: string[] = [];
    // Native XHR may report LOADING more than once for a chunked response, so
    // only transitions are recorded.
    const record = (event: string) => {
      if (events[events.length - 1] !== event) {
        events.push(event);
      }
    };
    xhr.addEventListener("readystatechange", () => record(`state:${xhr.readyState}`));
    xhr.addEventListener("loadstart", () => record("loadstart"));
    xhr.addEventListener("load", () => record("load"));
    xhr.open("GET", "/api/xhr-echo");
    xhr.setRequestHeader("x-fixture-request", "set");
    xhr.responseType = "json";
    return await new Promise<{ allHeaders: string; [field: string]: unknown }>(
      (resolve) => {
        xhr.onloadend = () => {
          let responseTextError = "";
          try {
            void xhr.responseText;
          } catch (error) {
            responseTextError = (error as DOMException).name;
          }
          resolve({
            events,
            instanceOfExposedConstructor: xhr instanceof window.XMLHttpRequest,
            withCredentials: xhr.withCredentials,
            status: xhr.status,
            responseURL: xhr.responseURL,
            response: xhr.response,
            responseHeader: xhr.getResponseHeader("x-fixture-response"),
            allHeaders: xhr.getAllResponseHeaders(),
            responseTextError,
          });
        };
        xhr.send();
      },
    );
  });

  expect(result).toMatchObject({
    events: ["state:1", "loadstart", "state:2", "state:3", "state:4", "load"],
    instanceOfExposedConstructor: true,
    withCredentials: false,
    status: 200,
    responseURL: `${fixture.origin}/api/xhr-echo`,
    response: {
      cookie: "xhr_host_cookie=present",
      method: "GET",
      requestHeader: "set",
    },
    responseHeader: "visible",
    responseTextError: "InvalidStateError",
  });
  expect(result.allHeaders).toContain("x-fixture-response: visible");

  const included = await mountFrame(page, "include-xhr", "include");
  const includedResult = await childValue(included, async (window) => {
    const xhr = new window.XMLHttpRequest();
    xhr.open("GET", "/api/xhr-echo");
    xhr.responseType = "json";
    return await new Promise((resolve) => {
      xhr.onloadend = () =>
        resolve({ withCredentials: xhr.withCredentials, response: xhr.response });
      xhr.send();
    });
  });
  expect(includedResult).toEqual({
    withCredentials: true,
    response: { cookie: "xhr_host_cookie=present", method: "GET", requestHeader: "" },
  });
});

test("disposal aborts reentrant XHR sends", async ({ page }) => {
  await installBundle(page);

  await mountFrame(page, "reentrant", "same-origin");
  await page.evaluate(async () => {
    const frame = document.querySelector("#reentrant") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The reentrant XHR frame did not expose its child window");
    }

    return new Promise<void>((resolve) => {
      const xhr = new child.XMLHttpRequest();
      (window as Window & { reentrantXHR?: XMLHttpRequest }).reentrantXHR = xhr;
      let sentReentrantRequest = false;
      xhr.onreadystatechange = () => {
        if (sentReentrantRequest && xhr.readyState === xhr.LOADING) {
          resolve();
        }
      };
      xhr.onloadend = () => {
        if (!sentReentrantRequest) {
          sentReentrantRequest = true;
          xhr.open("GET", "/api/slow-stream");
          xhr.send();
        }
      };
      xhr.open("GET", "/api/xhr-echo");
      xhr.send();
    });
  });
  await page.evaluate(() => document.querySelector("#reentrant")?.remove());
  await page.waitForTimeout(50);
  const result = await page.evaluate(() => {
    const host = window as Window & { reentrantXHR?: XMLHttpRequest };
    const xhr = host.reentrantXHR;
    delete host.reentrantXHR;
    return { readyState: xhr?.readyState, status: xhr?.status };
  });

  expect(result.status).toBe(0);
  expect([0, 4]).toContain(result.readyState);
});

test("teardown suppresses XHR callbacks", async ({ page }) => {
  await installBundle(page);

  for (const teardown of ["disconnect", "supersede"] as const) {
    const frameID = `silent-${teardown}`;
    const frame = await mountFrame(page, frameID, "same-origin");
    await page.evaluate(
      ({ id, teardownKind }) => {
        const element = document.querySelector(`#${id}`) as
          | (HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
          | null;
        const child = element?.contentWindow;
        if (child === null || child === undefined) {
          throw new Error("The XHR teardown frame did not expose its child window");
        }

        child.eval(`(() => {
          const host = window.parent;
          const component = window.frameElement?.getRootNode().host;
          if (!(component instanceof host.HTMLElement)) {
            throw new Error("The XHR execution iframe has no v-frame host");
          }
          host.xhrTeardownEvents = [];
          host.xhrTeardownTriggered = false;
          const xhr = new XMLHttpRequest();
          let responseStarted = false;
          xhr.onreadystatechange = () => {
            if (!responseStarted && xhr.readyState >= xhr.HEADERS_RECEIVED) {
              responseStarted = true;
              host.xhrTeardownEvents = [];
              host.xhrTeardownTriggered = true;
              if (${JSON.stringify(teardownKind)} === "disconnect") {
                component.remove();
              } else {
                component.setAttribute("src", "/documents/xhr.html?superseded");
              }
              return;
            }
            if (responseStarted) host.xhrTeardownEvents.push(\`property:readystatechange:\${xhr.readyState}\`);
          };
          xhr.onabort = () => host.xhrTeardownEvents.push("property:abort");
          xhr.onloadend = () => host.xhrTeardownEvents.push("property:loadend");
          for (const type of ["readystatechange", "abort", "loadend"]) {
            xhr.addEventListener(type, () => {
              if (responseStarted) host.xhrTeardownEvents.push(\`listener:\${type}:\${xhr.readyState}\`);
            });
          }
          xhr.open("GET", "/api/teardown-stream");
          xhr.send();
        })()`);
      },
      { id: frameID, teardownKind: teardown },
    );

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as Window & { xhrTeardownTriggered?: boolean })
              .xhrTeardownTriggered ?? false,
        ),
      )
      .toBe(true);
    if (teardown === "supersede") {
      await expect
        .poll(() =>
          frame.evaluate((element: HTMLElement & { status: string }) => element.status),
        )
        .toBe("ready");
    }

    await page.waitForTimeout(350);
    await expect
      .poll(
        () =>
          page.evaluate(
            () =>
              (window as Window & { xhrTeardownEvents?: string[] }).xhrTeardownEvents ??
              [],
          ),
        {
          message: `XHR emitted callbacks while ${teardown}ing its realm`,
        },
      )
      .toEqual([]);
    await page.evaluate(() => {
      const host = window as Window & {
        xhrTeardownEvents?: string[];
        xhrTeardownTriggered?: boolean;
      };
      delete host.xhrTeardownEvents;
      delete host.xhrTeardownTriggered;
    });
    if (teardown === "supersede") {
      await frame.evaluate((element) => element.remove());
    }
  }
});

test("resolves invalid network URLs to rejections and native SyntaxError throws", async ({
  page,
}) => {
  await installBundle(page);
  const frame = await mountFrame(page, "invalid-urls", "same-origin");
  const result = await childValue(frame, async (window) => {
    let openError = "";
    try {
      new window.XMLHttpRequest().open("GET", "http://[");
    } catch (error) {
      openError = (error as DOMException).name;
    }

    const rejection = window.fetch("http://[").then(
      () => "resolved",
      (error) => (error instanceof window.TypeError ? "TypeError" : String(error)),
    );
    return { openError, fetchRejection: await rejection };
  });

  expect(result).toEqual({ openError: "SyntaxError", fetchRejection: "TypeError" });
});
