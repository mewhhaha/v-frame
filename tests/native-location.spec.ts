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
  destination: string;
  path: string;
}

let fixture: HTTPFixture<ObservedRequest>;

function page(body: string): string {
  return `<!doctype html><html><body>${body}</body></html>`;
}

function observeRequest(request: IncomingMessage): ObservedRequest {
  return {
    destination: String(request.headers["sec-fetch-dest"] ?? ""),
    path: requestPathname(request),
  };
}

function startNativeLocationFixture(): Promise<HTTPFixture<ObservedRequest>> {
  return startHTTPFixture({
    record: observeRequest,
    routes: {
      "/": page('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/adopted": page(`
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
      `),
      "/routes/entry.html": page(`<main id="native-entry">Native entry</main>
          <button id="hard-navigation">Hard navigation</button>
          <script>
            document.querySelector('#hard-navigation').addEventListener('click', () => {
              location.assign('/routes/destination.html');
            });
          </script>`),
      "/routes/destination.html": page(
        '<main id="shell-destination">Top-level destination</main>',
      ),
      "/ordinary/entry.html": page('<main id="ordinary-entry">Ordinary entry</main>'),
    },
  });
}

test.beforeAll(async () => {
  fixture = await startNativeLocationFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

async function mountLocationFrame(
  pageInstance: Page,
  source = "/routes/entry.html",
): Promise<Locator> {
  await installBundle(pageInstance, fixture.origin);
  return mountFrame(pageInstance, { src: source, id: "location-frame" });
}

test("uses the guest route as native Location without an iframe request", async ({
  page: pageInstance,
}) => {
  const requestStart = fixture.requests.length;
  const frame = await mountLocationFrame(pageInstance);

  await expect(frame.locator("#native-entry")).toHaveText("Native entry");
  expect(
    await frame.evaluate(
      (element) =>
        (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
          .contentWindow?.location.href,
    ),
  ).toBe(`${fixture.origin}/routes/entry.html`);
  const routeRequests = fixture.requests
    .slice(requestStart)
    .filter((request) => request.path === "/routes/entry.html");
  expect(routeRequests).toEqual([{ destination: "empty", path: "/routes/entry.html" }]);
});

test("loads an ordinary same-origin route", async ({ page: pageInstance }) => {
  const frame = await mountLocationFrame(pageInstance, "/ordinary/entry.html");

  await expect(frame.locator("#ordinary-entry")).toHaveText("Ordinary entry");
});

test("preserves replace semantics for native Location navigation", async ({
  page: pageInstance,
}) => {
  const frame = await mountLocationFrame(pageInstance);
  await frame.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        element.addEventListener("v-frame-load", () => resolve(), { once: true });
        const child = (
          element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
        ).contentWindow;
        child?.location.replace("/routes/destination.html");
      }),
  );

  await expect(frame.locator("#shell-destination")).toHaveText("Top-level destination");
  expect(
    await frame.evaluate(
      (element) =>
        (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
          .contentWindow?.history.length,
    ),
  ).toBe(1);
});

test("loads direct Location navigation inside the guest", async ({
  page: pageInstance,
}) => {
  const frame = await mountLocationFrame(pageInstance);
  await frame.locator("#hard-navigation").click();

  await expect(frame.locator("#shell-destination")).toHaveText("Top-level destination");
  await expect
    .poll(() =>
      frame.evaluate(
        (element) => (element as HTMLElement & { currentURL: string | null }).currentURL,
      ),
    )
    .toBe(`${fixture.origin}/routes/destination.html`);
  expect(pageInstance.url()).toBe(`${fixture.origin}/`);
});

test("lets a guest Navigation interceptor own same-document routing", async ({
  page: pageInstance,
}) => {
  const requestStart = fixture.requests.length;
  const frame = await mountLocationFrame(pageInstance);
  const originalWindow = await frame.evaluateHandle(
    (element) =>
      (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
        .contentWindow,
  );
  await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow;
    child?.navigation.addEventListener("navigate", (event) => {
      if (!event.destination.url.endsWith("/routes/spa.html")) {
        return;
      }
      event.intercept({
        handler() {
          child.document.querySelector("#native-entry")!.textContent = "Guest SPA route";
        },
      });
    });
    child?.location.assign("/routes/spa.html");
  });

  await expect(frame.locator("#native-entry")).toHaveText("Guest SPA route");
  await expect
    .poll(() =>
      frame.evaluate(
        (element) => (element as HTMLElement & { currentURL: string | null }).currentURL,
      ),
    )
    .toBe(`${fixture.origin}/routes/spa.html`);
  expect(
    await frame.evaluate(
      (element, previousWindow) =>
        (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
          .contentWindow === previousWindow,
      originalWindow,
    ),
  ).toBe(true);
  expect(
    fixture.requests
      .slice(requestStart)
      .some((request) => request.path === "/routes/spa.html"),
  ).toBe(false);
});

test("honors guest cancellation of native Location navigation", async ({
  page: pageInstance,
}) => {
  const frame = await mountLocationFrame(pageInstance);
  const originalWindow = await frame.evaluateHandle(
    (element) =>
      (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
        .contentWindow,
  );
  const loadStarted = await frame.evaluate(async (element) => {
    let started = false;
    element.addEventListener(
      "v-frame-loadstart",
      () => {
        started = true;
      },
      { once: true },
    );
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow;
    child?.navigation.addEventListener(
      "navigate",
      (event) => {
        event.preventDefault();
      },
      { once: true },
    );
    child?.location.assign("/routes/destination.html");
    await new Promise((resolve) => child?.setTimeout(resolve, 0));
    return started;
  });

  expect(loadStarted).toBe(false);
  expect(
    await frame.evaluate((element, previousWindow) => {
      const child = (
        element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
      ).contentWindow;
      return {
        currentURL: (element as HTMLElement & { currentURL: string | null }).currentURL,
        retainedWindow: child === previousWindow,
      };
    }, originalWindow),
  ).toEqual({
    currentURL: `${fixture.origin}/routes/entry.html`,
    retainedWindow: true,
  });
});

test("reloads the guest without adding a document history entry", async ({
  page: pageInstance,
}) => {
  const frame = await mountLocationFrame(pageInstance);
  const originalWindow = await frame.evaluateHandle(
    (element) =>
      (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
        .contentWindow,
  );
  await frame.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        element.addEventListener("v-frame-load", () => resolve(), { once: true });
        const child = (
          element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
        ).contentWindow;
        child?.location.reload();
      }),
  );

  expect(
    await frame.evaluate((element, previousWindow) => {
      const child = (
        element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
      ).contentWindow;
      return {
        historyLength: child?.history.length,
        replacedWindow: child !== previousWindow,
      };
    }, originalWindow),
  ).toEqual({
    historyLength: 1,
    replacedWindow: true,
  });
  expect(pageInstance.url()).toBe(`${fixture.origin}/`);
});

test("promotes direct Location navigation in explicit host mode", async ({
  page: pageInstance,
}) => {
  const frame = await mountLocationFrame(pageInstance);
  await frame.evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        element.addEventListener("v-frame-load", () => resolve(), { once: true });
        element.setAttribute("navigation", "host");
      }),
  );
  await frame.locator("#hard-navigation").click();

  await expect(pageInstance).toHaveURL(`${fixture.origin}/routes/destination.html`);
  await expect(pageInstance.locator("#shell-destination")).toHaveText(
    "Top-level destination",
  );
});

test("keeps the current realm when direct navigation is canceled", async ({
  page: pageInstance,
}) => {
  const frame = await mountLocationFrame(pageInstance);
  const originalWindow = await frame.evaluateHandle(
    (element) =>
      (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
        .contentWindow,
  );
  await frame.evaluate((element) => {
    element.addEventListener("v-frame-navigate", (event) => event.preventDefault(), {
      once: true,
    });
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow;
    child?.location.assign("/routes/destination.html");
  });

  await expect(frame.locator("#native-entry")).toHaveText("Native entry");
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as HTMLElement & { status: string }).status),
    )
    .toBe("ready");
  expect(
    await frame.evaluate(
      (element, previousWindow) =>
        (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
          .contentWindow === previousWindow,
      originalWindow,
    ),
  ).toBe(true);
  expect(pageInstance.url()).toBe(`${fixture.origin}/`);
});

test("activates adopted markup without requesting its source route", async ({
  page: pageInstance,
}) => {
  const requestStart = fixture.requests.length;
  await pageInstance.goto(`${fixture.origin}/adopted`);
  const frame = pageInstance.locator("#adopted-native-frame");

  await expect(frame.locator("#adopted-copy")).toHaveText("Adopted native route");
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as HTMLElement & { status: string }).status),
    )
    .toBe("ready");
  expect(
    fixture.requests
      .slice(requestStart)
      .filter((request) => request.path === "/routes/entry.html"),
  ).toEqual([]);
});
