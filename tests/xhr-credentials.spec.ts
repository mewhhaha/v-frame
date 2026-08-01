import type { IncomingMessage } from "node:http";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  bundleRoute,
  type HTTPFixture,
  requestPathname,
  startHTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

interface ObservedRequest {
  path: string;
  cookie: string;
}

let fixture: HTTPFixture<ObservedRequest>;

function page(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

function observeRequest(request: IncomingMessage): ObservedRequest {
  return { path: requestPathname(request), cookie: request.headers.cookie ?? "" };
}

function startXHRFixture(): Promise<HTTPFixture<ObservedRequest>> {
  return startHTTPFixture({
    record: observeRequest,
    routes: {
      "/": page('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/documents/xhr.html": page(
        '<link rel="stylesheet" href="/styles/guest.css"><main>XHR fixture</main>',
      ),
      "/styles/guest.css": { type: "text/css", body: "main { color: rgb(1, 2, 3); }" },
      "/api/xhr-echo": (request) => ({
        type: "application/json",
        headers: { "x-fixture-response": "visible" },
        body: JSON.stringify({
          cookie: request.headers.cookie ?? "",
          method: request.method,
          requestHeader: request.headers["x-fixture-request"] ?? "",
        }),
      }),
      "/api/slow": { type: "text/plain", body: "slow response", delay: 250 },
      "/api/slow-stream": (_request, response) => {
        response.writeHead(200, {
          "content-type": "text/plain",
          "cache-control": "no-store",
        });
        response.write("first chunk");
        setTimeout(() => response.end("second chunk"), 250);
        return undefined;
      },
      // Held open long enough that a frame teardown always beats the final chunk.
      "/api/teardown-stream": (_request, response) => {
        response.writeHead(200, {
          "content-type": "text/plain",
          "cache-control": "no-store",
        });
        response.write("x".repeat(64 * 1024));
        const timer = setTimeout(() => response.end("second chunk"), 5_000);
        response.once("close", () => clearTimeout(timer));
        return undefined;
      },
    },
  });
}

test.beforeAll(async () => {
  fixture = await startXHRFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

async function addHostCookie(page: Page) {
  await page.context().addCookies([
    {
      name: "xhr_host_cookie",
      value: "present",
      url: fixture.origin,
      sameSite: "Lax",
    },
  ]);
}

function mountXHRFrame(
  page: Page,
  id: string,
  credentials: "omit" | "same-origin" | "include",
): Promise<Locator> {
  return mountFrame(page, {
    src: `${fixture.origin}/documents/xhr.html`,
    id,
    credentials,
  });
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
  await installBundle(page, fixture.origin);

  const observed = new Map<string, ObservedRequest[]>();
  for (const credentials of ["omit", "same-origin", "include"] as const) {
    const before = fixture.requests.length;
    await mountXHRFrame(page, `entry-${credentials}`, credentials);
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
  await installBundle(page, fixture.origin);

  const frame = await mountXHRFrame(page, "same-origin-xhr", "same-origin");
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

  const included = await mountXHRFrame(page, "include-xhr", "include");
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
  await installBundle(page, fixture.origin);

  await mountXHRFrame(page, "reentrant", "same-origin");
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
  await installBundle(page, fixture.origin);

  for (const teardown of ["disconnect", "supersede"] as const) {
    const frameID = `silent-${teardown}`;
    const frame = await mountXHRFrame(page, frameID, "same-origin");
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
  await installBundle(page, fixture.origin);
  const frame = await mountXHRFrame(page, "invalid-urls", "same-origin");
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
