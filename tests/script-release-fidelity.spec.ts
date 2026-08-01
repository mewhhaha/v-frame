import { expect, test, type Page } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

interface RecordedFailure {
  phase: string;
  fatal: boolean;
  message: string;
}

const nonce = "script-release-fidelity-nonce";
let fixture: FixtureServer;
let deferredSecondRequested = false;
const pendingDeferredFirstResponses = new Set<ServerResponse>();

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

function documentSource(pathname: string, searchParams: URLSearchParams): string | undefined {
  switch (pathname) {
    case "/documents/script-events.html":
      return html(`
        <script>window.__scriptEventChecks = [];</script>
        <script
          id="loaded-script"
          src="../scripts/loaded.js"
          onload="window.__scriptEventChecks.push({ kind: 'load', logicalThis: this === document.querySelector('#loaded-script'), logicalTarget: event.target === this, logicalCurrentTarget: event.currentTarget === this })"
        ></script>
        <script
          id="failed-script"
          src="../scripts/missing.js"
          onerror="window.__scriptEventChecks.push({ kind: 'error', logicalThis: this === document.querySelector('#failed-script'), logicalTarget: event.target === this, logicalCurrentTarget: event.currentTarget === this })"
        ></script>
        <script
          id="empty-source"
          src=""
          onerror="window.__scriptEventChecks.push({ kind: 'empty', logicalThis: this === document.querySelector('#empty-source'), logicalTarget: event.target === this, logicalCurrentTarget: event.currentTarget === this })"
        >window.__emptySourceExecuted = true;</script>
      `);
    case "/documents/csp-inline.html":
      return html(`
        <script src="../scripts/install-blocked-listener.js"></script>
        <script id="blocked-inline">window.__blockedInlineExecuted = true;</script>
      `);
    case "/documents/deferred-concurrency.html":
      return html(`
        <script>window.__deferredEvents = [];</script>
        <script defer src="../scripts/deferred-first.js"></script>
        <script type="module" src="../scripts/deferred-second.js"></script>
      `);
    case "/documents/dynamic-blockers.html":
      return html(`
        <script>
          window.__dynamicBlockerEvents = [];
          const classic = document.createElement('script');
          classic.src = '../scripts/dynamic-classic.js';
          classic.onload = () => window.__dynamicBlockerEvents.push('classic-load');
          const module = document.createElement('script');
          module.type = 'module';
          module.src = '../scripts/dynamic-module.js';
          module.onload = () => window.__dynamicBlockerEvents.push('module-load');
          document.head.append(classic, module);
          document.addEventListener('DOMContentLoaded', () => window.__dynamicBlockerEvents.push('dom-content-loaded'));
          window.addEventListener('load', () => {
            window.__dynamicBlockerEvents.push(
              'load:' + Boolean(window.__dynamicClassicSettled) + ':' + Boolean(window.__dynamicModuleSettled),
            );
            const postReady = document.createElement('script');
            postReady.src = '../scripts/post-ready.js';
            document.head.append(postReady);
          });
        </script>
      `);
    case "/documents/pending-external-module.html":
      return html(`
        <script type="module" async src="../scripts/pending-module.js"></script>
        <script>setTimeout(() => { throw new Error('timer failure while external module is pending'); }, 10);</script>
      `);
    case "/documents/teardown.html": {
      const token = JSON.stringify(searchParams.get("token") ?? "missing");
      return html(`
        <script>
          window.__teardownStarted = true;
          const classic = document.createElement('script');
          classic.src = '../scripts/teardown-classic.js?token=' + ${token};
          const module = document.createElement('script');
          module.type = 'module';
          module.src = '../scripts/teardown-module.js?token=' + ${token};
          document.head.append(classic, module);
        </script>
      `);
    }
    case "/documents/blank.html":
      return html("<main>replacement</main>");
    default:
      return undefined;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
}

async function startFixtureServer(): Promise<FixtureServer> {
  const bundle = resolve(process.cwd(), "dist/index.js");
  const pendingTeardownResponses = new Map<string, Set<ServerResponse>>();
  const releasedTeardownTokens = new Set<string>();
  const server = createServer((request, response) => {
    const requestURL = new URL(request.url ?? "/", "http://fixture.invalid");
    const { pathname, searchParams } = requestURL;
    if (pathname === "/") {
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-security-policy": `script-src 'self' 'nonce-${nonce}'; object-src 'none'`,
        "content-type": "text/html",
      });
      response.end(html('<div id="host"></div>'));
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

    const document = documentSource(pathname, searchParams);
    if (document !== undefined) {
      reply(response, 200, "text/html", document);
      return;
    }
    if (pathname === "/scripts/loaded.js") {
      reply(response, 200, "text/javascript", "window.__loadedScriptExecuted = true;");
      return;
    }
    if (pathname === "/scripts/missing.js") {
      reply(response, 404, "text/javascript", "missing");
      return;
    }
    if (pathname === "/scripts/install-blocked-listener.js") {
      reply(response, 200, "text/javascript", `
        window.__blockedInlineErrors = 0;
        document.querySelector('#blocked-inline').addEventListener('error', () => window.__blockedInlineErrors += 1);
      `);
      return;
    }
    if (pathname === "/scripts/deferred-first.js") {
      if (deferredSecondRequested) {
        reply(response, 200, "text/javascript", "window.__deferredEvents.push('first');");
        return;
      }
      pendingDeferredFirstResponses.add(response);
      response.on("close", () => pendingDeferredFirstResponses.delete(response));
      return;
    }
    if (pathname === "/scripts/deferred-second.js") {
      deferredSecondRequested = true;
      reply(response, 200, "text/javascript", "window.__deferredEvents.push('second');");
      setTimeout(() => {
        for (const firstResponse of pendingDeferredFirstResponses) {
          reply(firstResponse, 200, "text/javascript", "window.__deferredEvents.push('first');");
        }
        pendingDeferredFirstResponses.clear();
      }, 50);
      return;
    }
    if (pathname === "/scripts/dynamic-classic.js") {
      setTimeout(() => reply(
        response,
        200,
        "text/javascript",
        "window.__dynamicClassicSettled = true; window.__dynamicBlockerEvents.push('classic-execute');",
      ), 75);
      return;
    }
    if (pathname === "/scripts/dynamic-module.js") {
      setTimeout(() => reply(
        response,
        200,
        "text/javascript",
        "window.__dynamicModuleSettled = true; window.__dynamicBlockerEvents.push('module-execute');",
      ), 125);
      return;
    }
    if (pathname === "/scripts/post-ready.js") {
      setTimeout(() => reply(
        response,
        200,
        "text/javascript",
        "window.__postReadyScriptSettled = true; window.__dynamicBlockerEvents.push('post-ready');",
      ), 100);
      return;
    }
    if (pathname === "/scripts/pending-module.js") {
      reply(response, 200, "text/javascript", "await new Promise(() => undefined);");
      return;
    }
    if (
      pathname === "/scripts/teardown-classic.js" ||
      pathname === "/scripts/teardown-module.js"
    ) {
      const token = searchParams.get("token") ?? "missing";
      if (releasedTeardownTokens.has(token)) {
        reply(response, 200, "text/javascript", "window.__staleTeardownScriptExecuted = true;");
        return;
      }
      const responses = pendingTeardownResponses.get(token) ?? new Set<ServerResponse>();
      responses.add(response);
      pendingTeardownResponses.set(token, responses);
      response.on("close", () => responses.delete(response));
      return;
    }
    if (pathname === "/release-teardown") {
      const token = searchParams.get("token") ?? "missing";
      releasedTeardownTokens.add(token);
      for (const pendingResponse of pendingTeardownResponses.get(token) ?? []) {
        reply(
          pendingResponse,
          200,
          "text/javascript",
          "window.__staleTeardownScriptExecuted = true;",
        );
      }
      pendingTeardownResponses.delete(token);
      reply(response, 204, "text/plain", "");
      return;
    }
    reply(response, 404, "text/plain", `No fixture for ${pathname}`);
  });

  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Script release fixture did not expose a TCP address");
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

test("dispatches one logical handler event and reports an empty source as a script failure", async ({ page }) => {
  await installBundle(page);
  const result = await page.evaluate(async ({ frameNonce, source }) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: (Window & Record<string, unknown>) | null;
      status: string;
    };
    const failures: RecordedFailure[] = [];
    frame.setAttribute("nonce", frameNonce);
    frame.addEventListener("v-frame-error", (event) => {
      const detail = (event as CustomEvent<{
        phase: string;
        fatal: boolean;
        error: unknown;
      }>).detail;
      const error = detail.error as { message?: unknown } | null;
      failures.push({
        phase: detail.phase,
        fatal: detail.fatal,
        message: typeof error?.message === "string" ? error.message : String(detail.error),
      });
    });
    const loaded = new Promise<void>((resolveLoaded) => {
      frame.addEventListener("v-frame-load", () => resolveLoaded(), { once: true });
    });
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
    await loaded;
    const childWindow = frame.contentWindow!;
    const dynamicEmptySource = childWindow.document.createElement("script");
    dynamicEmptySource.src = "";
    dynamicEmptySource.text = "window.__dynamicEmptySourceExecuted = true;";
    dynamicEmptySource.addEventListener("error", (event) => {
      (childWindow.__scriptEventChecks as Array<Record<string, unknown>>).push({
        kind: "dynamic-empty",
        logicalThis: event.currentTarget === dynamicEmptySource,
        logicalTarget: event.target === dynamicEmptySource,
        logicalCurrentTarget: event.currentTarget === dynamicEmptySource,
      });
    });
    childWindow.document.head.append(dynamicEmptySource);
    return {
      checks: childWindow.__scriptEventChecks,
      dynamicEmptySourceExecuted: childWindow.__dynamicEmptySourceExecuted === true,
      emptySourceExecuted: childWindow.__emptySourceExecuted === true,
      failures,
      status: frame.status,
    };
  }, {
    frameNonce: nonce,
    source: `${fixture.origin}/documents/script-events.html`,
  });

  expect(result).toEqual({
    checks: [
      {
        kind: "load",
        logicalThis: true,
        logicalTarget: true,
        logicalCurrentTarget: true,
      },
      {
        kind: "error",
        logicalThis: true,
        logicalTarget: true,
        logicalCurrentTarget: true,
      },
      {
        kind: "empty",
        logicalThis: true,
        logicalTarget: true,
        logicalCurrentTarget: true,
      },
      {
        kind: "dynamic-empty",
        logicalThis: true,
        logicalTarget: true,
        logicalCurrentTarget: true,
      },
    ],
    dynamicEmptySourceExecuted: false,
    emptySourceExecuted: false,
    failures: [
      expect.objectContaining({ phase: "script", fatal: false }),
      {
        phase: "script",
        fatal: false,
        message: `Script source is empty at ${fixture.origin}/documents/script-events.html`,
      },
      {
        phase: "script",
        fatal: false,
        message: `Script source is empty at ${fixture.origin}/documents/script-events.html`,
      },
    ],
    status: "ready",
  });
});

test("reports a CSP-blocked inline classic once without dispatching load", async ({ page }) => {
  await installBundle(page);
  const result = await page.evaluate(async (source) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: (Window & Record<string, unknown>) | null;
      status: string;
    };
    const failures: Array<{ phase: string; fatal: boolean }> = [];
    frame.addEventListener("v-frame-error", (event) => {
      const detail = (event as CustomEvent<{ phase: string; fatal: boolean }>).detail;
      failures.push({ phase: detail.phase, fatal: detail.fatal });
    });
    const loaded = new Promise<void>((resolveLoaded) => {
      frame.addEventListener("v-frame-load", () => resolveLoaded(), { once: true });
    });
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
    await loaded;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    return {
      blockedErrorEvents: frame.contentWindow?.__blockedInlineErrors,
      blockedInlineExecuted: frame.contentWindow?.__blockedInlineExecuted === true,
      failures,
      status: frame.status,
    };
  }, `${fixture.origin}/documents/csp-inline.html`);

  expect(result).toEqual({
    blockedErrorEvents: 1,
    blockedInlineExecuted: false,
    failures: [{ phase: "script", fatal: false }],
    status: "ready",
  });
});

test("starts deferred classic and module fetches together while executing in document order", async ({ page }) => {
  await installBundle(page);
  const result = await page.evaluate(async ({ frameNonce, source }) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: (Window & { __deferredEvents?: string[] }) | null;
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
    return frame.contentWindow?.__deferredEvents;
  }, {
    frameNonce: nonce,
    source: `${fixture.origin}/documents/deferred-concurrency.html`,
  });

  expect(result).toEqual(["first", "second"]);
});

test("waits for bootstrap dynamic resources before child and frame load", async ({ page }) => {
  await installBundle(page);
  const result = await page.evaluate(async ({ frameNonce, source }) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: (Window & {
        __dynamicBlockerEvents?: string[];
        __postReadyScriptSettled?: boolean;
      }) | null;
    };
    let frameLoadCalls = 0;
    frame.setAttribute("nonce", frameNonce);
    const loaded = new Promise<void>((resolveLoaded) => {
      frame.addEventListener("v-frame-load", () => {
        frameLoadCalls += 1;
        resolveLoaded();
      });
    });
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
    await loaded;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    return {
      events: frame.contentWindow?.__dynamicBlockerEvents,
      frameLoadCalls,
      postReadyScriptSettled: frame.contentWindow?.__postReadyScriptSettled === true,
    };
  }, {
    frameNonce: nonce,
    source: `${fixture.origin}/documents/dynamic-blockers.html`,
  });

  expect(result.frameLoadCalls).toBe(1);
  expect(result.events).toContain("dom-content-loaded");
  expect(result.events).toContain("classic-execute");
  expect(result.events).toContain("classic-load");
  expect(result.events).toContain("module-execute");
  expect(result.events).toContain("module-load");
  expect(result.events?.at(-1)).toBe("load:true:true");
  expect(result.postReadyScriptSettled).toBe(false);
});

test("reports a timer error immediately while an external module remains pending", async ({ page }) => {
  await installBundle(page);
  const result = await page.evaluate(async ({ frameNonce, source }) => {
    const frame = document.createElement("v-frame");
    let loaded = false;
    frame.setAttribute("nonce", frameNonce);
    frame.addEventListener("v-frame-load", () => {
      loaded = true;
    });
    const failure = new Promise<{ phase: string; message: string }>((resolveFailure) => {
      frame.addEventListener("v-frame-error", (event) => {
        const detail = (event as CustomEvent<{ phase: string; error: unknown }>).detail;
        const error = detail.error as { message?: unknown } | null;
        resolveFailure({
          phase: detail.phase,
          message: typeof error?.message === "string" ? error.message : String(detail.error),
        });
      }, { once: true });
    });
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
    const recordedFailure = await Promise.race([
      failure,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error("runtime failure was deferred behind the module")),
        1_000,
      )),
    ]);
    frame.remove();
    return { failure: recordedFailure, loaded };
  }, {
    frameNonce: nonce,
    source: `${fixture.origin}/documents/pending-external-module.html`,
  });

  expect(result).toEqual({
    failure: {
      phase: "runtime",
      message: "timer failure while external module is pending",
    },
    loaded: false,
  });
});

for (const action of ["disconnect", "supersede"] as const) {
  test(`does not publish delayed classic or module settlements after ${action}`, async ({ page }) => {
    await installBundle(page);
    const token = `${action}-${test.info().project.name}-${Date.now()}`;
    const result = await page.evaluate(async ({ action, frameNonce, origin, token }) => {
      const frame = document.createElement("v-frame") as HTMLElement & {
        contentWindow: (Window & Record<string, unknown>) | null;
      };
      let errors = 0;
      let loads = 0;
      frame.setAttribute("nonce", frameNonce);
      frame.addEventListener("v-frame-error", () => {
        errors += 1;
      });
      frame.addEventListener("v-frame-load", () => {
        loads += 1;
      });
      frame.setAttribute("src", `${origin}/documents/teardown.html?token=${token}`);
      document.querySelector("#host")?.append(frame);
      const deadline = Date.now() + 2_000;
      while (frame.contentWindow?.__teardownStarted !== true && Date.now() < deadline) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      if (action === "disconnect") {
        frame.remove();
      } else {
        frame.setAttribute("src", `${origin}/documents/blank.html`);
        while (loads === 0 && Date.now() < deadline) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
      }
      await fetch(`${origin}/release-teardown?token=${token}`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      return { errors, loads };
    }, { action, frameNonce: nonce, origin: fixture.origin, token });

    expect(result).toEqual({
      errors: 0,
      loads: action === "disconnect" ? 0 : 1,
    });
  });
}
