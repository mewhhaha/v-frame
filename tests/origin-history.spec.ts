import { expect, test } from "@playwright/test";
import {
  startContractFixtureServers,
  type ContractFixtureServers,
} from "./support/fixture-server";

let fixture: ContractFixtureServers;

test.beforeAll(async () => {
  fixture = await startContractFixtureServers();
});

test.afterAll(async () => {
  await fixture.close();
});

async function installBundle(page: import("@playwright/test").Page) {
  await page.goto(fixture.origin);
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  await expect.poll(() => page.evaluate(() => Boolean(customElements.get("v-frame")))).toBe(true);
}

async function childValue<T>(
  frame: import("@playwright/test").Locator,
  expression: (window: Window & typeof globalThis) => T,
): Promise<T> {
  return frame.evaluate((element, source) => {
    const evaluate = new Function("window", `return (${source})(window)`);
    return evaluate((element as HTMLElement & { contentWindow: Window | null }).contentWindow);
  }, expression.toString()) as Promise<T>;
}

test("mirrors virtual URL components into a host-origin iframe realm", async ({ page }) => {
  await installBundle(page);
  const sourceOrigin = fixture.corsOrigin.replace("127.0.0.1", "localhost");
  await page.context().addCookies([{
    name: "vframe_source_cookie",
    value: "source-origin",
    url: sourceOrigin,
    sameSite: "Lax",
  }]);
  await page.evaluate(() => {
    localStorage.setItem("vframe_origin_storage", "host-origin");
    sessionStorage.setItem("vframe_origin_session", "host-origin");
    document.cookie = "vframe_origin_cookie=host-origin; Path=/; SameSite=Lax";
  });

  const hostHistory = await page.evaluate(() => ({
    href: location.href,
    length: history.length,
    state: history.state,
  }));
  const hostDocumentRequests = fixture.requests.filter((path) => path === "/").length;
  fixture.corsRequests.length = 0;
  const sourceURL = `${sourceOrigin}/documents/location.html?entry=1#initial`;

  await page.evaluate((source) => {
    const frame = document.createElement("v-frame");
    frame.id = "origin-history";
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
  }, sourceURL);
  const frame = page.locator("v-frame#origin-history");
  await expect.poll(() => frame.evaluate((element) => (element as { status: string }).status)).toBe("ready");
  await expect.poll(() => childValue(frame, (window) => (
    window as Window & typeof globalThis & { __originHistoryAnimationFrameCount: number }
  ).__originHistoryAnimationFrameCount)).toBe(1);

  const initial = await childValue(frame, (window) => (
    window as Window & typeof globalThis & {
      __initialLocationSnapshot: Record<string, string | null>;
    }
  ).__initialLocationSnapshot);
  expect(initial).toEqual({
    href: `${fixture.origin}/documents/location.html?entry=1#initial`,
    origin: fixture.origin,
    globalOrigin: fixture.origin,
    pathname: "/documents/location.html",
    search: "?entry=1",
    hash: "#initial",
    documentURL: sourceURL,
    documentURI: sourceURL,
    localStorage: "host-origin",
    sessionStorage: "host-origin",
    cookie: expect.stringContaining("vframe_origin_cookie=host-origin"),
  });
  expect(initial.cookie).not.toContain("vframe_source_cookie=source-origin");

  const states = await childValue(frame, async (window) => {
    const snapshot = () => ({
      href: window.location.href,
      origin: window.location.origin,
      pathname: window.location.pathname,
      search: window.location.search,
      hash: window.location.hash,
      documentURL: window.document.URL,
      documentURI: window.document.documentURI,
    });

    window.history.pushState({ step: "push" }, "", "pushed.html?step=1#pushed");
    const pushed = snapshot();
    window.history.replaceState({ step: "replace" }, "", "replaced.html?step=2#replaced");
    const replaced = snapshot();
    window.history.back();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const traversedBack = snapshot();
    window.history.forward();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const traversedForward = snapshot();

    return { pushed, replaced, traversedBack, traversedForward };
  });

  expect(states).toEqual({
    pushed: {
      href: `${fixture.origin}/documents/pushed.html?step=1#pushed`,
      origin: fixture.origin,
      pathname: "/documents/pushed.html",
      search: "?step=1",
      hash: "#pushed",
      documentURL: `${sourceOrigin}/documents/pushed.html?step=1#pushed`,
      documentURI: `${sourceOrigin}/documents/pushed.html?step=1#pushed`,
    },
    replaced: {
      href: `${fixture.origin}/documents/replaced.html?step=2#replaced`,
      origin: fixture.origin,
      pathname: "/documents/replaced.html",
      search: "?step=2",
      hash: "#replaced",
      documentURL: `${sourceOrigin}/documents/replaced.html?step=2#replaced`,
      documentURI: `${sourceOrigin}/documents/replaced.html?step=2#replaced`,
    },
    traversedBack: {
      href: `${fixture.origin}/documents/location.html?entry=1#initial`,
      origin: fixture.origin,
      pathname: "/documents/location.html",
      search: "?entry=1",
      hash: "#initial",
      documentURL: sourceURL,
      documentURI: sourceURL,
    },
    traversedForward: {
      href: `${fixture.origin}/documents/replaced.html?step=2#replaced`,
      origin: fixture.origin,
      pathname: "/documents/replaced.html",
      search: "?step=2",
      hash: "#replaced",
      documentURL: `${sourceOrigin}/documents/replaced.html?step=2#replaced`,
      documentURI: `${sourceOrigin}/documents/replaced.html?step=2#replaced`,
    },
  });
  expect(await page.evaluate(() => ({
    href: location.href,
    length: history.length,
    state: history.state,
  }))).toEqual(hostHistory);
  expect(fixture.requests.filter((path) => path === "/")).toHaveLength(hostDocumentRequests);
  expect(fixture.requests.filter((path) => path.startsWith("/documents/"))).toEqual([]);
  expect(fixture.corsRequests).toEqual(["/documents/location.html"]);

  const reconnected = await frame.evaluate(async (element) => {
    const controlledFrame = element as HTMLElement & {
      contentWindow: Window | null;
      currentURL: string | null;
      status: string;
    };
    const firstWindow = controlledFrame.contentWindow;
    controlledFrame.remove();
    const disconnected = {
      contentWindow: controlledFrame.contentWindow,
      currentURL: controlledFrame.currentURL,
      status: controlledFrame.status,
    };
    const loaded = new Promise<void>((resolve) => {
      controlledFrame.addEventListener("v-frame-load", () => resolve(), { once: true });
    });
    document.querySelector("#host")?.append(controlledFrame);
    await loaded;
    const secondWindow = controlledFrame.contentWindow as Window & typeof globalThis & {
      __initialLocationSnapshot: Record<string, string | null>;
    };
    return {
      disconnected,
      recreatedWindow: secondWindow !== firstWindow,
      initial: secondWindow.__initialLocationSnapshot,
    };
  });

  expect(reconnected).toEqual({
    disconnected: { contentWindow: null, currentURL: null, status: "idle" },
    recreatedWindow: true,
    initial,
  });
  expect(fixture.requests.filter((path) => path === "/")).toHaveLength(hostDocumentRequests);
  expect(fixture.requests.filter((path) => path.startsWith("/documents/"))).toEqual([]);
  expect(fixture.corsRequests).toEqual([
    "/documents/location.html",
    "/documents/location.html",
  ]);
  expect(await page.evaluate(() => ({
    href: location.href,
    length: history.length,
    state: history.state,
  }))).toEqual(hostHistory);

  await page.evaluate(() => {
    localStorage.removeItem("vframe_origin_storage");
    sessionStorage.removeItem("vframe_origin_session");
    document.cookie = "vframe_origin_cookie=; Max-Age=0; Path=/; SameSite=Lax";
  });
});
