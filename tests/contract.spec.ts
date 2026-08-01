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
  await expect
    .poll(() => page.evaluate(() => Boolean(customElements.get("v-frame"))))
    .toBe(true);
}

async function mountFrame(
  page: import("@playwright/test").Page,
  id: string,
  source: string,
  credentials?: "omit" | "same-origin" | "include",
) {
  await page.evaluate(
    ({ frameID, frameSource, frameCredentials }) => {
      const frame = document.createElement("v-frame");
      frame.id = frameID;
      if (frameCredentials !== undefined) {
        frame.setAttribute("credentials", frameCredentials);
      }
      frame.setAttribute("src", frameSource);
      document.querySelector("#host")?.append(frame);
    },
    { frameID: id, frameSource: source, frameCredentials: credentials },
  );
  return page.locator(`v-frame#${id}`);
}

async function childValue<T>(
  frame: import("@playwright/test").Locator,
  expression: (window: Window & typeof globalThis) => T,
) {
  return frame.evaluate((element, source) => {
    const evaluate = new Function("window", `return (${source})(window)`);
    return evaluate(
      (element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null })
        .contentWindow,
    );
  }, expression.toString()) as Promise<T>;
}

test("registers one launchpad constructor across the side-effect and API entry points", async ({
  page,
}) => {
  await page.goto(fixture.origin);

  const registration = await page.evaluate(
    async ({ apiURL, registerURL }) => {
      await import(registerURL);
      const registered = customElements.get("v-frame");
      const api = await import(apiURL);
      return {
        constructorName: registered?.name,
        sharedConstructor: api.defineVFrame() === registered,
      };
    },
    {
      apiURL: `${fixture.origin}/dist/index.js`,
      registerURL: `${fixture.origin}/dist/register.js`,
    },
  );

  expect(registration).toEqual({
    constructorName: "VFrameElement",
    sharedConstructor: true,
  });
});

test("keeps a missing source idle and recreates its realm after reconnection", async ({
  page,
}) => {
  await installBundle(page);

  const state = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
      currentURL: string | null;
      status: string;
      src: string;
    };
    document.querySelector("#host")?.append(frame);
    const initially = {
      status: frame.status,
      currentURL: frame.currentURL,
      hasContentWindow: frame.contentWindow !== null,
    };
    const firstLoaded = new Promise<void>((resolve) =>
      frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    frame.src = `${origin}/documents/reconnect.html`;
    await firstLoaded;
    const firstWindow = frame.contentWindow;
    frame.remove();
    const disconnected = {
      status: frame.status,
      currentURL: frame.currentURL,
      hasContentWindow: frame.contentWindow !== null,
      internalStyleSheets: frame.shadowRoot?.adoptedStyleSheets.length,
    };
    const reconnected = new Promise<void>((resolve) =>
      frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    document.querySelector("#host")?.append(frame);
    await reconnected;
    return {
      initially,
      disconnected,
      status: frame.status,
      currentURL: frame.currentURL,
      recreatedWindow: frame.contentWindow !== firstWindow,
    };
  }, fixture.origin);

  expect(state).toEqual({
    initially: { status: "idle", currentURL: null, hasContentWindow: false },
    disconnected: {
      status: "idle",
      currentURL: null,
      hasContentWindow: false,
      internalStyleSheets: 0,
    },
    status: "ready",
    currentURL: `${fixture.origin}/documents/reconnect.html`,
    recreatedWindow: true,
  });
});

test("exposes each lifecycle value as an exclusive custom element state", async ({
  page,
}) => {
  await installBundle(page);

  const states = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      src: string;
      status: string;
    };
    const matchingStates = () =>
      ["idle", "loading", "ready", "error"].filter((state) =>
        frame.matches(`:state(${state})`),
      );
    frame.src = "";
    document.querySelector("#host")?.append(frame);
    const idle = matchingStates();

    const loaded = new Promise<void>((resolveLoaded) => {
      frame.addEventListener("v-frame-load", () => resolveLoaded(), { once: true });
    });
    frame.src = `${origin}/documents/slow.html`;
    const loading = matchingStates();
    await loaded;
    const ready = matchingStates();

    const failed = new Promise<void>((resolveFailed) => {
      frame.addEventListener("v-frame-error", () => resolveFailed(), { once: true });
    });
    frame.src = "https://cross-origin.invalid/application";
    await failed;
    return { idle, loading, ready, error: matchingStates(), status: frame.status };
  }, fixture.origin);

  expect(states).toEqual({
    idle: ["idle"],
    loading: ["loading"],
    ready: ["ready"],
    error: ["error"],
    status: "error",
  });
});

test("binds an explicit host-navigation frame to shell location and history", async ({
  page,
}) => {
  await page.goto(`${fixture.origin}/documents/bound-shell.html`);
  await page.evaluate(async (bundleURL) => {
    const bundle = await import(bundleURL);
    bundle.defineVFrame();
    (
      window as Window &
        typeof globalThis & { __unpatchedPushState?: History["pushState"] }
    ).__unpatchedPushState = history.pushState;
    const frame = document.createElement("v-frame");
    frame.setAttribute("navigation", "host");
    frame.setAttribute("src", location.href);
    document.querySelector("#host")?.append(frame);
  }, `${fixture.origin}/dist/index.js`);
  const frame = page.locator("v-frame");
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  expect(
    await childValue(frame, (window) => ({
      href: window.location.href,
      pathname: window.location.pathname,
    })),
  ).toEqual({
    href: `${fixture.origin}/documents/bound-shell.html`,
    pathname: "/documents/bound-shell.html",
  });

  await childValue(frame, (window) => {
    window.history.pushState({ owner: "child" }, "", "/documents/bound-child");
  });
  await expect(page).toHaveURL(`${fixture.origin}/documents/bound-child`);
  await expect
    .poll(() =>
      frame.evaluate(
        (element: HTMLElement & { currentURL: string | null }) => element.currentURL,
      ),
    )
    .toBe(`${fixture.origin}/documents/bound-child`);

  await page.evaluate(() => {
    history.replaceState({ owner: "host" }, "", "/documents/bound-host");
  });
  await expect
    .poll(() =>
      childValue(frame, (window) => ({
        href: window.location.href,
        state: window.history.state,
        events: (window as Window & typeof globalThis & { __boundPopStates: unknown[] })
          .__boundPopStates,
      })),
    )
    .toEqual({
      href: `${fixture.origin}/documents/bound-host`,
      state: { owner: "host" },
      events: [{ owner: "host" }],
    });

  expect(
    await frame.evaluate((element) => {
      const childHistory = (
        element as HTMLElement & { contentWindow: Window & typeof globalThis }
      ).contentWindow.history;
      element.remove();
      childHistory.back();
      return (
        history.pushState ===
        (
          window as Window &
            typeof globalThis & { __unpatchedPushState: History["pushState"] }
        ).__unpatchedPushState
      );
    }),
  ).toBe(true);
  await expect(page).toHaveURL(`${fixture.origin}/documents/bound-host`);
});

test("keeps only the latest rapid source load and exposes redirect final URLs", async ({
  page,
}) => {
  await installBundle(page);

  const result = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      currentURL: string | null;
      src: string;
    };
    const loadedURLs: string[] = [];
    frame.addEventListener("v-frame-load", (event) => {
      loadedURLs.push((event as CustomEvent<{ url: string }>).detail.url);
    });
    document.querySelector("#host")?.append(frame);
    const fastLoad = new Promise<void>((resolve) =>
      frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    frame.src = `${origin}/documents/slow.html`;
    frame.src = `${origin}/documents/fast.html`;
    await fastLoad;
    const redirectLoad = new Promise<void>((resolve) =>
      frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    frame.src = `${origin}/documents/redirect.html`;
    await redirectLoad;
    return { currentURL: frame.currentURL, loadedURLs };
  }, fixture.origin);

  expect(result).toEqual({
    currentURL: `${fixture.origin}/documents/redirected.html`,
    loadedURLs: [
      `${fixture.origin}/documents/fast.html`,
      `${fixture.origin}/documents/redirected.html`,
    ],
  });
});

test("preserves an entry fragment in currentURL and the load event", async ({ page }) => {
  await installBundle(page);

  const result = await page.evaluate(async (source) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      currentURL: string | null;
      src: string;
    };
    const loaded = new Promise<string>((resolve) => {
      frame.addEventListener(
        "v-frame-load",
        (event) => {
          resolve((event as CustomEvent<{ url: string }>).detail.url);
        },
        { once: true },
      );
    });
    frame.src = source;
    document.querySelector("#host")?.append(frame);
    return { eventURL: await loaded, currentURL: frame.currentURL };
  }, `${fixture.origin}/documents/history.html#blocked-link`);

  expect(result).toEqual({
    eventURL: `${fixture.origin}/documents/history.html#blocked-link`,
    currentURL: `${fixture.origin}/documents/history.html#blocked-link`,
  });
});

test("provides document queries, mutations, focus, and listeners through the child realm", async ({
  page,
}) => {
  await installBundle(page);
  const frame = await mountFrame(page, "dom", `${fixture.origin}/documents/dom.html`);
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  const state = await childValue(frame, async (window) => {
    const document = window.document;
    const root = document.querySelector("#dom-root");
    const clickTarget = document.querySelector("#click-target") as HTMLButtonElement;
    let clicks = 0;
    let mutations = 0;
    document.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).id === "click-target") {
        clicks += 1;
      }
    });
    const observer = new window.MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(document, { childList: true, subtree: true });
    const created = document.createElement("button");
    created.id = "created-button";
    created.textContent = "Created";
    root?.append(created);
    clickTarget.click();
    (document.querySelector("#focus-target") as HTMLInputElement).focus();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    observer.disconnect();
    return {
      rootID: root?.id,
      createdFound: document.getElementById("created-button") === created,
      buttonCount: document.querySelectorAll("button").length,
      activeID: (document.activeElement as HTMLElement).id,
      clicks,
      mutations,
    };
  });

  expect(state).toMatchObject({
    rootID: "dom-root",
    createdFound: true,
    buttonCount: 2,
    activeID: "focus-target",
    clicks: 1,
  });
  expect(state.mutations).toBeGreaterThan(0);
});

test("routes postMessage through the child window and keeps two realms separate", async ({
  page,
}) => {
  await installBundle(page);
  const first = await mountFrame(
    page,
    "first-realm",
    `${fixture.origin}/documents/messaging.html`,
  );
  const second = await mountFrame(
    page,
    "second-realm",
    `${fixture.origin}/documents/messaging.html`,
  );
  await expect
    .poll(() =>
      first.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  await expect
    .poll(() =>
      second.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  const message = await page.evaluate(async (origin) => {
    const firstFrame = document.querySelector("#first-realm") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const secondFrame = document.querySelector("#second-realm") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const firstWindow = firstFrame.contentWindow;
    const secondWindow = secondFrame.contentWindow;
    if (firstWindow === null || secondWindow === null) {
      throw new Error("Messaging fixtures did not expose child windows");
    }
    (firstWindow as Window & { __contractLocal?: string }).__contractLocal = "first";
    const response = await new Promise<{
      data: { kind: string; realm: string };
      origin: string;
      fromFirst: boolean;
    }>((resolve) => {
      const listener = (event: MessageEvent<{ kind: string; realm: string }>) => {
        window.removeEventListener("message", listener);
        resolve({
          data: event.data,
          origin: event.origin,
          fromFirst: event.source === firstWindow,
        });
      };
      window.addEventListener("message", listener);
      firstWindow.postMessage({ kind: "host-ping" }, origin);
    });
    return {
      ...response,
      distinctWindows: firstWindow !== secondWindow,
      secondHasFirstValue: "__contractLocal" in secondWindow,
    };
  }, fixture.origin);

  await expect(first.locator("#message-result")).toHaveText("host-ping");
  expect(message).toEqual({
    data: { kind: "host-ping", realm: "child" },
    origin: fixture.origin,
    fromFirst: true,
    distinctWindows: true,
    secondHasFirstValue: false,
  });
});

test("keeps innerHTML scripts inert while running dynamic scripts and reporting runtime failures", async ({
  page,
}) => {
  await installBundle(page);
  const frame = await mountFrame(
    page,
    "scripts",
    `${fixture.origin}/documents/scripts.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  const result = await page.evaluate(async () => {
    const frame = document.querySelector("#scripts") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("Script fixture did not expose a child window");
    }
    const runtimeFailure = new Promise<{
      phase: string;
      fatal: boolean;
      hasURL: boolean;
    }>((resolve) => {
      frame.addEventListener(
        "v-frame-error",
        (event) => {
          const detail = (
            event as CustomEvent<{ phase: string; fatal: boolean; url: string }>
          ).detail;
          if (detail.phase === "runtime") {
            resolve({
              phase: detail.phase,
              fatal: detail.fatal,
              hasURL: detail.url !== "",
            });
          }
        },
        { once: true },
      );
    });
    const root = child.document.querySelector("#script-root") as HTMLElement;
    root.innerHTML =
      '<script>window.__innerHTMLScriptRan = true</script><p id="inner-html-copy">inert</p>';
    const dynamic = child.document.createElement("script");
    dynamic.text =
      "window.__dynamicScriptRan = true; setTimeout(() => { throw new Error('dynamic runtime failure'); }, 0);";
    child.document.body.append(dynamic);
    const failure = await runtimeFailure;
    return {
      innerHTMLScriptRan: "__innerHTMLScriptRan" in child,
      dynamicScriptRan:
        (child as Window & { __dynamicScriptRan?: boolean }).__dynamicScriptRan === true,
      failure,
    };
  });

  await expect(frame.locator("#inner-html-copy")).toHaveText("inert");
  expect(result).toEqual({
    innerHTMLScriptRan: false,
    dynamicScriptRan: true,
    failure: {
      phase: "runtime",
      fatal: false,
      hasURL: true,
    },
  });
});

test("rewrites dynamic inline and linked styles without crossing the shadow boundary", async ({
  page,
}) => {
  await installBundle(page);
  const frame = await mountFrame(
    page,
    "styles",
    `${fixture.origin}/documents/styles.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  await childValue(frame, (window) => {
    const inlineCopy = window.document.createElement("p");
    inlineCopy.id = "dynamic-inline";
    inlineCopy.textContent = "Inline CSS";
    window.document.body.append(inlineCopy);
    const linkedCopy = window.document.createElement("p");
    linkedCopy.id = "dynamic-linked";
    linkedCopy.textContent = "Linked CSS";
    window.document.body.append(linkedCopy);
    const inlineStyle = window.document.createElement("style");
    inlineStyle.textContent = "#dynamic-inline { color: rgb(21, 22, 23); }";
    window.document.head.append(inlineStyle);
    const linkedStyle = window.document.createElement("link");
    linkedStyle.rel = "stylesheet";
    linkedStyle.href = "/assets/dynamic-linked.css";
    window.document.head.append(linkedStyle);
  });

  await expect(frame.locator("#dynamic-inline")).toHaveCSS("color", "rgb(21, 22, 23)");
  await expect(frame.locator("#dynamic-linked")).toHaveCSS("color", "rgb(31, 32, 33)");
  await expect(page.locator("body > #host-isolated")).toHaveCSS(
    "color",
    "rgb(91, 92, 93)",
  );
  await expect(frame.locator("#host-isolated")).toHaveCSS("color", "rgb(0, 0, 0)");
});

test("traverses virtual history with popstate and hashchange without changing host history", async ({
  page,
}) => {
  await installBundle(page);
  const frame = await mountFrame(
    page,
    "history",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  const hostHistory = await page.evaluate(() => ({
    href: location.href,
    length: history.length,
    state: history.state,
  }));
  await frame.evaluate((element) => {
    (
      element as HTMLElement & {
        navigationEvents?: Array<{ kind: string; cancelable: boolean }>;
      }
    ).navigationEvents = [];
    element.addEventListener("v-frame-navigate", (event) => {
      const detail = (event as CustomEvent<{ kind: string }>).detail;
      (
        element as HTMLElement & {
          navigationEvents: Array<{ kind: string; cancelable: boolean }>;
        }
      ).navigationEvents.push({ kind: detail.kind, cancelable: event.cancelable });
    });
  });

  const state = await childValue(frame, async (window) => {
    const events: Array<{
      type: string;
      state?: unknown;
      oldURL?: string;
      newURL?: string;
    }> = [];
    window.addEventListener("popstate", (event) =>
      events.push({ type: "popstate", state: event.state }),
    );
    window.addEventListener("hashchange", (event) =>
      events.push({ type: "hashchange", oldURL: event.oldURL, newURL: event.newURL }),
    );
    window.history.pushState({ step: 1 }, "", "#one");
    window.history.pushState({ step: 2 }, "", "#two");
    window.history.back();
    window.history.forward();
    const beforeTraversalTasks = { events: [...events], state: window.history.state };
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    window.history.forward();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    return {
      beforeTraversalTasks,
      events,
      state: window.history.state,
      length: window.history.length,
    };
  });

  await expect
    .poll(() =>
      frame.evaluate(
        (element: HTMLElement & { currentURL: string | null }) => element.currentURL,
      ),
    )
    .toBe(`${fixture.origin}/documents/history.html#two`);
  expect(state).toEqual({
    beforeTraversalTasks: { events: [], state: { step: 2 } },
    events: [
      { type: "popstate", state: { step: 1 } },
      {
        type: "hashchange",
        oldURL: `${fixture.origin}/documents/history.html#two`,
        newURL: `${fixture.origin}/documents/history.html#one`,
      },
      { type: "popstate", state: { step: 2 } },
      {
        type: "hashchange",
        oldURL: `${fixture.origin}/documents/history.html#one`,
        newURL: `${fixture.origin}/documents/history.html#two`,
      },
    ],
    state: { step: 2 },
    length: 3,
  });
  expect(
    await page.evaluate(() => ({
      href: location.href,
      length: history.length,
      state: history.state,
    })),
  ).toEqual(hostHistory);
  expect(
    await frame.evaluate(
      (element) =>
        (
          element as HTMLElement & {
            navigationEvents: Array<{ kind: string; cancelable: boolean }>;
          }
        ).navigationEvents,
    ),
  ).toEqual([
    { kind: "push", cancelable: false },
    { kind: "push", cancelable: false },
    { kind: "traverse", cancelable: false },
    { kind: "traverse", cancelable: false },
  ]);
});

test("delivers composed DOM events to child window listeners before link defaults", async ({
  page,
}) => {
  await installBundle(page);
  const frame = await mountFrame(
    page,
    "window-events",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  await frame.evaluate((element) => {
    (element as HTMLElement & { navigationCount?: number }).navigationCount = 0;
    element.addEventListener("v-frame-navigate", () => {
      (element as HTMLElement & { navigationCount: number }).navigationCount += 1;
    });
  });
  const result = await childValue(frame, async (window) => {
    const received: string[] = [];
    window.addEventListener("contract-custom", (event) => {
      received.push((event as CustomEvent<{ value: string }>).detail.value);
    });
    window.addEventListener("click", (event) => {
      if ((event.target as Element).closest("#blocked-link") !== null) {
        event.preventDefault();
      }
    });
    window.document.querySelector("main")?.dispatchEvent(
      new window.CustomEvent("contract-custom", {
        detail: { value: "received" },
        bubbles: true,
        composed: true,
      }),
    );
    (window.document.querySelector("#blocked-link") as HTMLAnchorElement).click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    return { received, url: window.document.URL };
  });

  expect(result).toEqual({
    received: ["received"],
    url: `${fixture.origin}/documents/history.html`,
  });
  expect(
    await frame.evaluate(
      (element) => (element as HTMLElement & { navigationCount: number }).navigationCount,
    ),
  ).toBe(0);
});

test("treats an empty hash as a local fragment and scrolls to the top", async ({
  page,
}) => {
  await installBundle(page);
  const frame = await mountFrame(
    page,
    "empty-fragment",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  await frame.evaluate((element) => {
    element.setAttribute("style", "display: block; height: 80px; overflow: auto;");
    element.scrollTop = 120;
    (element as HTMLElement & { navigationKinds?: string[] }).navigationKinds = [];
    element.addEventListener("v-frame-navigate", (event) => {
      (element as HTMLElement & { navigationKinds: string[] }).navigationKinds.push(
        (event as CustomEvent<{ kind: string }>).detail.kind,
      );
    });
  });
  await childValue(frame, (window) => {
    const events: Array<{ type: string; oldURL?: string; newURL?: string }> = [];
    (
      window as Window & typeof globalThis & { __fragmentEvents?: typeof events }
    ).__fragmentEvents = events;
    window.addEventListener("popstate", () => events.push({ type: "popstate" }));
    window.addEventListener("hashchange", (event) =>
      events.push({
        type: "hashchange",
        oldURL: event.oldURL,
        newURL: event.newURL,
      }),
    );
  });

  await frame.locator("#top-link").click();

  // The navigation default runs from a scheduled task, so the commit must be
  // observed before asserting on the recorded kinds and events.
  await expect
    .poll(() =>
      frame.evaluate(
        (element) => (element as HTMLElement & { currentURL: string }).currentURL,
      ),
    )
    .toBe(`${fixture.origin}/documents/history.html#`);
  await expect.poll(() => frame.evaluate((element) => element.scrollTop)).toBe(0);
  expect(
    await frame.evaluate((element) => ({
      url: (element as HTMLElement & { currentURL: string }).currentURL,
      kinds: (element as HTMLElement & { navigationKinds: string[] }).navigationKinds,
    })),
  ).toEqual({
    url: `${fixture.origin}/documents/history.html#`,
    kinds: ["fragment"],
  });
  expect(
    await childValue(
      frame,
      (window) =>
        (
          window as Window &
            typeof globalThis & {
              __fragmentEvents: Array<{ type: string; oldURL?: string; newURL?: string }>;
            }
        ).__fragmentEvents,
    ),
  ).toEqual([
    { type: "popstate" },
    {
      type: "hashchange",
      oldURL: `${fixture.origin}/documents/history.html`,
      newURL: `${fixture.origin}/documents/history.html#`,
    },
  ]);
});

test("reports but does not perform canceled link and form navigation", async ({
  page,
}) => {
  await installBundle(page);
  const frame = await mountFrame(
    page,
    "canceled-navigation",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  const before = await frame.evaluate(
    (element: HTMLElement & { currentURL: string | null }) => element.currentURL,
  );
  const hostHistory = await page.evaluate(() => ({
    href: location.href,
    length: history.length,
    state: history.state,
  }));

  await page.evaluate(() => {
    const frame = document.querySelector("#canceled-navigation");
    const navigations: Array<{ kind: string; to: string; cancelable: boolean }> = [];
    frame?.addEventListener("v-frame-navigate", (event) => {
      const detail = (event as CustomEvent<{ kind: string; to: string }>).detail;
      navigations.push({
        kind: detail.kind,
        to: detail.to,
        cancelable: event.cancelable,
      });
      event.preventDefault();
    });
    (
      window as Window & { contractNavigations?: typeof navigations }
    ).contractNavigations = navigations;
  });
  await childValue(frame, (window) => {
    const events: string[] = [];
    (
      window as Window & typeof globalThis & { __canceledFragmentEvents?: string[] }
    ).__canceledFragmentEvents = events;
    window.addEventListener("popstate", () => events.push("popstate"));
    window.addEventListener("hashchange", () => events.push("hashchange"));
  });
  await frame.locator("#top-link").click();
  await frame.locator("#blocked-link").click();
  await frame.locator("#blocked-form button").click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { contractNavigations?: unknown[] }).contractNavigations
            ?.length ?? 0,
      ),
    )
    .toBe(3);
  expect(
    await page.evaluate(
      () =>
        (
          window as Window &
            typeof globalThis & {
              contractNavigations: Array<{
                kind: string;
                to: string;
                cancelable: boolean;
              }>;
            }
        ).contractNavigations,
    ),
  ).toEqual([
    {
      kind: "fragment",
      to: `${fixture.origin}/documents/history.html#`,
      cancelable: true,
    },
    {
      kind: "link",
      to: `${fixture.origin}/documents/blocked-link.html`,
      cancelable: true,
    },
    {
      kind: "form",
      to: `${fixture.origin}/documents/blocked-form.html?query=fixture`,
      cancelable: true,
    },
  ]);
  expect(
    await childValue(
      frame,
      (window) =>
        (window as Window & typeof globalThis & { __canceledFragmentEvents: string[] })
          .__canceledFragmentEvents,
    ),
  ).toEqual([]);
  expect(
    await frame.evaluate(
      (element: HTMLElement & { currentURL: string | null }) => element.currentURL,
    ),
  ).toBe(before);
  expect(
    await page.evaluate(() => ({
      href: location.href,
      length: history.length,
      state: history.state,
    })),
  ).toEqual(hostHistory);
});

test("loads an allowed same-context link inside the guest", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(
    page,
    "staged-navigation",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as HTMLElement & { status: string }).status),
    )
    .toBe("ready");
  await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow;
    const link = child?.document.createElement("a");
    if (child === null || child === undefined || link === undefined) {
      throw new Error("The staged-navigation frame has no child window");
    }
    link.id = "slow-document-link";
    link.href = "/documents/slow.html";
    link.textContent = "Slow document";
    child.document.body.append(link);
  });

  await frame.locator("#slow-document-link").click();
  await expect(frame.locator("#slow-copy")).toHaveText("Slow document");
  await expect
    .poll(() =>
      frame.evaluate(
        (element) => (element as HTMLElement & { currentURL: string | null }).currentURL,
      ),
    )
    .toBe(`${fixture.origin}/documents/slow.html`);
  expect(page.url()).toBe(`${fixture.origin}/`);
});

test("gates modified primary and middle link activations before opening a new context", async ({
  page,
}) => {
  await installBundle(page);
  const frame = await mountFrame(
    page,
    "new-context-navigation",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  const hostURL = page.url();
  await frame.evaluate((element) => {
    const controlledFrame = element as HTMLElement & {
      allowNavigation: boolean;
      navigations: Array<{ kind: string; to: string; cancelable: boolean }>;
    };
    controlledFrame.allowNavigation = false;
    controlledFrame.navigations = [];
    element.addEventListener("v-frame-navigate", (event) => {
      const navigationEvent = event as CustomEvent<{ kind: string; to: string }>;
      controlledFrame.navigations.push({
        kind: navigationEvent.detail.kind,
        to: navigationEvent.detail.to,
        cancelable: event.cancelable,
      });
      if (!controlledFrame.allowNavigation) {
        event.preventDefault();
      }
    });
  });

  const openedPages: import("@playwright/test").Page[] = [];
  page.context().on("page", (openedPage) => openedPages.push(openedPage));
  const link = frame.locator("#new-context-link");

  await link.click({ modifiers: ["Shift"] });
  await expect
    .poll(() =>
      frame.evaluate(
        (element) =>
          (element as HTMLElement & { navigations: unknown[] }).navigations.length,
      ),
    )
    .toBe(1);
  await page.waitForTimeout(50);
  expect(openedPages).toHaveLength(0);

  await frame.evaluate((element) => {
    (element as HTMLElement & { allowNavigation: boolean }).allowNavigation = true;
  });
  const modifiedPagePromise = page.context().waitForEvent("page");
  await link.click({ modifiers: ["Control"] });
  const modifiedPage = await modifiedPagePromise;
  await expect
    .poll(() => modifiedPage.url())
    .toBe(`${fixture.origin}/documents/new-context.html`);
  await modifiedPage.close();

  await frame.evaluate((element) => {
    (element as HTMLElement & { allowNavigation: boolean }).allowNavigation = false;
  });
  await link.click({ button: "middle" });
  await expect
    .poll(() =>
      frame.evaluate(
        (element) =>
          (element as HTMLElement & { navigations: unknown[] }).navigations.length,
      ),
    )
    .toBe(3);
  await page.waitForTimeout(50);
  expect(openedPages).toHaveLength(1);

  await frame.evaluate((element) => {
    (element as HTMLElement & { allowNavigation: boolean }).allowNavigation = true;
  });
  const middlePagePromise = page.context().waitForEvent("page");
  await link.click({ button: "middle" });
  const middlePage = await middlePagePromise;
  await expect
    .poll(() => middlePage.url())
    .toBe(`${fixture.origin}/documents/new-context.html`);
  await middlePage.close();

  expect(
    await frame.evaluate(
      (element) =>
        (
          element as HTMLElement & {
            navigations: Array<{ kind: string; to: string; cancelable: boolean }>;
          }
        ).navigations,
    ),
  ).toEqual(
    Array.from({ length: 4 }, () => ({
      kind: "link",
      to: `${fixture.origin}/documents/new-context.html`,
      cancelable: true,
    })),
  );
  expect(openedPages).toHaveLength(2);
  expect(
    await frame.evaluate(
      (element: HTMLElement & { currentURL: string | null }) => element.currentURL,
    ),
  ).toBe(`${fixture.origin}/documents/history.html`);
  expect(page.url()).toBe(hostURL);
});

test("uses submitter overrides and replacement query data for gated GET form windows", async ({
  page,
}) => {
  await installBundle(page);
  const frame = await mountFrame(
    page,
    "submitter-navigation",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  await frame.evaluate((element) => {
    const controlledFrame = element as HTMLElement & {
      allowNavigation: boolean;
      navigations: Array<{ from: string; to: string; kind: string; state: unknown }>;
    };
    controlledFrame.allowNavigation = false;
    controlledFrame.navigations = [];
    element.addEventListener("v-frame-navigate", (event) => {
      controlledFrame.navigations.push(
        (event as CustomEvent<{ from: string; to: string; kind: string; state: unknown }>)
          .detail,
      );
      if (!controlledFrame.allowNavigation) {
        event.preventDefault();
      }
    });
  });
  await frame.locator("#form-file").setInputFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("report"),
  });

  const openedPages: import("@playwright/test").Page[] = [];
  page.context().on("page", (openedPage) => openedPages.push(openedPage));
  await frame.locator("#override-submit").click();
  await expect
    .poll(() =>
      frame.evaluate(
        (element) =>
          (element as HTMLElement & { navigations: unknown[] }).navigations.length,
      ),
    )
    .toBe(1);
  await page.waitForTimeout(50);
  expect(openedPages).toHaveLength(0);

  await frame.evaluate((element) => {
    (element as HTMLElement & { allowNavigation: boolean }).allowNavigation = true;
  });
  const formPagePromise = page.context().waitForEvent("page");
  await frame.locator("#override-submit").click();
  const formPage = await formPagePromise;
  const expectedURL = `${fixture.origin}/documents/override-form.html?query=fixture&upload=report.txt&submitter=override`;
  await expect.poll(() => formPage.url()).toBe(expectedURL);
  await formPage.close();

  expect(
    await frame.evaluate(
      (element) =>
        (
          element as HTMLElement & {
            navigations: Array<{
              from: string;
              to: string;
              kind: string;
              state: unknown;
            }>;
          }
        ).navigations,
    ),
  ).toEqual(
    Array.from({ length: 2 }, () => ({
      from: `${fixture.origin}/documents/history.html`,
      to: expectedURL,
      kind: "form",
      state: null,
    })),
  );
  expect(openedPages).toHaveLength(1);
  expect(
    await frame.evaluate(
      (element: HTMLElement & { currentURL: string | null }) => element.currentURL,
    ),
  ).toBe(`${fixture.origin}/documents/history.html`);
});

test("uses the page viewport and frame scroll state then stops child timers when disposed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await installBundle(page);
  const frame = await mountFrame(
    page,
    "viewport",
    `${fixture.origin}/documents/viewport.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  await frame.evaluate((element) => {
    element.setAttribute("style", "width: 320px; height: 120px;");
    element.scrollTop = 40;
  });
  const resizeEventsBeforePageResize = await childValue(
    frame,
    (window) =>
      (window as Window & typeof globalThis & { __viewportEvents: { resize: number } })
        .__viewportEvents.resize,
  );
  await page.setViewportSize({ width: 760, height: 520 });
  await expect
    .poll(() =>
      childValue(
        frame,
        (window) =>
          (
            window as Window &
              typeof globalThis & { __viewportEvents: { resize: number } }
          ).__viewportEvents.resize,
      ),
    )
    .toBeGreaterThan(resizeEventsBeforePageResize);
  await expect
    .poll(() =>
      childValue(
        frame,
        (window) =>
          (
            window as Window &
              typeof globalThis & { __viewportEvents: { scroll: number } }
          ).__viewportEvents.scroll,
      ),
    )
    .toBeGreaterThan(0);
  expect(await childValue(frame, (window) => window.scrollY)).toBe(40);
  const childViewport = await childValue(frame, (window) => ({
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    outerHeight: window.outerHeight,
    outerWidth: window.outerWidth,
    visualHeight: window.visualViewport?.height ?? null,
    visualWidth: window.visualViewport?.width ?? null,
    widthMediaMatches: window.matchMedia(`(width: ${window.innerWidth}px)`).matches,
  }));
  const pageViewport = await page.evaluate(() => ({
    innerHeight: window.innerHeight,
    innerWidth: window.innerWidth,
    outerHeight: window.outerHeight,
    outerWidth: window.outerWidth,
    visualHeight: window.visualViewport?.height ?? null,
    visualWidth: window.visualViewport?.width ?? null,
    widthMediaMatches: window.matchMedia(`(width: ${window.innerWidth}px)`).matches,
  }));
  expect(childViewport).toEqual(pageViewport);
  expect(childViewport.innerWidth).not.toBe(320);
  await expect
    .poll(() =>
      childValue(
        frame,
        (window) =>
          (window as Window & typeof globalThis & { __viewportEvents: { ticks: number } })
            .__viewportEvents.ticks,
      ),
    )
    .toBeGreaterThan(2);

  const teardown = await page.evaluate(async () => {
    const frame = document.querySelector("#viewport") as HTMLElement & {
      contentWindow:
        | (Window & { __viewportEvents: { scroll: number; ticks: number } })
        | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("Viewport fixture did not expose a child window");
    }
    frame.remove();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const stoppedAt = child.__viewportEvents.ticks;
    const scrollAtRemoval = child.__viewportEvents.scroll;
    frame.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      stoppedAt,
      afterWait: child.__viewportEvents.ticks,
      scrollAtRemoval,
      scrollAfterHostEvent: child.__viewportEvents.scroll,
      hasContentWindow: frame.contentWindow !== null,
    };
  });

  expect(teardown).toEqual({
    stoppedAt: teardown.stoppedAt,
    afterWait: teardown.stoppedAt,
    scrollAtRemoval: teardown.scrollAtRemoval,
    scrollAfterHostEvent: teardown.scrollAtRemoval,
    hasContentWindow: false,
  });
});

test("uses the virtual document element as the scrolling element", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(
    page,
    "viewport-scroll",
    `${fixture.origin}/documents/viewport.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  await frame.evaluate((element) => element.setAttribute("style", "height: 100px;"));
  const scrollingElement = await childValue(frame, (window) => ({
    isDocumentElement:
      window.document.scrollingElement === window.document.documentElement,
    isBody: window.document.scrollingElement === window.document.body,
    tagName: window.document.scrollingElement?.tagName,
  }));
  expect(scrollingElement).toEqual({
    isDocumentElement: true,
    isBody: false,
    tagName: "V-HTML",
  });

  await childValue(frame, (window) => window.scrollTo({ top: 30, left: 0 }));
  await expect.poll(() => frame.evaluate((element) => element.scrollTop)).toBe(30);
  await childValue(frame, (window) => window.scrollBy({ top: 20, left: 0 }));
  await expect.poll(() => frame.evaluate((element) => element.scrollTop)).toBe(50);
});

test("emits bubbling composed lifecycle details and a fatal entry error", async ({
  page,
}) => {
  await installBundle(page);

  const events = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame");
    const lifecycle: Array<{
      type: string;
      bubbles: boolean;
      composed: boolean;
      cancelable: boolean;
      url: string;
    }> = [];
    for (const type of ["v-frame-loadstart", "v-frame-load"]) {
      frame.addEventListener(type, (event) => {
        lifecycle.push({
          type,
          bubbles: event.bubbles,
          composed: event.composed,
          cancelable: event.cancelable,
          url: (event as CustomEvent<{ url: string }>).detail.url,
        });
      });
    }
    const loaded = new Promise<void>((resolve) =>
      frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    frame.setAttribute("src", `${origin}/documents/redirect.html`);
    document.querySelector("#host")?.append(frame);
    await loaded;

    const invalid = document.createElement("v-frame") as HTMLElement & { status: string };
    const failed = new Promise<{
      phase: string;
      fatal: boolean;
      bubbles: boolean;
      composed: boolean;
      cancelable: boolean;
    }>((resolve) => {
      invalid.addEventListener(
        "v-frame-error",
        (event) => {
          const detail = (event as CustomEvent<{ phase: string; fatal: boolean }>).detail;
          resolve({
            phase: detail.phase,
            fatal: detail.fatal,
            bubbles: event.bubbles,
            composed: event.composed,
            cancelable: event.cancelable,
          });
        },
        { once: true },
      );
    });
    invalid.setAttribute("src", "data:text/html,unsupported");
    document.querySelector("#host")?.append(invalid);
    return { lifecycle, failure: await failed, invalidStatus: invalid.status };
  }, fixture.origin);

  expect(events).toEqual({
    lifecycle: [
      {
        type: "v-frame-loadstart",
        bubbles: true,
        composed: true,
        cancelable: false,
        url: `${fixture.origin}/documents/redirect.html`,
      },
      {
        type: "v-frame-load",
        bubbles: true,
        composed: true,
        cancelable: false,
        url: `${fixture.origin}/documents/redirected.html`,
      },
    ],
    failure: {
      phase: "entry",
      fatal: true,
      bubbles: true,
      composed: true,
      cancelable: false,
    },
    invalidStatus: "error",
  });
});

test("closes dialog form submissions natively without emitting navigation", async ({
  page,
}) => {
  await installBundle(page);
  const frame = await mountFrame(
    page,
    "dialog-form",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  await frame.evaluate((element) => {
    (element as HTMLElement & { navigationKinds?: string[] }).navigationKinds = [];
    element.addEventListener("v-frame-navigate", (event) => {
      (element as HTMLElement & { navigationKinds: string[] }).navigationKinds.push(
        (event as CustomEvent<{ kind: string }>).detail.kind,
      );
    });
  });

  const state = await childValue(frame, async (window) => {
    const document = window.document;
    const dialog = document.createElement("dialog");
    const form = document.createElement("form");
    form.setAttribute("method", "dialog");
    const button = document.createElement("button");
    button.value = "confirmed";
    form.append(button);
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    const openBefore = dialog.open;
    button.click();
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    return { openBefore, openAfter: dialog.open, returnValue: dialog.returnValue };
  });

  expect(state).toEqual({ openBefore: true, openAfter: false, returnValue: "confirmed" });
  expect(
    await frame.evaluate(
      (element) =>
        (element as HTMLElement & { navigationKinds: string[] }).navigationKinds,
    ),
  ).toEqual([]);
});

test("replaces the history entry when a fragment link targets the current URL", async ({
  page,
}) => {
  await installBundle(page);
  const frame = await mountFrame(
    page,
    "repeat-fragment",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  await frame.evaluate((element) => {
    (element as HTMLElement & { navigationKinds?: string[] }).navigationKinds = [];
    element.addEventListener("v-frame-navigate", (event) => {
      (element as HTMLElement & { navigationKinds: string[] }).navigationKinds.push(
        (event as CustomEvent<{ kind: string }>).detail.kind,
      );
    });
  });
  const historyLength = () => childValue(frame, (window) => window.history.length);
  const recordedKinds = () =>
    frame.evaluate(
      (element) =>
        (element as HTMLElement & { navigationKinds: string[] }).navigationKinds.length,
    );

  const initialLength = await historyLength();
  await frame.locator("#top-link").click();
  await expect.poll(recordedKinds).toBe(1);
  const afterFirst = await historyLength();

  await frame.locator("#top-link").click();
  await frame.locator("#top-link").click();
  await expect.poll(recordedKinds).toBe(3);

  expect(afterFirst).toBe(initialLength + 1);
  expect(await historyLength()).toBe(afterFirst);
});
