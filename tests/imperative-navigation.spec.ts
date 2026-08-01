import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  type ContractFixtureServers,
  type FixtureServer,
  startContractFixtureServers,
  startFixtureServer,
} from "./support/fixture-server";
import { installBundle, mountFrame } from "./support/mount-frame";

/** The imperative navigation surface under test, as the host sees it. */
interface NavigableFrame extends HTMLElement {
  contentWindow: (Window & typeof globalThis) | null;
  currentURL: string | null;
  status: string;
  canGoBack: boolean;
  canGoForward: boolean;
  navigate(url: string | URL, options?: { replace?: boolean }): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  go(delta?: number): Promise<void>;
}

let fixture: FixtureServer;
let contractFixture: ContractFixtureServers;

test.beforeAll(async () => {
  [fixture, contractFixture] = await Promise.all([
    startFixtureServer(),
    startContractFixtureServers(),
  ]);
});

test.afterAll(async () => {
  await Promise.all([fixture.close(), contractFixture.close()]);
});

async function mountNavigationFrame(page: Page): Promise<Locator> {
  await installBundle(page, fixture.origin);
  return mountFrame(page, {
    src: `${fixture.origin}/documents/application.html`,
    id: "imperative-frame",
  });
}

/** Records both navigation events on the element and popstate inside the guest. */
async function recordNavigationEvents(frame: Locator): Promise<void> {
  await frame.evaluate((element) => {
    const controlled = element as NavigableFrame & { events: string[] };
    controlled.events = [];
    element.addEventListener("v-frame-navigate", (event) => {
      const detail = (event as CustomEvent<{ kind: string; to: string }>).detail;
      controlled.events.push(
        `navigate:${detail.kind}:${new URL(detail.to).pathname}${new URL(detail.to).hash}:${event.cancelable}`,
      );
    });
    element.addEventListener("v-frame-navigated", (event) => {
      const detail = (event as CustomEvent<{ from: string; to: string; kind: string }>)
        .detail;
      const from = new URL(detail.from);
      const to = new URL(detail.to);
      controlled.events.push(
        `navigated:${detail.kind}:${from.pathname}${from.hash}->${to.pathname}${to.hash}`,
      );
    });
    controlled.contentWindow?.addEventListener("popstate", () =>
      controlled.events.push("popstate"),
    );
  });
}

function navigationEvents(frame: Locator): Promise<string[]> {
  return frame.evaluate(
    (element) => (element as NavigableFrame & { events: string[] }).events,
  );
}

test("moves the guest to a new route without replacing its document", async ({
  page,
}) => {
  const frame = await mountNavigationFrame(page);
  await recordNavigationEvents(frame);

  const result = await frame.evaluate(async (element) => {
    const controlled = element as NavigableFrame;
    const child = controlled.contentWindow;
    if (child === null) {
      throw new Error("The imperative frame has no child window");
    }
    const before = { canGoBack: controlled.canGoBack, window: child };
    await controlled.navigate("reports?tab=open");
    return {
      canGoBackBefore: before.canGoBack,
      canGoBackAfter: controlled.canGoBack,
      canGoForward: controlled.canGoForward,
      currentURL: controlled.currentURL,
      href: child.location.href,
      documentURL: child.document.URL,
      length: child.history.length,
      retainedWindow: controlled.contentWindow === before.window,
      status: controlled.status,
    };
  });

  expect(result).toEqual({
    canGoBackBefore: false,
    canGoBackAfter: true,
    canGoForward: false,
    currentURL: `${fixture.origin}/documents/reports?tab=open`,
    href: `${fixture.origin}/documents/reports?tab=open`,
    documentURL: `${fixture.origin}/documents/reports?tab=open`,
    length: 2,
    retainedWindow: true,
    status: "ready",
  });
  expect(await navigationEvents(frame)).toEqual([
    "navigate:push:/documents/reports:true",
    "navigated:push:/documents/application.html->/documents/reports",
    "popstate",
  ]);
  expect(page.url()).toBe(`${fixture.origin}/`);
});

test("replaces the current guest entry when asked to", async ({ page }) => {
  const frame = await mountNavigationFrame(page);
  await recordNavigationEvents(frame);

  const result = await frame.evaluate(async (element) => {
    const controlled = element as NavigableFrame;
    const child = controlled.contentWindow;
    if (child === null) {
      throw new Error("The imperative frame has no child window");
    }
    await controlled.navigate("/documents/first-route");
    await controlled.navigate("/documents/second-route", { replace: true });
    return {
      canGoBack: controlled.canGoBack,
      canGoForward: controlled.canGoForward,
      currentURL: controlled.currentURL,
      length: child.history.length,
    };
  });

  expect(result).toEqual({
    canGoBack: true,
    canGoForward: false,
    currentURL: `${fixture.origin}/documents/second-route`,
    length: 2,
  });
  expect(await navigationEvents(frame)).toEqual([
    "navigate:push:/documents/first-route:true",
    "navigated:push:/documents/application.html->/documents/first-route",
    "popstate",
    "navigate:replace:/documents/second-route:true",
    "navigated:replace:/documents/first-route->/documents/second-route",
    "popstate",
  ]);
});

test("traverses the guest session through back, forward, and go", async ({ page }) => {
  const frame = await mountNavigationFrame(page);

  const result = await frame.evaluate(async (element) => {
    const controlled = element as NavigableFrame;
    const child = controlled.contentWindow;
    if (child === null) {
      throw new Error("The imperative frame has no child window");
    }
    const kinds: string[] = [];
    element.addEventListener("v-frame-navigated", (event) => {
      kinds.push((event as CustomEvent<{ kind: string }>).detail.kind);
    });
    await controlled.navigate("/documents/step-one");
    await controlled.navigate("/documents/step-two");

    await controlled.back();
    const back = {
      canGoBack: controlled.canGoBack,
      canGoForward: controlled.canGoForward,
      href: child.location.href,
    };
    await controlled.forward();
    const forward = { href: child.location.href };
    await controlled.go(-2);
    const start = {
      canGoBack: controlled.canGoBack,
      canGoForward: controlled.canGoForward,
      href: child.location.href,
    };
    // Traversal past the end of the session is a no-op, exactly as history.go is.
    await controlled.back();
    await controlled.go(0);
    await controlled.go(Number.NaN);
    return { back, forward, start, settled: child.location.href, kinds };
  });

  expect(result).toEqual({
    back: {
      canGoBack: true,
      canGoForward: true,
      href: `${fixture.origin}/documents/step-one`,
    },
    forward: { href: `${fixture.origin}/documents/step-two` },
    start: {
      canGoBack: false,
      canGoForward: true,
      href: `${fixture.origin}/documents/application.html`,
    },
    settled: `${fixture.origin}/documents/application.html`,
    kinds: ["push", "push", "traverse", "traverse", "traverse"],
  });
});

test("rejects imperative navigation the host cancels or cannot route", async ({
  page,
}) => {
  const frame = await mountNavigationFrame(page);

  const result = await frame.evaluate(async (element) => {
    const controlled = element as NavigableFrame;
    const failure = async (run: () => Promise<void>) => {
      try {
        await run();
        return "resolved";
      } catch (error) {
        return `${(error as Error).name}: ${(error as Error).message}`;
      }
    };

    const crossOrigin = await failure(() =>
      controlled.navigate("https://cross-origin.invalid/route"),
    );
    const unsupportedScheme = await failure(() =>
      controlled.navigate("mailto:someone@example.com"),
    );

    const cancel = (event: Event) => event.preventDefault();
    element.addEventListener("v-frame-navigate", cancel);
    const canceledNavigate = await failure(() =>
      controlled.navigate("/documents/denied"),
    );
    await controlled.navigate("/documents/allowed").catch(() => undefined);
    element.removeEventListener("v-frame-navigate", cancel);
    await controlled.navigate("/documents/allowed");
    element.addEventListener("v-frame-navigate", cancel);
    const canceledBack = await failure(() => controlled.back());
    element.removeEventListener("v-frame-navigate", cancel);

    const afterCancel = controlled.currentURL;
    element.remove();
    const idleNavigate = await failure(() => controlled.navigate("/documents/idle"));
    const idleBack = await failure(() => controlled.back());
    return {
      crossOrigin,
      unsupportedScheme,
      canceledNavigate,
      canceledBack,
      afterCancel,
      idleNavigate,
      idleBack,
      idleCanGoBack: controlled.canGoBack,
    };
  });

  expect(result).toEqual({
    crossOrigin: `TypeError: v-frame route https://cross-origin.invalid/route must share host origin ${fixture.origin}`,
    unsupportedScheme: `TypeError: v-frame route "mailto:someone@example.com" must use http: or https:, received mailto:`,
    canceledNavigate: `AbortError: v-frame navigation to ${fixture.origin}/documents/denied was canceled`,
    canceledBack: `AbortError: v-frame navigation to ${fixture.origin}/documents/allowed was canceled`,
    afterCancel: `${fixture.origin}/documents/allowed`,
    idleNavigate: "InvalidStateError: v-frame cannot navigate without an active guest",
    idleBack: "InvalidStateError: v-frame cannot traverse without an active guest",
    idleCanGoBack: false,
  });
});

test("reports guest-initiated URL changes as navigated", async ({ page }) => {
  const frame = await mountNavigationFrame(page);
  await recordNavigationEvents(frame);

  await frame.evaluate(async (element) => {
    const child = (element as NavigableFrame).contentWindow;
    if (child === null) {
      throw new Error("The imperative frame has no child window");
    }
    child.history.pushState({ step: 1 }, "", "guest-push");
    child.history.replaceState({ step: 2 }, "", "guest-replace");
    child.location.hash = "guest-fragment";
    await new Promise((resolve) => child.setTimeout(resolve, 0));
    child.history.back();
    await new Promise((resolve) => child.setTimeout(resolve, 0));
  });

  expect(await navigationEvents(frame)).toEqual([
    "navigate:push:/documents/guest-push:false",
    "navigated:push:/documents/application.html->/documents/guest-push",
    "navigate:replace:/documents/guest-replace:false",
    "navigated:replace:/documents/guest-push->/documents/guest-replace",
    "navigate:fragment:/documents/guest-replace#guest-fragment:true",
    "navigated:fragment:/documents/guest-replace->/documents/guest-replace#guest-fragment",
    "popstate",
    "navigate:traverse:/documents/guest-replace:false",
    "navigated:traverse:/documents/guest-replace#guest-fragment->/documents/guest-replace",
    "popstate",
  ]);
});

test("reports a document navigation as navigated once the replacement is live", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/first.html`,
    id: "document-navigated-frame",
  });
  await frame.evaluate((element) => {
    const controlled = element as NavigableFrame & { events: string[] };
    controlled.events = [];
    element.addEventListener("v-frame-navigated", (event) => {
      const detail = (event as CustomEvent<{ from: string; to: string; kind: string }>)
        .detail;
      controlled.events.push(
        `${detail.kind}:${new URL(detail.from).pathname}->${new URL(detail.to).pathname}`,
      );
    });
    element.addEventListener("v-frame-load", () => controlled.events.push("load"));
  });

  await frame.locator("#next").click();
  await expect(frame.locator("#second")).toHaveText("Second document");
  expect(await navigationEvents(frame)).toEqual([
    "link:/documents/first.html->/documents/second.html",
    "load",
  ]);
  // The URL the replacement guest reports keeps flowing to the host after the swap.
  await frame.evaluate((element) => {
    const child = (element as NavigableFrame).contentWindow;
    child?.history.pushState(null, "", "replaced-route");
  });
  expect(await navigationEvents(frame)).toEqual([
    "link:/documents/first.html->/documents/second.html",
    "load",
    "push:/documents/second.html->/documents/replaced-route",
  ]);
  expect(await frame.evaluate((element) => (element as NavigableFrame).currentURL)).toBe(
    `${fixture.origin}/documents/replaced-route`,
  );
});

test("drives shell history without touching the host page's own pushState", async ({
  page,
}) => {
  await page.goto(`${contractFixture.origin}/documents/bound-shell.html`);
  await page.evaluate(async (bundleURL) => {
    const bundle = await import(bundleURL);
    bundle.defineVFrame();
    const shell = window as Window &
      typeof globalThis & {
        __order: string[];
        __nativePushState: History["pushState"];
        __shellPushState: History["pushState"];
      };
    shell.__order = [];
    shell.__nativePushState = history.pushState;
    // A host router wrapping history.pushState is the integration v-frame must not break.
    function shellPushState(this: History, state: unknown, unused: string, url?: string) {
      shell.__order.push("shell");
      return shell.__nativePushState.call(this, state, unused, url);
    }
    shell.__shellPushState = shellPushState;
    history.pushState = shellPushState;

    const frame = document.createElement("v-frame");
    frame.id = "bound-frame";
    frame.setAttribute("navigation", "host");
    frame.setAttribute("src", location.href);
    frame.addEventListener("v-frame-navigated", (event) => {
      const detail = (event as CustomEvent<{ kind: string; to: string }>).detail;
      shell.__order.push(`frame:${detail.kind}:${new URL(detail.to).pathname}`);
    });
    document.querySelector("#host")?.append(frame);
  }, `${contractFixture.origin}/dist/index.js`);

  const frame = page.locator("#bound-frame");
  await expect
    .poll(() => frame.evaluate((element) => (element as NavigableFrame).status))
    .toBe("ready");

  const shellDriven = await page.evaluate(() => {
    const shell = window as Window & typeof globalThis & { __order: string[] };
    shell.__order = [];
    history.pushState({ owner: "shell" }, "", "/documents/shell-route");
    return shell.__order;
  });
  expect(shellDriven).toEqual(["shell", "frame:push:/documents/shell-route"]);
  expect(
    await frame.evaluate((element) => {
      const controlled = element as NavigableFrame;
      return {
        currentURL: controlled.currentURL,
        href: controlled.contentWindow?.location.href,
      };
    }),
  ).toEqual({
    currentURL: `${contractFixture.origin}/documents/shell-route`,
    href: `${contractFixture.origin}/documents/shell-route`,
  });

  const frameDriven = await frame.evaluate(async (element) => {
    const shell = window as Window & typeof globalThis & { __order: string[] };
    shell.__order = [];
    const controlled = element as NavigableFrame;
    await controlled.navigate("/documents/frame-route");
    return {
      order: shell.__order,
      canGoBack: controlled.canGoBack,
      guestPopStates: (
        controlled.contentWindow as Window & { __boundPopStates?: unknown[] }
      ).__boundPopStates,
    };
  });
  expect(frameDriven).toEqual({
    order: ["shell", "frame:push:/documents/frame-route"],
    canGoBack: true,
    // The shell's own pushState above already activated the guest once.
    guestPopStates: [{ owner: "shell" }, null],
  });
  await expect(page).toHaveURL(`${contractFixture.origin}/documents/frame-route`);

  await frame.evaluate((element) => (element as NavigableFrame).back());
  await expect(page).toHaveURL(`${contractFixture.origin}/documents/shell-route`);
  await expect
    .poll(() => frame.evaluate((element) => (element as NavigableFrame).currentURL))
    .toBe(`${contractFixture.origin}/documents/shell-route`);

  expect(
    await page.evaluate(() => {
      const shell = window as Window &
        typeof globalThis & {
          __nativePushState: History["pushState"];
          __shellPushState: History["pushState"];
        };
      document.querySelector("#bound-frame")?.remove();
      return {
        wrapperIntact: history.pushState === shell.__shellPushState,
        prototypeIntact: History.prototype.pushState === shell.__nativePushState,
      };
    }),
  ).toEqual({ wrapperIntact: true, prototypeIntact: true });
});
