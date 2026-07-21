import { expect, test, type Page } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { serveRealmMarker } from "./support/gateway-fixture.js";

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

interface RecordedFailure {
  phase: string;
  url: string;
  message: string;
  fatal: boolean;
}

const nonce = "script-concurrency-nonce";
let fixture: FixtureServer;

function html(body: string): string {
  return `<!doctype html><html><head></head><body>${body}</body></html>`;
}

function reply(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": `script-src 'self' 'nonce-${nonce}'; object-src 'none'`,
    "content-type": contentType,
  });
  response.end(body);
}

function documentSource(pathname: string): string | undefined {
  switch (pathname) {
    case "/documents/inline-failure-external-success.html":
      return html(`
        <script type="module" async src="../modules/external-tla-success.js"></script>
        <script type="module">import "../modules/inline-dependency-failure.js";</script>
      `);
    case "/documents/external-failure-inline-success.html":
      return html(`
        <script type="module" async src="../modules/external-dependency-entry.js"></script>
        <script type="module">
          window.__inlineTlaStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 100));
          window.__inlineTlaFulfilled = true;
        </script>
      `);
    case "/documents/concurrent-external-failures.html":
      return html(`
        <script type="module" async src="../modules/shared-failure-a.js"></script>
        <script type="module" async src="../modules/shared-failure-b.js"></script>
        <script type="module">
          setTimeout(() => { throw new Error("unrelated runtime failure"); }, 10);
        </script>
      `);
    case "/documents/async-inline-order.html":
      return html(`
        <script>window.__asyncInlineEvents = [];</script>
        <script type="module" async>
          window.__asyncInlineEvents.push("A-start");
          await new Promise((resolve) => setTimeout(resolve, 100));
          window.__asyncInlineEvents.push("A-end");
        </script>
        <script type="module" async>
          window.__asyncInlineEvents.push("B");
        </script>
      `);
    case "/documents/concurrent-inline-failures.html":
      return html(`
        <script>window.__concurrentInlineEvents = [];</script>
        <script type="module" async>
          window.__concurrentInlineEvents.push("failure-a-start");
          await new Promise((resolve) => setTimeout(resolve, 75));
          throw new Error("async inline failure A");
        </script>
        <script type="module" async>
          window.__concurrentInlineEvents.push("failure-b-start");
          await new Promise((resolve) => setTimeout(resolve, 25));
          throw new Error("async inline failure B");
        </script>
        <script type="module" async>
          window.__concurrentInlineEvents.push("success-start");
          await new Promise((resolve) => setTimeout(resolve, 100));
          window.__concurrentInlineEvents.push("success-end");
        </script>
      `);
    case "/documents/external-and-concurrent-inline-failures.html":
      return html(`
        <script type="module" async src="../modules/external-dependency-entry.js"></script>
        <script type="module" async>
          window.__inlineTlaStarted = true;
          await new Promise((resolve) => setTimeout(resolve, 100));
          window.__inlineTlaFulfilled = true;
        </script>
        <script type="module" async>
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error("concurrent inline failure");
        </script>
      `);
    case "/documents/blank.html":
      return html("<main>blank</main>");
    default:
      return undefined;
  }
}

function moduleSource(pathname: string): string | undefined {
  switch (pathname) {
    case "/modules/external-tla-success.js":
      return `
        window.__externalTlaStarted = true;
        await new Promise((resolve) => setTimeout(resolve, 100));
        window.__externalTlaFulfilled = true;
      `;
    case "/modules/inline-dependency-failure.js":
      return 'throw new Error("inline dependency failure");';
    case "/modules/external-dependency-entry.js":
      return 'import "./external-dependency-failure.js";';
    case "/modules/external-dependency-failure.js":
      return `
        while (!window.__inlineTlaStarted) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        throw new Error("external dependency failure");
      `;
    case "/modules/shared-failure-a.js":
      return `
        await new Promise((resolve) => setTimeout(resolve, 50));
        window.__sharedExternalFailure ??= new Error("shared external failure");
        throw window.__sharedExternalFailure;
      `;
    case "/modules/shared-failure-b.js":
      return `
        await new Promise((resolve) => setTimeout(resolve, 75));
        window.__sharedExternalFailure ??= new Error("shared external failure");
        throw window.__sharedExternalFailure;
      `;
    default:
      return undefined;
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
}

async function startFixtureServer(): Promise<FixtureServer> {
  const bundle = resolve(process.cwd(), "dist/index.js");
  const server = createServer((request, response) => {
    if (serveRealmMarker(request, response)) return;
    const pathname = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    if (pathname === "/") {
      reply(response, 200, "text/html", html('<div id="host"></div>'));
      return;
    }
    if (pathname === "/dist/index.js") {
      if (!existsSync(bundle)) {
        reply(response, 404, "text/plain", "Build output not found");
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/javascript",
      });
      createReadStream(bundle).pipe(response);
      return;
    }

    const document = documentSource(pathname);
    if (document !== undefined) {
      reply(response, 200, "text/html", document);
      return;
    }
    const module = moduleSource(pathname);
    if (module !== undefined) {
      reply(response, 200, "text/javascript", module);
      return;
    }
    reply(response, 404, "text/plain", `No fixture for ${pathname}`);
  });

  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Script concurrency fixture did not expose a TCP address");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture.close();
});

async function installBundle(page: Page): Promise<void> {
  await page.goto(fixture.origin);
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
}

async function loadFrame(
  page: Page,
  pathname: string,
): Promise<{ failures: RecordedFailure[]; status: string; childState: Record<string, boolean> }> {
  return page.evaluate(async ({ frameNonce, source }) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: (Window & Record<string, unknown>) | null;
      status: string;
    };
    const failures: RecordedFailure[] = [];
    frame.setAttribute("nonce", frameNonce);
    frame.addEventListener("v-frame-error", (event) => {
      const detail = (event as CustomEvent<{
        phase: string;
        url: string;
        error: unknown;
        fatal: boolean;
      }>).detail;
      const error = detail.error as { message?: unknown } | null;
      failures.push({
        phase: detail.phase,
        url: detail.url,
        message: typeof error?.message === "string" ? error.message : String(detail.error),
        fatal: detail.fatal,
      });
    });
    const loaded = new Promise<void>((resolveLoaded) => {
      frame.addEventListener("v-frame-load", () => resolveLoaded(), { once: true });
    });
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
    await loaded;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    const childWindow = frame.contentWindow;
    return {
      failures,
      status: frame.status,
      childState: {
        externalTlaFulfilled: childWindow?.__externalTlaFulfilled === true,
        inlineTlaFulfilled: childWindow?.__inlineTlaFulfilled === true,
      },
    };
  }, { frameNonce: nonce, source: `${fixture.origin}${pathname}` });
}

test("attributes an inline dependency failure while an async external module is pending", async ({ page }) => {
  await installBundle(page);
  const pathname = "/documents/inline-failure-external-success.html";
  const result = await loadFrame(page, pathname);

  expect(result).toEqual({
    failures: [{
      phase: "script",
      url: `${fixture.origin}${pathname}`,
      message: "inline dependency failure",
      fatal: false,
    }],
    status: "ready",
    childState: {
      externalTlaFulfilled: true,
      inlineTlaFulfilled: false,
    },
  });
});

test("attributes an external dependency failure while an inline module has pending top-level await", async ({ page }) => {
  await installBundle(page);
  const pathname = "/documents/external-failure-inline-success.html";
  const result = await loadFrame(page, pathname);

  expect(result).toEqual({
    failures: [{
      phase: "script",
      url: `${fixture.origin}/modules/external-dependency-entry.js`,
      message: "external dependency failure",
      fatal: false,
    }],
    status: "ready",
    childState: {
      externalTlaFulfilled: false,
      inlineTlaFulfilled: true,
    },
  });
});

test("reports two concurrent external failures and an unrelated runtime failure once each", async ({ page }) => {
  await installBundle(page);
  const result = await loadFrame(page, "/documents/concurrent-external-failures.html");

  expect(result.status).toBe("ready");
  expect(result.failures).toHaveLength(3);
  expect(result.failures.filter((failure) => failure.phase === "script")).toEqual([
    {
      phase: "script",
      url: `${fixture.origin}/modules/shared-failure-a.js`,
      message: "shared external failure",
      fatal: false,
    },
    {
      phase: "script",
      url: `${fixture.origin}/modules/shared-failure-b.js`,
      message: "shared external failure",
      fatal: false,
    },
  ]);
  expect(result.failures.filter((failure) => failure.phase === "runtime")).toEqual([
    expect.objectContaining({
      phase: "runtime",
      message: "unrelated runtime failure",
      fatal: false,
    }),
  ]);
});

test("runs async inline modules concurrently while preserving their native start order", async ({ page }) => {
  await installBundle(page);
  const result = await page.evaluate(async ({ frameNonce, source }) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: (Window & { __asyncInlineEvents?: string[] }) | null;
      status: string;
    };
    frame.setAttribute("nonce", frameNonce);
    const loaded = new Promise<void>((resolveLoaded, rejectLoaded) => {
      const timeout = setTimeout(() => rejectLoaded(new Error("v-frame-load timed out")), 3_000);
      frame.addEventListener("v-frame-load", () => {
        clearTimeout(timeout);
        resolveLoaded();
      }, { once: true });
    });
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
    await loaded;
    return {
      events: frame.contentWindow?.__asyncInlineEvents,
      status: frame.status,
    };
  }, {
    frameNonce: nonce,
    source: `${fixture.origin}/documents/async-inline-order.html`,
  });

  expect(result).toEqual({
    events: ["A-start", "B", "A-end"],
    status: "ready",
  });
});

test("settles concurrent failing and successful inline modules without duplicate reports", async ({ page }) => {
  await installBundle(page);
  const pathname = "/documents/concurrent-inline-failures.html";
  const result = await page.evaluate(async ({ frameNonce, source }) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: (Window & { __concurrentInlineEvents?: string[] }) | null;
      status: string;
    };
    const failures: RecordedFailure[] = [];
    frame.setAttribute("nonce", frameNonce);
    frame.addEventListener("v-frame-error", (event) => {
      const detail = (event as CustomEvent<{
        phase: string;
        url: string;
        error: unknown;
        fatal: boolean;
      }>).detail;
      const error = detail.error as { message?: unknown } | null;
      failures.push({
        phase: detail.phase,
        url: detail.url,
        message: typeof error?.message === "string" ? error.message : String(detail.error),
        fatal: detail.fatal,
      });
    });
    const loaded = new Promise<void>((resolveLoaded, rejectLoaded) => {
      const timeout = setTimeout(() => rejectLoaded(new Error("v-frame-load timed out")), 3_000);
      frame.addEventListener("v-frame-load", () => {
        clearTimeout(timeout);
        resolveLoaded();
      }, { once: true });
    });
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
    await loaded;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    return {
      events: frame.contentWindow?.__concurrentInlineEvents,
      failures,
      status: frame.status,
    };
  }, { frameNonce: nonce, source: `${fixture.origin}${pathname}` });

  expect(result.events).toEqual([
    "failure-a-start",
    "failure-b-start",
    "success-start",
    "success-end",
  ]);
  expect(result.status).toBe("ready");
  expect(result.failures).toHaveLength(2);
  expect(result.failures.map((failure) => failure.message).sort()).toEqual([
    "async inline failure A",
    "async inline failure B",
  ]);
  expect(result.failures).toEqual(expect.arrayContaining([
    expect.objectContaining({
      phase: "script",
      url: `${fixture.origin}${pathname}`,
      fatal: false,
    }),
    expect.objectContaining({
      phase: "script",
      url: `${fixture.origin}${pathname}`,
      fatal: false,
    }),
  ]));
});

test("separates an external failure from overlapping concurrent inline modules", async ({ page }) => {
  await installBundle(page);
  const pathname = "/documents/external-and-concurrent-inline-failures.html";
  const result = await loadFrame(page, pathname);

  expect(result.status).toBe("ready");
  expect(result.childState.inlineTlaFulfilled).toBe(true);
  expect(result.failures).toHaveLength(2);
  expect(result.failures).toEqual(expect.arrayContaining([
    {
      phase: "script",
      url: `${fixture.origin}/modules/external-dependency-entry.js`,
      message: "external dependency failure",
      fatal: false,
    },
    {
      phase: "script",
      url: `${fixture.origin}${pathname}`,
      message: "concurrent inline failure",
      fatal: false,
    },
  ]));
});

test("serializes dynamic inline modules whose async property is false", async ({ page }) => {
  await installBundle(page);
  const result = await page.evaluate(async ({ frameNonce, source }) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: (Window & { __orderedInlineEvents?: string[] }) | null;
    };
    frame.setAttribute("nonce", frameNonce);
    const loaded = new Promise<void>((resolveLoaded) => {
      frame.addEventListener("v-frame-load", () => resolveLoaded(), { once: true });
    });
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
    await loaded;

    const childWindow = frame.contentWindow!;
    childWindow.__orderedInlineEvents = [];
    const first = childWindow.document.createElement("script");
    first.type = "module";
    first.async = false;
    first.text = `
      window.__orderedInlineEvents.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      window.__orderedInlineEvents.push("first-end");
    `;
    const second = childWindow.document.createElement("script");
    second.type = "module";
    second.async = false;
    second.text = 'window.__orderedInlineEvents.push("second");';
    childWindow.document.body.append(first, second);

    const deadline = Date.now() + 3_000;
    while (childWindow.__orderedInlineEvents.length < 3 && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    return childWindow.__orderedInlineEvents;
  }, {
    frameNonce: nonce,
    source: `${fixture.origin}/documents/blank.html`,
  });

  expect(result).toEqual(["first-start", "first-end", "second"]);
});
