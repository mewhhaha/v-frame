import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTCPServer } from "node:net";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

interface XHRFixture {
  origin: string;
  otherOrigin: string;
  methodOrigin: string;
  close(): Promise<void>;
}

function reply(
  response: ServerResponse,
  status: number,
  type: string,
  body: string,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
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
  let origin = "";
  const primary = createServer((request, response) => {
    const path = requestPath(request);
    if (path === "/") return reply(response, 200, "text/html", page('<div id="host"></div>'));
    if (path === "/dist/index.js") {
      if (!existsSync(bundle)) return reply(response, 404, "text/plain", "Build output not found");
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      createReadStream(bundle).pipe(response);
      return;
    }
    if (path === "/documents/xhr.html") return reply(response, 200, "text/html", page('<main>XHR fixture</main>'));
    if (path === "/api/xhr-echo") {
      return reply(response, 200, "application/json", JSON.stringify({
        cookie: request.headers.cookie ?? "",
        method: request.method,
        requestHeader: request.headers["x-fixture-request"] ?? "",
      }), { "x-fixture-response": "visible" });
    }
    if (path === "/api/xhr-body") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => reply(response, 200, "application/json", JSON.stringify({
        body,
        contentType: request.headers["content-type"] ?? "",
      })));
      return;
    }
    if (path === "/api/xhr-bytes") return reply(response, 200, "application/octet-stream", "ABC", { "content-length": "3" });
    if (path === "/api/xhr-document") return reply(response, 200, "application/xml", "<root><copy>document</copy></root>");
    if (path === "/api/xhr-html-document") return reply(response, 200, "text/html", page("<main>HTML document</main>"));
    if (path === "/api/xhr-plain-document") return reply(response, 200, "text/plain", "not a document");
    if (path === "/api/xhr-bad-xml") return reply(response, 200, "application/xml", "<root><unclosed></root>");
    if (path === "/api/slow") {
      setTimeout(() => reply(response, 200, "text/plain", "slow response"), 250);
      return;
    }
    if (path === "/api/slow-stream") {
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.write("first chunk");
      setTimeout(() => response.end("second chunk"), 250);
      return;
    }
    if (path === "/api/teardown-stream") {
      response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      response.write("x".repeat(64 * 1024));
      const timer = setTimeout(() => response.end("second chunk"), 5_000);
      response.once("close", () => clearTimeout(timer));
      return;
    }
    return reply(response, 404, "text/plain", `No primary fixture for ${path}`);
  });
  await new Promise<void>((resolveListening) => primary.listen(0, "127.0.0.1", resolveListening));
  const primaryAddress = primary.address();
  if (primaryAddress === null || typeof primaryAddress === "string") {
    throw new Error("The primary XHR fixture did not expose a TCP address");
  }
  origin = `http://127.0.0.1:${primaryAddress.port}`;

  const secondary = createServer((request, response) => {
    const path = requestPath(request);
    const corsHeaders = { "access-control-allow-origin": origin };
    if (path === "/documents/relative.html") {
      return reply(response, 200, "text/html", page('<main>Relative URL fixture</main>'), corsHeaders);
    }
    if (path === "/api/relative") {
      return reply(response, 200, "application/json", JSON.stringify({ path, origin: `http://${request.headers.host}` }), corsHeaders);
    }
    return reply(response, 404, "text/plain", `No secondary fixture for ${path}`, corsHeaders);
  });
  await new Promise<void>((resolveListening) => secondary.listen(0, "127.0.0.1", resolveListening));
  const secondaryAddress = secondary.address();
  if (secondaryAddress === null || typeof secondaryAddress === "string") {
    throw new Error("The secondary XHR fixture did not expose a TCP address");
  }

  const methodServer = createTCPServer((socket) => {
    socket.once("data", (chunk) => {
      const requestLine = chunk.toString().split("\r\n", 1)[0] ?? "";
      const method = requestLine.split(" ", 1)[0] ?? "";
      const body = method === "OPTIONS" ? "" : JSON.stringify({ method });
      const headers = [
        "HTTP/1.1 200 OK",
        "Connection: close",
        `Access-Control-Allow-Origin: ${origin}`,
        "Access-Control-Allow-Methods: CuStOm",
        "Access-Control-Allow-Headers: content-type",
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Content-Type: application/json",
        "",
        body,
      ];
      socket.end(headers.join("\r\n"));
    });
  });
  await new Promise<void>((resolveListening) => methodServer.listen(0, "127.0.0.1", resolveListening));
  const methodAddress = methodServer.address();
  if (methodAddress === null || typeof methodAddress === "string") {
    throw new Error("The method XHR fixture did not expose a TCP address");
  }

  return {
    origin,
    otherOrigin: `http://127.0.0.1:${secondaryAddress.port}`,
    methodOrigin: `http://127.0.0.1:${methodAddress.port}`,
    async close() {
      await Promise.all([
        new Promise<void>((resolveClosed, reject) => primary.close((error) => error ? reject(error) : resolveClosed())),
        new Promise<void>((resolveClosed, reject) => secondary.close((error) => error ? reject(error) : resolveClosed())),
        new Promise<void>((resolveClosed, reject) => methodServer.close((error) => error ? reject(error) : resolveClosed())),
      ]);
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
  await expect.poll(() => page.evaluate(() => Boolean(customElements.get("v-frame")))).toBe(true);
}

async function mountFrame(
  page: import("@playwright/test").Page,
  id: string,
  source: string,
  credentials: "omit" | "same-origin" | "include",
) {
  await page.evaluate(({ frameID, frameSource, frameCredentials }) => {
    const frame = document.createElement("v-frame");
    frame.id = frameID;
    frame.setAttribute("credentials", frameCredentials);
    frame.setAttribute("src", frameSource);
    document.querySelector("#host")?.append(frame);
  }, { frameID: id, frameSource: source, frameCredentials: credentials });
  const frame = page.locator(`v-frame#${id}`);
  await expect.poll(() => frame.evaluate((element) => (element as { status: string }).status)).toBe("ready");
  return frame;
}

async function childValue<T, Argument = undefined>(
  frame: import("@playwright/test").Locator,
  expression: (window: Window & typeof globalThis, argument: Argument) => T,
  argument?: Argument,
): Promise<T> {
  return frame.evaluate((element, values) => {
    const evaluate = new Function("window", "argument", `return (${values.source})(window, argument)`);
    return evaluate((element as HTMLElement & { contentWindow: Window | null }).contentWindow, values.argument);
  }, { source: expression.toString(), argument }) as Promise<T>;
}

test("omits same-origin cookies while preserving XHR headers, JSON, and events", async ({ page }) => {
  await page.context().addCookies([{
    name: "xhr_host_cookie",
    value: "present",
    url: fixture.origin,
    sameSite: "Lax",
  }]);
  await installBundle(page);

  const omitted = await mountFrame(page, "omitted", `${fixture.origin}/documents/xhr.html`, "omit");
  const omittedResult = await childValue(omitted, async (window) => {
    const xhr = new window.XMLHttpRequest();
    const events: string[] = [];
    xhr.addEventListener("readystatechange", () => events.push(`state:${xhr.readyState}`));
    xhr.addEventListener("loadstart", () => events.push("loadstart"));
    xhr.addEventListener("load", () => events.push("load"));
    xhr.open("GET", "/api/xhr-echo");
    xhr.setRequestHeader("x-fixture-request", "set");
    xhr.responseType = "json";
    xhr.withCredentials = true;
    return await new Promise((resolve) => {
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
          constants: [window.XMLHttpRequest.UNSENT, window.XMLHttpRequest.DONE, xhr.UNSENT, xhr.DONE],
          withCredentials: xhr.withCredentials,
          status: xhr.status,
          statusText: xhr.statusText,
          responseURL: xhr.responseURL,
          response: xhr.response,
          responseHeader: xhr.getResponseHeader("x-fixture-response"),
          allHeaders: xhr.getAllResponseHeaders(),
          responseTextError,
        });
      };
      xhr.send("GET bodies must be ignored");
    });
  });

  expect(omittedResult).toMatchObject({
    events: ["state:1", "loadstart", "state:2", "state:3", "state:4", "load"],
    instanceOfExposedConstructor: true,
    constants: [0, 4, 0, 4],
    withCredentials: true,
    status: 200,
    responseURL: `${fixture.origin}/api/xhr-echo`,
    response: { cookie: "", method: "GET", requestHeader: "set" },
    responseHeader: "visible",
    responseTextError: "InvalidStateError",
  });
  expect(omittedResult.allHeaders).toContain("x-fixture-response: visible");

  const included = await mountFrame(page, "included", `${fixture.origin}/documents/xhr.html`, "include");
  const includedResult = await childValue(included, async (window) => {
    const xhr = new window.XMLHttpRequest();
    xhr.open("GET", "/api/xhr-echo");
    xhr.responseType = "json";
    return await new Promise((resolve) => {
      xhr.onloadend = () => resolve({ withCredentials: xhr.withCredentials, response: xhr.response });
      xhr.send();
    });
  });
  expect(includedResult).toEqual({
    withCredentials: true,
    response: { cookie: "xhr_host_cookie=present", method: "GET", requestHeader: "" },
  });
});

test("resolves relative XHR URLs from the virtual current URL", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "relative", `${fixture.otherOrigin}/documents/relative.html`, "omit");
  const result = await childValue(frame, async (window) => {
    const xhr = new window.XMLHttpRequest();
    xhr.open("GET", "/api/relative");
    xhr.responseType = "json";
    return await new Promise((resolve) => {
      xhr.onloadend = () => resolve({ status: xhr.status, responseURL: xhr.responseURL, response: xhr.response });
      xhr.send();
    });
  });

  expect(result).toEqual({
    status: 200,
    responseURL: `${fixture.otherOrigin}/api/relative`,
    response: { path: "/api/relative", origin: fixture.otherOrigin },
  });
});

test("sends POST bodies and returns blob, arraybuffer, and document responses", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "response-types", `${fixture.origin}/documents/xhr.html`, "omit");
  const result = await childValue(frame, async (window) => {
    const request = (url: string, responseType: XMLHttpRequestResponseType) => new Promise<XMLHttpRequest>((resolve) => {
      const xhr = new window.XMLHttpRequest();
      xhr.open("GET", url);
      xhr.responseType = responseType;
      xhr.onloadend = () => resolve(xhr);
      xhr.send();
    });

    const uploadEvents: Array<{ type: string; loaded: number; total: number; lengthComputable: boolean }> = [];
    const post = await new Promise<XMLHttpRequest>((resolve) => {
      const xhr = new window.XMLHttpRequest();
      xhr.upload.onloadstart = (event) => uploadEvents.push({
        type: event.type,
        loaded: event.loaded,
        total: event.total,
        lengthComputable: event.lengthComputable,
      });
      xhr.upload.onprogress = (event) => uploadEvents.push({
        type: event.type,
        loaded: event.loaded,
        total: event.total,
        lengthComputable: event.lengthComputable,
      });
      xhr.upload.onload = (event) => uploadEvents.push({
        type: event.type,
        loaded: event.loaded,
        total: event.total,
        lengthComputable: event.lengthComputable,
      });
      xhr.upload.onloadend = (event) => uploadEvents.push({
        type: event.type,
        loaded: event.loaded,
        total: event.total,
        lengthComputable: event.lengthComputable,
      });
      xhr.open("POST", "/api/xhr-body");
      xhr.responseType = "json";
      xhr.onloadend = () => resolve(xhr);
      xhr.send("request payload");
    });
    const documentPost = await new Promise<XMLHttpRequest>((resolve) => {
      const xhr = new window.XMLHttpRequest();
      const document = new window.DOMParser().parseFromString("<message>document payload</message>", "application/xml");
      xhr.open("POST", "/api/xhr-body");
      xhr.responseType = "json";
      xhr.onloadend = () => resolve(xhr);
      xhr.send(document);
    });
    const htmlDocumentPost = await new Promise<XMLHttpRequest>((resolve) => {
      const xhr = new window.XMLHttpRequest();
      const document = new window.DOMParser().parseFromString("<main>HTML payload</main>", "text/html");
      xhr.open("POST", "/api/xhr-body");
      xhr.responseType = "json";
      xhr.onloadend = () => resolve(xhr);
      xhr.send(document);
    });
    const arrayBuffer = await request("/api/xhr-bytes", "arraybuffer");
    const blob = await request("/api/xhr-bytes", "blob");
    const document = await request("/api/xhr-document", "document");

    return {
      postBody: (post.response as { body: string }).body,
      documentPost: documentPost.response,
      htmlDocumentContentType: (htmlDocumentPost.response as { contentType: string }).contentType,
      uploadIsEventTarget: post.upload instanceof window.EventTarget,
      uploadEvents,
      arrayBuffer: Array.from(new window.Uint8Array(arrayBuffer.response as ArrayBuffer)),
      blobIsRealmBlob: blob.response instanceof window.Blob,
      blobText: await (blob.response as Blob).text(),
      documentIsRealmDocument: document.response instanceof window.Document,
      documentRoot: (document.response as Document).documentElement.tagName,
      responseXMLRoot: document.responseXML?.documentElement.tagName,
    };
  });

  expect(result).toEqual({
    postBody: "request payload",
    documentPost: {
      body: "<message>document payload</message>",
      contentType: "application/xml;charset=UTF-8",
    },
    htmlDocumentContentType: "text/html;charset=UTF-8",
    uploadIsEventTarget: true,
    uploadEvents: [
      { type: "loadstart", loaded: 0, total: 15, lengthComputable: true },
      { type: "progress", loaded: 15, total: 15, lengthComputable: true },
      { type: "load", loaded: 15, total: 15, lengthComputable: true },
      { type: "loadend", loaded: 15, total: 15, lengthComputable: true },
    ],
    arrayBuffer: [65, 66, 67],
    blobIsRealmBlob: true,
    blobText: "ABC",
    documentIsRealmDocument: true,
    documentRoot: "root",
    responseXMLRoot: "root",
  });
});

test("parses document responses only for XML and HTML MIME types", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "document-mime", `${fixture.origin}/documents/xhr.html`, "omit");
  const result = await childValue(frame, async (window) => {
    const request = (url: string) => new Promise<XMLHttpRequest>((resolve) => {
      const xhr = new window.XMLHttpRequest();
      xhr.open("GET", url);
      xhr.responseType = "document";
      xhr.onloadend = () => resolve(xhr);
      xhr.send();
    });

    const xml = await request("/api/xhr-document");
    const html = await request("/api/xhr-html-document");
    const plain = await request("/api/xhr-plain-document");
    const json = new window.XMLHttpRequest();
    json.open("GET", "/api/xhr-echo");
    json.responseType = "json";
    await new Promise<void>((resolve) => {
      json.onloadend = () => resolve();
      json.send();
    });

    let responseXMLError = "";
    try {
      void json.responseXML;
    } catch (error) {
      responseXMLError = (error as DOMException).name;
    }

    return {
      xmlRoot: (xml.response as Document).documentElement.tagName,
      htmlIsShared: html.response === html.responseXML,
      htmlRoot: (html.response as Document).documentElement.tagName,
      plainResponse: plain.response,
      plainResponseXML: plain.responseXML,
      responseXMLError,
    };
  });

  expect(result).toEqual({
    xmlRoot: "root",
    htmlIsShared: true,
    htmlRoot: "HTML",
    plainResponse: null,
    plainResponseXML: null,
    responseXMLError: "InvalidStateError",
  });
});

test("exposes completed response data and progress event totals while loading", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "progress", `${fixture.origin}/documents/xhr.html`, "omit");
  const result = await childValue(frame, async (window) => {
    const xhr = new window.XMLHttpRequest();
    const events: Array<{ type: string; loaded: number; total: number; lengthComputable: boolean }> = [];
    const loadingResponses: string[] = [];
    xhr.onreadystatechange = () => {
      if (xhr.readyState === xhr.LOADING) {
        loadingResponses.push(xhr.responseText);
      }
    };
    for (const type of ["loadstart", "progress", "load", "loadend"] as const) {
      xhr.addEventListener(type, (event) => {
        const progress = event as ProgressEvent;
        events.push({
          type,
          loaded: progress.loaded,
          total: progress.total,
          lengthComputable: progress.lengthComputable,
        });
      });
    }
    xhr.open("GET", "/api/xhr-bytes");
    await new Promise<void>((resolve) => {
      xhr.onloadend = () => resolve();
      xhr.send();
    });
    return { loadingResponses, events };
  });

  expect(result).toEqual({
    loadingResponses: ["ABC"],
    events: [
      { type: "loadstart", loaded: 0, total: 0, lengthComputable: false },
      { type: "progress", loaded: 3, total: 3, lengthComputable: true },
      { type: "load", loaded: 3, total: 3, lengthComputable: true },
      { type: "loadend", loaded: 3, total: 3, lengthComputable: true },
    ],
  });
});

test("validates XHR open arguments in the child realm and retains extension method casing", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "open-validation", `${fixture.origin}/documents/xhr.html`, "omit");
  const result = await childValue(frame, async (window, methodURL) => {
    const exception = (operation: () => void) => {
      try {
        operation();
        return null;
      } catch (error) {
        return {
          name: (error as Error).name,
          isRealmDOMException: error instanceof window.DOMException,
          isRealmTypeError: error instanceof window.TypeError,
        };
      }
    };
    const invalidResponseType = exception(() => {
      const xhr = new window.XMLHttpRequest();
      xhr.responseType = "invalid" as XMLHttpRequestResponseType;
    });
    const malformedMethod = exception(() => new window.XMLHttpRequest().open("GET space", "/api/xhr-echo"));
    const malformedURL = exception(() => new window.XMLHttpRequest().open("GET", "http://[invalid"));
    const extension = new window.XMLHttpRequest();
    extension.open("CuStOm", methodURL);
    extension.responseType = "json";
    await new Promise<void>((resolve) => {
      extension.onloadend = () => resolve();
      extension.send();
    });

    return {
      invalidResponseType: {
        name: invalidResponseType?.name,
        isRealmTypeError: invalidResponseType?.isRealmTypeError,
      },
      malformedMethod,
      malformedURL,
      extensionMethod: (extension.response as { method: string }).method,
      responseIsRealmJSON: Object.getPrototypeOf(extension.response) === window.Object.prototype,
    };
  }, fixture.methodOrigin);

  expect(result).toEqual({
    invalidResponseType: { name: "TypeError", isRealmTypeError: true },
    malformedMethod: { name: "SyntaxError", isRealmDOMException: true, isRealmTypeError: false },
    malformedURL: { name: "SyntaxError", isRealmDOMException: true, isRealmTypeError: false },
    extensionMethod: "CuStOm",
    responseIsRealmJSON: true,
  });
});

test("times out requests and follows native abort and reopen state transitions", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "lifecycle", `${fixture.origin}/documents/xhr.html`, "omit");
  const timedOut = await childValue(frame, async (window) => {
    const xhr = new window.XMLHttpRequest();
    const events: string[] = [];
    xhr.timeout = 20;
    xhr.addEventListener("timeout", () => events.push("timeout"));
    xhr.addEventListener("loadend", () => events.push("loadend"));
    xhr.open("GET", "/api/slow");
    return await new Promise((resolve) => {
      xhr.onloadend = () => resolve({ events, readyState: xhr.readyState, status: xhr.status });
      xhr.send();
    });
  });
  expect(timedOut).toEqual({ events: ["timeout", "loadend"], readyState: 4, status: 0 });

  const aborted = await childValue(frame, async (window) => {
    const xhr = new window.XMLHttpRequest();
    const events: string[] = [];
    const abortEventStates: number[] = [];
    xhr.onabort = () => {
      events.push("abort");
      abortEventStates.push(xhr.readyState);
    };
    xhr.onloadend = () => {
      events.push("loadend");
      abortEventStates.push(xhr.readyState);
    };
    xhr.open("POST", "/api/slow");
    xhr.send("abort this request");
    xhr.abort();
    xhr.abort();
    const readyStateAfterAbort = xhr.readyState;
    xhr.open("GET", "/api/slow");
    const readyStateAfterOpen = xhr.readyState;
    xhr.abort();
    const completed = new window.XMLHttpRequest();
    completed.open("GET", "/api/xhr-echo");
    await new Promise<void>((resolve) => {
      completed.onloadend = () => resolve();
      completed.send();
    });
    completed.abort();

    const reopened = new window.XMLHttpRequest();
    const reopenEvents: string[] = [];
    reopened.onabort = () => reopenEvents.push("abort");
    reopened.onloadend = () => reopenEvents.push("loadend");
    reopened.open("GET", "/api/slow");
    reopened.send();
    reopened.open("GET", "/api/xhr-echo");

    return {
      events,
      abortEventStates,
      readyStateAfterAbort,
      readyStateAfterOpen,
      readyStateAfterIdleAbort: xhr.readyState,
      readyStateAfterCompletedAbort: completed.readyState,
      reopenEvents,
      readyStateAfterReopen: reopened.readyState,
      status: xhr.status,
    };
  });
  expect(aborted).toEqual({
    events: ["abort", "loadend"],
    abortEventStates: [4, 4],
    readyStateAfterAbort: 0,
    readyStateAfterOpen: 1,
    readyStateAfterIdleAbort: 1,
    readyStateAfterCompletedAbort: 0,
    reopenEvents: [],
    readyStateAfterReopen: 1,
    status: 0,
  });

  const disposed = await page.evaluate(async () => {
    const frame = document.querySelector("#lifecycle") as HTMLElement & { contentWindow: Window | null };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("The lifecycle frame did not expose its child window");
    }
    const xhr = new child.XMLHttpRequest();
    xhr.open("GET", "/api/slow");
    xhr.send();
    frame.remove();
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { readyState: xhr.readyState, status: xhr.status };
  });
  expect(disposed).toEqual({ readyState: 0, status: 0 });
});

test("reschedules an active timeout from the original send time and can disable it", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "timeout-reschedule", `${fixture.origin}/documents/xhr.html`, "omit");
  const result = await childValue(frame, async (window) => {
    const shortened = new window.XMLHttpRequest();
    shortened.open("GET", "/api/slow");
    shortened.timeout = 500;
    const shortenedResult = await new Promise<{ event: string; elapsed: number }>((resolve) => {
      const startedAt = window.performance.now();
      shortened.onloadend = () => resolve({
        event: shortened.status === 0 ? "timeout" : "load",
        elapsed: window.performance.now() - startedAt,
      });
      shortened.send();
      window.setTimeout(() => {
        shortened.timeout = 20;
      }, 40);
    });

    const disabled = new window.XMLHttpRequest();
    disabled.open("GET", "/api/slow");
    disabled.timeout = 20;
    const disabledResult = await new Promise<string>((resolve) => {
      disabled.onloadend = () => resolve(disabled.status === 200 ? "load" : "timeout");
      disabled.send();
      window.setTimeout(() => {
        disabled.timeout = 0;
      }, 5);
    });

    return { shortenedResult, disabledResult };
  });

  expect(result.shortenedResult.event).toBe("timeout");
  expect(result.shortenedResult.elapsed).toBeLessThan(150);
  expect(result.disabledResult).toBe("load");
});

test("disposal aborts reentrant XHR sends for credentialless and native transports", async ({ page }) => {
  await installBundle(page);

  for (const credentials of ["omit", "same-origin"] as const) {
    const frameID = `reentrant-${credentials}`;
    await mountFrame(page, frameID, `${fixture.origin}/documents/xhr.html`, credentials);
    await page.evaluate(async ({ id, waitForLoading }) => {
      const frame = document.querySelector(`#${id}`) as HTMLElement & { contentWindow: Window | null };
      const child = frame.contentWindow;
      if (child === null) {
        throw new Error("The reentrant XHR frame did not expose its child window");
      }

      return new Promise<void>((resolve) => {
        const xhr = new child.XMLHttpRequest();
        (window as Window & { reentrantXHR?: XMLHttpRequest }).reentrantXHR = xhr;
        let sentReentrantRequest = false;
        xhr.onreadystatechange = () => {
          if (sentReentrantRequest && waitForLoading && xhr.readyState === xhr.LOADING) {
            resolve();
          }
        };
        xhr.onloadend = () => {
          if (!sentReentrantRequest) {
            sentReentrantRequest = true;
            xhr.open("GET", waitForLoading ? "/api/slow-stream" : "/api/slow");
            xhr.send();
            if (!waitForLoading) {
              window.setTimeout(resolve, 0);
            }
            return;
          }
        };
        xhr.open("GET", "/api/xhr-echo");
        xhr.send();
      });
    }, { id: frameID, waitForLoading: credentials === "same-origin" });
    await page.evaluate((id) => document.querySelector(`#${id}`)?.remove(), frameID);
    await page.waitForTimeout(50);
    const result = await page.evaluate(() => {
      const host = window as Window & { reentrantXHR?: XMLHttpRequest };
      const xhr = host.reentrantXHR;
      delete host.reentrantXHR;
      return { readyState: xhr?.readyState, status: xhr?.status };
    });

    expect(result.status).toBe(0);
    if (credentials === "omit") {
      expect(result.readyState).toBe(0);
    } else {
      expect([0, 4]).toContain(result.readyState);
    }
  }
});

test("teardown suppresses XHR callbacks for credentialless and native transports", async ({ page }) => {
  await installBundle(page);

  for (const credentials of ["omit", "same-origin"] as const) {
    for (const teardown of ["disconnect", "supersede"] as const) {
      const frameID = `silent-${credentials}-${teardown}`;
      const frame = await mountFrame(page, frameID, `${fixture.origin}/documents/xhr.html`, credentials);
      await page.evaluate(({ id, teardownKind }) => {
        const element = document.querySelector(`#${id}`) as HTMLElement & { contentWindow: Window | null } | null;
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
      }, { id: frameID, teardownKind: teardown });

      await expect.poll(() => page.evaluate(() => (
        (window as Window & { xhrTeardownTriggered?: boolean }).xhrTeardownTriggered ?? false
      ))).toBe(true);
      if (teardown === "supersede") {
        await expect.poll(() => frame.evaluate((element) => (element as { status: string }).status)).toBe("ready");
      }

      await page.waitForTimeout(350);
      await expect
        .poll(
          () => page.evaluate(() => (window as Window & { xhrTeardownEvents?: string[] }).xhrTeardownEvents ?? []),
          { message: `${credentials} XHR emitted callbacks while ${teardown}ing its realm` },
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
  }
});

test("restricts document parsing to responseType document and fires one readystatechange per open", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "document-modes", `${fixture.origin}/documents/xhr.html`, "omit");
  const result = await childValue(frame, async (window) => {
    const request = (url: string, type?: XMLHttpRequestResponseType) => new Promise<XMLHttpRequest>((resolve) => {
      const xhr = new window.XMLHttpRequest();
      xhr.open("GET", url);
      if (type !== undefined) {
        xhr.responseType = type;
      }
      xhr.onloadend = () => resolve(xhr);
      xhr.send();
    });

    const html = await request("/api/xhr-html-document");
    const xml = await request("/api/xhr-document");
    const badXML = await request("/api/xhr-bad-xml", "document");

    const openStates: number[] = [];
    const reopened = new window.XMLHttpRequest();
    reopened.addEventListener("readystatechange", () => openStates.push(reopened.readyState));
    reopened.open("GET", "/api/xhr-echo");
    reopened.open("GET", "/api/xhr-echo");

    return {
      htmlResponseXMLIsNull: html.responseXML === null,
      htmlTextPreserved: html.responseText.includes("HTML document"),
      xmlRoot: (xml.responseXML as Document).documentElement.tagName,
      badXMLResponse: badXML.response,
      badXMLResponseXML: badXML.responseXML,
      openStates,
    };
  });

  expect(result).toEqual({
    htmlResponseXMLIsNull: true,
    htmlTextPreserved: true,
    xmlRoot: "root",
    badXMLResponse: null,
    badXMLResponseXML: null,
    openStates: [1],
  });
});

test("resolves invalid network URLs to rejections and native SyntaxError throws", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "invalid-urls", `${fixture.origin}/documents/xhr.html`, "same-origin");
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
