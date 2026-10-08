import { expect, test } from "@playwright/test";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  bundleRoute,
  htmlDocument,
  type HTTPFixture,
  parkRoute,
  type Route,
  type RouteHandler,
  type RouteResponse,
  sendResponse,
  startHTTPFixture,
} from "./support/http-fixture";
import { installBundle } from "./support/mount-frame";

interface RecordedFailure {
  phase: string;
  fatal: boolean;
  message: string;
}

const nonce = "script-release-fidelity-nonce";
const contentSecurityPolicy = {
  "content-security-policy": `script-src 'self' 'nonce-${nonce}'; object-src 'none'`,
};
let fixture: HTTPFixture;

function html(body: string): string {
  return htmlDocument(body);
}

function script(body: string): RouteResponse {
  return { type: "text/javascript", body };
}

const deferredFirstScript = parkRoute(
  script("window.__deferredEvents.push('first');"),
  contentSecurityPolicy,
);

/**
 * The module answers at once and releases the deferred classic only after its own bytes
 * have gone out, so the classic provably arrives second on every run. Executing it first
 * anyway is the document-order guarantee under test.
 */
const serveDeferredSecond: RouteHandler = (_request, response) => {
  response.on("finish", () => void deferredFirstScript.release());
  return script("window.__deferredEvents.push('second');");
};

/**
 * Parked for the whole of the bootstrap-blocker test: a script appended from the child's
 * load handler must not have settled by the time the frame reports load, and a parked
 * response makes that true by construction rather than by outrunning a 20 ms wait.
 */
const postReadyScript = parkRoute(
  script(
    "window.__postReadyScriptSettled = true; window.__dynamicBlockerEvents.push('post-ready');",
  ),
  contentSecurityPolicy,
);

function searchParamsOf(request: IncomingMessage): URLSearchParams {
  return new URL(request.url ?? "/", "http://fixture.invalid").searchParams;
}

/**
 * The teardown fixture keys its scripts by token so each test can hold, and later
 * release, only the responses its own frame requested.
 */
function teardownDocument(request: IncomingMessage): RouteResponse {
  const token = JSON.stringify(searchParamsOf(request).get("token") ?? "missing");
  return {
    body: html(`
        <script>
          window.__teardownStarted = true;
          const classic = document.createElement('script');
          classic.src = '../scripts/teardown-classic.js?token=' + ${token};
          const module = document.createElement('script');
          module.type = 'module';
          module.src = '../scripts/teardown-module.js?token=' + ${token};
          document.head.append(classic, module);
        </script>
      `),
  };
}

function startFixtureServer(): Promise<HTTPFixture> {
  const pendingTeardownResponses = new Map<string, Set<ServerResponse>>();
  const releasedTeardownTokens = new Set<string>();

  const holdTeardownScript: Route = (request, response) => {
    const token = searchParamsOf(request).get("token") ?? "missing";
    if (releasedTeardownTokens.has(token)) {
      return script("window.__staleTeardownScriptExecuted = true;");
    }
    const responses = pendingTeardownResponses.get(token) ?? new Set<ServerResponse>();
    responses.add(response);
    pendingTeardownResponses.set(token, responses);
    response.on("close", () => responses.delete(response));
    return undefined;
  };

  const releaseTeardownScripts: Route = (request) => {
    const token = searchParamsOf(request).get("token") ?? "missing";
    releasedTeardownTokens.add(token);
    for (const pendingResponse of pendingTeardownResponses.get(token) ?? []) {
      sendResponse(
        pendingResponse,
        script("window.__staleTeardownScriptExecuted = true;"),
        contentSecurityPolicy,
      );
    }
    pendingTeardownResponses.delete(token);
    return { status: 204, type: "text/plain", body: "" };
  };

  return startHTTPFixture({
    headers: contentSecurityPolicy,
    routes: {
      "/": html('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/documents/script-events.html": html(`
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
      `),
      "/documents/csp-inline.html": html(`
        <script src="../scripts/install-blocked-listener.js"></script>
        <script id="blocked-inline">window.__blockedInlineExecuted = true;</script>
      `),
      "/documents/deferred-concurrency.html": html(`
        <script>window.__deferredEvents = [];</script>
        <script defer src="../scripts/deferred-first.js"></script>
        <script type="module" src="../scripts/deferred-second.js"></script>
      `),
      "/documents/dynamic-blockers.html": html(`
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
      `),
      "/documents/pending-external-module.html": html(`
        <script type="module" async src="../scripts/pending-module.js"></script>
        <script>setTimeout(() => { throw new Error('timer failure while external module is pending'); }, 10);</script>
      `),
      "/documents/teardown.html": teardownDocument,
      "/documents/blank.html": html("<main>replacement</main>"),
      "/scripts/loaded.js": script("window.__loadedScriptExecuted = true;"),
      "/scripts/missing.js": { status: 404, type: "text/javascript", body: "missing" },
      "/scripts/install-blocked-listener.js": script(`
        window.__blockedInlineErrors = 0;
        document.querySelector('#blocked-inline').addEventListener('error', () => window.__blockedInlineErrors += 1);
      `),
      "/scripts/deferred-first.js": deferredFirstScript.route,
      "/scripts/deferred-second.js": serveDeferredSecond,
      "/scripts/dynamic-classic.js": {
        ...script(
          "window.__dynamicClassicSettled = true; window.__dynamicBlockerEvents.push('classic-execute');",
        ),
        delay: 75,
      },
      "/scripts/dynamic-module.js": {
        ...script(
          "window.__dynamicModuleSettled = true; window.__dynamicBlockerEvents.push('module-execute');",
        ),
        delay: 125,
      },
      "/scripts/post-ready.js": postReadyScript.route,
      "/scripts/pending-module.js": script("await new Promise(() => undefined);"),
      "/scripts/teardown-classic.js": holdTeardownScript,
      "/scripts/teardown-module.js": holdTeardownScript,
      "/release-teardown": releaseTeardownScripts,
    },
  });
}

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  // A parked request keeps its socket open, which would otherwise stall the close of a
  // server whose test failed before releasing it.
  deferredFirstScript.abandon();
  postReadyScript.abandon();
  await fixture.close();
});

test("dispatches one logical handler event and reports an empty source as a script failure", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const result = await page.evaluate(
    async ({ frameNonce, source }) => {
      const frame = document.createElement("v-frame") as HTMLElement & {
        contentWindow: (Window & Record<string, unknown>) | null;
        status: string;
      };
      const failures: RecordedFailure[] = [];
      frame.setAttribute("nonce", frameNonce);
      frame.addEventListener("v-frame-error", (event) => {
        const detail = (
          event as CustomEvent<{
            phase: string;
            fatal: boolean;
            error: unknown;
          }>
        ).detail;
        const error = detail.error as { message?: unknown } | null;
        failures.push({
          phase: detail.phase,
          fatal: detail.fatal,
          message:
            typeof error?.message === "string" ? error.message : String(detail.error),
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
      const dynamicFailed = new Promise<void>((resolveFailed) => {
        dynamicEmptySource.addEventListener("error", () => resolveFailed(), {
          once: true,
        });
      });
      childWindow.document.head.append(dynamicEmptySource);
      await dynamicFailed;
      return {
        checks: childWindow.__scriptEventChecks,
        dynamicEmptySourceExecuted: childWindow.__dynamicEmptySourceExecuted === true,
        emptySourceExecuted: childWindow.__emptySourceExecuted === true,
        failures,
        status: frame.status,
      };
    },
    {
      frameNonce: nonce,
      source: `${fixture.origin}/documents/script-events.html`,
    },
  );

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

test("reports a CSP-blocked inline classic once without dispatching load", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
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
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
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

test("starts deferred classic and module fetches together while executing in document order", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const result = await page.evaluate(
    async ({ frameNonce, source }) => {
      const frame = document.createElement("v-frame") as HTMLElement & {
        contentWindow: (Window & { __deferredEvents?: string[] }) | null;
      };
      frame.setAttribute("nonce", frameNonce);
      const loaded = new Promise<void>((resolveLoaded, rejectLoaded) => {
        const timeout = setTimeout(
          () => rejectLoaded(new Error("v-frame-load timed out")),
          3_000,
        );
        frame.addEventListener(
          "v-frame-load",
          () => {
            clearTimeout(timeout);
            resolveLoaded();
          },
          { once: true },
        );
      });
      frame.setAttribute("src", source);
      document.querySelector("#host")?.append(frame);
      await loaded;
      return frame.contentWindow?.__deferredEvents;
    },
    {
      frameNonce: nonce,
      source: `${fixture.origin}/documents/deferred-concurrency.html`,
    },
  );

  expect(result).toEqual(["first", "second"]);
});

test("waits for bootstrap dynamic resources before child and frame load", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const result = await page.evaluate(
    async ({ frameNonce, source }) => {
      const frame = document.createElement("v-frame") as HTMLElement & {
        contentWindow:
          | (Window & {
              __dynamicBlockerEvents?: string[];
              __postReadyScriptSettled?: boolean;
            })
          | null;
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
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      return {
        events: frame.contentWindow?.__dynamicBlockerEvents,
        frameLoadCalls,
        postReadyScriptSettled: frame.contentWindow?.__postReadyScriptSettled === true,
      };
    },
    {
      frameNonce: nonce,
      source: `${fixture.origin}/documents/dynamic-blockers.html`,
    },
  );

  expect(result.frameLoadCalls).toBe(1);
  expect(result.events).toContain("dom-content-loaded");
  expect(result.events).toContain("classic-execute");
  expect(result.events).toContain("classic-load");
  expect(result.events).toContain("module-execute");
  expect(result.events).toContain("module-load");
  expect(result.events?.at(-1)).toBe("load:true:true");
  expect(result.postReadyScriptSettled).toBe(false);

  // Answer it now that the assertion has been made, so the child's socket does not outlive
  // the page it belongs to.
  await postReadyScript.release();
});

test("reports a timer error immediately while an external module remains pending", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const result = await page.evaluate(
    async ({ frameNonce, source }) => {
      const frame = document.createElement("v-frame");
      let loaded = false;
      frame.setAttribute("nonce", frameNonce);
      frame.addEventListener("v-frame-load", () => {
        loaded = true;
      });
      const failure = new Promise<{ phase: string; message: string }>(
        (resolveFailure) => {
          frame.addEventListener(
            "v-frame-error",
            (event) => {
              const detail = (event as CustomEvent<{ phase: string; error: unknown }>)
                .detail;
              const error = detail.error as { message?: unknown } | null;
              resolveFailure({
                phase: detail.phase,
                message:
                  typeof error?.message === "string"
                    ? error.message
                    : String(detail.error),
              });
            },
            { once: true },
          );
        },
      );
      frame.setAttribute("src", source);
      document.querySelector("#host")?.append(frame);
      const recordedFailure = await Promise.race([
        failure,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("runtime failure was deferred behind the module")),
            1_000,
          ),
        ),
      ]);
      frame.remove();
      return { failure: recordedFailure, loaded };
    },
    {
      frameNonce: nonce,
      source: `${fixture.origin}/documents/pending-external-module.html`,
    },
  );

  expect(result).toEqual({
    failure: {
      phase: "runtime",
      message: "timer failure while external module is pending",
    },
    loaded: false,
  });
});

for (const action of ["disconnect", "supersede"] as const) {
  test(`does not publish delayed classic or module settlements after ${action}`, async ({
    page,
  }) => {
    await installBundle(page, fixture.origin);
    const token = `${action}-${test.info().project.name}-${Date.now()}`;
    const result = await page.evaluate(
      async ({ action, frameNonce, origin, token }) => {
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
        await fetch(`${origin}/documents/blank.html`);
        await new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        );
        return { errors, loads };
      },
      { action, frameNonce: nonce, origin: fixture.origin, token },
    );

    expect(result).toEqual({
      errors: 0,
      loads: action === "disconnect" ? 0 : 1,
    });
  });
}
