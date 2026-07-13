import { expect, test, type Page } from "@playwright/test";
import { startFixtureServer, type FixtureServer } from "./support/fixture-server";

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture.close();
});

async function mountFrame(page: Page) {
  await page.goto(fixture.origin);
  await page.evaluate(async (bundleURL) => {
    const bundle = await import(bundleURL);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
  await page.evaluate((source) => {
    const frame = document.createElement("v-frame");
    frame.id = "navigation-frame";
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
  }, `${fixture.origin}/documents/application.html`);
  const frame = page.locator("#navigation-frame");
  await expect.poll(() => frame.evaluate(
    (element) => (element as HTMLElement & { status: string }).status,
  )).toBe("ready");
  return frame;
}

test("resolves history URLs against the live base and preserves the URL when omitted", async ({
  page,
}) => {
  const frame = await mountFrame(page);

  const result = await frame.evaluate((element, origin) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow;
    if (child === null) {
      throw new Error("The navigation frame has no child window");
    }
    const base = child.document.createElement("base");
    base.href = "/first-base/";
    child.document.head.prepend(base);

    child.history.pushState({ step: "push" }, "", "pushed");
    const afterPush = child.document.URL;
    base.href = "/second-base/";
    child.history.replaceState({ step: "replace" }, "", "replaced");
    const afterReplace = child.document.URL;

    child.history.pushState({ step: "omitted" }, "");
    const afterOmitted = child.document.URL;
    child.history.pushState({ step: "empty" }, "", "");
    const afterEmpty = child.document.URL;
    child.history.pushState({ step: "null" }, "", null);
    const afterNull = child.document.URL;

    base.href = "https://cross-origin.invalid/base/";
    const failures: Array<{
      method: string;
      name: string;
      childDOMException: boolean;
    }> = [];
    for (const method of ["pushState", "replaceState"] as const) {
      try {
        child.history[method]({}, "", "relative");
      } catch (error) {
        failures.push({
          method,
          name: (error as Error).name,
          childDOMException: error instanceof child.DOMException,
        });
      }
    }

    return {
      afterPush,
      afterReplace,
      afterOmitted,
      afterEmpty,
      afterNull,
      failures,
      finalURL: child.document.URL,
      length: child.history.length,
      state: child.history.state,
      expectedOrigin: origin,
    };
  }, fixture.origin);

  expect(result).toEqual({
    afterPush: `${fixture.origin}/first-base/pushed`,
    afterReplace: `${fixture.origin}/second-base/replaced`,
    afterOmitted: `${fixture.origin}/second-base/replaced`,
    afterEmpty: `${fixture.origin}/second-base/replaced`,
    afterNull: `${fixture.origin}/second-base/replaced`,
    failures: [
      { method: "pushState", name: "SecurityError", childDOMException: true },
      { method: "replaceState", name: "SecurityError", childDOMException: true },
    ],
    finalURL: `${fixture.origin}/second-base/replaced`,
    length: 5,
    state: { step: "null" },
    expectedOrigin: fixture.origin,
  });
});

test("keeps prototype history calls virtual and applies child-realm Web IDL semantics", async ({
  page,
}) => {
  const frame = await mountFrame(page);
  const hostHistory = await page.evaluate(() => ({
    href: location.href,
    length: history.length,
    state: history.state,
  }));

  const result = await frame.evaluate(async (element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow;
    if (child === null) {
      throw new Error("The navigation frame has no child window");
    }
    const prototype = child.History.prototype;
    const lengthGetter = Object.getOwnPropertyDescriptor(prototype, "length")?.get;
    const stateGetter = Object.getOwnPropertyDescriptor(prototype, "state")?.get;
    if (lengthGetter === undefined || stateGetter === undefined) {
      throw new Error("The child History prototype has no virtual getters");
    }

    prototype.pushState.call(child.history, { step: 0 }, "", "#zero");
    prototype.pushState.call(child.history, { step: 1 }, "", "#one");
    prototype.pushState.call(child.history, { step: 2 }, "", "#two");
    const prototypeState = stateGetter.call(child.history);
    const prototypeLength = lengthGetter.call(child.history);

    const missingArguments: Array<{ method: string; childTypeError: boolean }> = [];
    for (const method of ["pushState", "replaceState"] as const) {
      try {
        child.history[method]({});
      } catch (error) {
        missingArguments.push({ method, childTypeError: error instanceof child.TypeError });
      }
    }
    let illegalReceiverIsChildTypeError = false;
    try {
      prototype.pushState.call({}, {}, "", "#bypass");
    } catch (error) {
      illegalReceiverIsChildTypeError = error instanceof child.TypeError;
    }

    prototype.go.call(child.history, "-1");
    await new Promise((resolve) => child.setTimeout(resolve, 0));
    const afterStringTraversal = child.document.URL;
    const events: string[] = [];
    child.addEventListener("popstate", () => events.push("popstate"));
    child.addEventListener("hashchange", () => events.push("hashchange"));
    prototype.go.call(child.history, 0);
    prototype.go.call(child.history, Number.NaN);
    prototype.go.call(child.history, 99);
    await new Promise((resolve) => child.setTimeout(resolve, 0));

    const numericFailures: boolean[] = [];
    for (const value of [Symbol("delta"), 1n]) {
      try {
        prototype.go.call(child.history, value);
      } catch (error) {
        numericFailures.push(error instanceof child.TypeError);
      }
    }

    return {
      prototypeState,
      prototypeLength,
      afterStringTraversal,
      finalURL: child.document.URL,
      finalState: child.history.state,
      events,
      missingArguments,
      illegalReceiverIsChildTypeError,
      numericFailures,
    };
  });

  expect(result).toEqual({
    prototypeState: { step: 2 },
    prototypeLength: 4,
    afterStringTraversal: `${fixture.origin}/documents/application.html#one`,
    finalURL: `${fixture.origin}/documents/application.html#one`,
    finalState: { step: 1 },
    events: [],
    missingArguments: [
      { method: "pushState", childTypeError: true },
      { method: "replaceState", childTypeError: true },
    ],
    illegalReceiverIsChildTypeError: true,
    numericFailures: [true, true],
  });
  expect(await page.evaluate(() => ({
    href: location.href,
    length: history.length,
    state: history.state,
  }))).toEqual(hostHistory);
});

test("keeps retained prototype history methods inert after disposal", async ({ page }) => {
  const frame = await mountFrame(page);
  const hostHistory = await page.evaluate(() => ({
    href: location.href,
    length: history.length,
    state: history.state,
  }));

  const result = await frame.evaluate((element) => {
    const controlledFrame = element as HTMLElement & { contentWindow: Window | null };
    const child = controlledFrame.contentWindow;
    if (child === null) {
      throw new Error("The navigation frame has no child window");
    }
    const retainedHistory = child.history;
    const retainedPrototype = child.History.prototype;
    retainedHistory.pushState({ retained: true }, "", "#retained");
    const before = {
      length: retainedHistory.length,
      state: retainedHistory.state,
      url: child.document.URL,
    };
    controlledFrame.remove();

    let exception: string | null = null;
    try {
      retainedPrototype.pushState.call(retainedHistory, () => undefined, "", "http://[");
      retainedPrototype.replaceState.call(retainedHistory, () => undefined, "", "http://[");
      retainedPrototype.pushState.call(retainedHistory);
      retainedPrototype.back.call(retainedHistory);
      retainedPrototype.forward.call(retainedHistory);
      retainedPrototype.go.call(retainedHistory, Symbol("disposed"));
      retainedHistory.scrollRestoration = "manual";
    } catch (error) {
      exception = String(error);
    }
    return {
      before,
      after: {
        length: retainedHistory.length,
        state: retainedHistory.state,
        url: child.document.URL,
        scrollRestoration: retainedHistory.scrollRestoration,
      },
      exception,
    };
  });

  expect(result).toEqual({
    before: {
      length: 2,
      state: { retained: true },
      url: `${fixture.origin}/documents/application.html#retained`,
    },
    after: {
      length: 2,
      state: { retained: true },
      url: `${fixture.origin}/documents/application.html#retained`,
      scrollRestoration: "auto",
    },
    exception: null,
  });
  expect(await page.evaluate(() => ({
    href: location.href,
    length: history.length,
    state: history.state,
  }))).toEqual(hostHistory);
});

test("documents javascript Location evaluation without document replacement as unsupported", async ({
  page,
}) => {
  const frame = await mountFrame(page);
  const result = await frame.evaluate(async (element) => {
    const controlledFrame = element as HTMLElement & {
      contentWindow: (Window & { __javascriptLocationExecuted?: boolean }) | null;
      currentURL: string | null;
      status: string;
    };
    const child = controlledFrame.contentWindow;
    if (child === null) {
      throw new Error("The navigation frame has no child window");
    }
    const initialURL = controlledFrame.currentURL;
    const events: string[] = [];
    element.addEventListener("v-frame-error", () => events.push("error"));
    element.addEventListener("v-frame-navigate", () => events.push("navigate"));

    child.eval(
      'location.assign("javascript:void (globalThis.__javascriptLocationExecuted = true)")',
    );
    await new Promise((resolve) => child.setTimeout(resolve, 0));
    return {
      executed: child.__javascriptLocationExecuted === true,
      events,
      initialURL,
      currentURL: controlledFrame.currentURL,
      status: controlledFrame.status,
      retainedWindow: controlledFrame.contentWindow === child,
    };
  });

  expect(result).toEqual({
    executed: true,
    events: [],
    initialURL: `${fixture.origin}/documents/application.html`,
    currentURL: `${fixture.origin}/documents/application.html`,
    status: "ready",
    retainedWindow: true,
  });
});

test("uses the live base for window and SVG link navigation", async ({ page }) => {
  const frame = await mountFrame(page);
  await frame.evaluate((element) => {
    (element as HTMLElement & { navigations?: Array<{ kind: string; to: string }> })
      .navigations = [];
    element.addEventListener("v-frame-navigate", (event) => {
      const frameElement = element as HTMLElement & {
        navigations: Array<{ kind: string; to: string }>;
      };
      const detail = (event as CustomEvent<{ kind: string; to: string }>).detail;
      frameElement.navigations.push({ kind: detail.kind, to: detail.to });
    });
  });

  const openURLs = await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow;
    if (child === null) {
      throw new Error("The navigation frame has no child window");
    }
    const base = child.document.createElement("base");
    base.href = "/first-window-base/";
    child.document.head.prepend(base);
    child.open("first", "_self");
    const first = child.document.URL;
    base.href = "/second-window-base/";
    child.open("second", "_self");
    return { first, second: child.document.URL };
  });
  expect(openURLs).toEqual({
    first: `${fixture.origin}/first-window-base/first`,
    second: `${fixture.origin}/second-window-base/second`,
  });

  await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow;
    if (child === null) {
      throw new Error("The navigation frame has no child window");
    }
    const base = child.document.querySelector("base") as HTMLBaseElement;
    base.href = "/svg-base/";
    const svg = child.document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const anchor = child.document.createElementNS("http://www.w3.org/2000/svg", "a");
    anchor.id = "svg-navigation-link";
    anchor.setAttribute("href", "destination.html");
    const text = child.document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.textContent = "SVG destination";
    anchor.append(text);
    svg.append(anchor);
    child.document.body.append(svg);
  });
  await frame.evaluate(async (element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow;
    const anchor = child?.document.querySelector("#svg-navigation-link");
    if (child === null || child === undefined || anchor === null) {
      throw new Error("The SVG navigation link is unavailable");
    }
    anchor.dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    }));
    await new Promise((resolve) => child.setTimeout(resolve, 0));
  });
  await expect.poll(() => frame.evaluate(
    (element) => (element as HTMLElement & { currentURL: string }).currentURL,
  )).toBe(`${fixture.origin}/svg-base/destination.html`);
  expect(await frame.evaluate((element) => (
    element as HTMLElement & { navigations: Array<{ kind: string; to: string }> }
  ).navigations)).toEqual([
    { kind: "window", to: `${fixture.origin}/first-window-base/first` },
    { kind: "window", to: `${fixture.origin}/second-window-base/second` },
    { kind: "link", to: `${fixture.origin}/svg-base/destination.html` },
  ]);
});

test("uses the first valid base target and scrolls to malformed legacy fragments", async ({
  page,
}) => {
  const frame = await mountFrame(page);
  await frame.evaluate((element) => {
    (element as HTMLElement & { navigations?: string[] }).navigations = [];
    element.addEventListener("v-frame-navigate", (event) => {
      (element as HTMLElement & { navigations: string[] }).navigations.push(
        (event as CustomEvent<{ to: string }>).detail.to,
      );
    });
  });
  await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow;
    if (child === null) {
      throw new Error("The navigation frame has no child window");
    }
    const invalidBase = child.document.createElement("base");
    invalidBase.target = "";
    const popupBase = child.document.createElement("base");
    popupBase.href = "/base-target/";
    popupBase.target = "_blank";
    child.document.head.prepend(invalidBase, popupBase);

    const link = child.document.createElement("a");
    link.id = "base-target-link";
    link.href = "linked";
    link.textContent = "Open link";
    const form = child.document.createElement("form");
    form.id = "base-target-form";
    form.action = "submitted";
    form.method = "get";
    const button = child.document.createElement("button");
    button.textContent = "Submit form";
    form.append(button);
    child.document.body.append(link, form);
  });

  const linkPopupPromise = page.context().waitForEvent("page");
  await frame.locator("#base-target-link").click();
  const linkPopup = await linkPopupPromise;
  await linkPopup.waitForLoadState("domcontentloaded");
  expect(linkPopup.url()).toBe(`${fixture.origin}/base-target/linked`);
  await linkPopup.close();

  const formPopupPromise = page.context().waitForEvent("page");
  await frame.locator("#base-target-form button").click();
  const formPopup = await formPopupPromise;
  await formPopup.waitForLoadState("domcontentloaded");
  expect(formPopup.url()).toBe(`${fixture.origin}/base-target/submitted`);
  await formPopup.close();
  expect(await frame.evaluate(
    (element) => (element as HTMLElement & { currentURL: string }).currentURL,
  )).toBe(`${fixture.origin}/documents/application.html`);

  await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow;
    if (child === null) {
      throw new Error("The navigation frame has no child window");
    }
    child.document.querySelectorAll("base").forEach((base) => base.remove());
    const legacyTarget = child.document.createElement("a");
    legacyTarget.name = "bad%ZZ";
    let scrollCount = 0;
    legacyTarget.scrollIntoView = () => {
      scrollCount += 1;
    };
    const fragmentLink = child.document.createElement("a");
    fragmentLink.id = "malformed-fragment-link";
    fragmentLink.href = "#bad%ZZ";
    fragmentLink.textContent = "Malformed legacy fragment";
    child.document.body.append(legacyTarget, fragmentLink);
    Object.defineProperty(child, "__legacyScrollCount", {
      configurable: true,
      get: () => scrollCount,
    });
  });
  await frame.locator("#malformed-fragment-link").click();
  await expect.poll(() => frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow;
    return (child as Window & { __legacyScrollCount?: number } | null)?.__legacyScrollCount;
  })).toBe(1);
  expect(await frame.evaluate(
    (element) => (element as HTMLElement & { currentURL: string }).currentURL,
  )).toBe(`${fixture.origin}/documents/application.html#bad%ZZ`);
});
