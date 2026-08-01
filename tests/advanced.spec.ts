import { expect, test, type Locator, type Page } from "@playwright/test";
import { type FixtureServer, startFixtureServer } from "./support/fixture-server";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture.close();
});

function mountDocument(page: Page, path: string): Promise<Locator> {
  return mountFrame(page, { src: `${fixture.origin}${path}`, settle: "none" });
}

async function childValue<T>(
  frame: Locator,
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

test("executes an insertAdjacentElement script only in the child realm", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/dynamic-insert.html");

  await expect(frame.locator("#dynamic-insert-result")).toHaveText(
    "child realm executed",
  );
  expect(await page.evaluate(() => "__dynamicInsertRealm" in window)).toBe(false);
  expect(
    await childValue(frame, (window) => (window as any).__dynamicInsertRealm === window),
  ).toBe(true);
});

test("loads a network v-frame nested inside a child document", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const outerFrame = await mountDocument(page, "/documents/nested-network.html");
  const innerFrame = outerFrame.locator("#nested-network-frame");

  await expect
    .poll(() =>
      innerFrame.evaluate(
        (element) => (element as HTMLElement & { status: string }).status,
      ),
    )
    .toBe("ready");
  await expect(innerFrame.locator("#nested-network-copy")).toHaveText(
    "Nested network frame loaded",
  );
});

test("waits for an inline module top-level await before becoming ready", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/inline-module.html");

  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");
  await expect(frame.locator("#module-result")).toHaveText("module settled");
});

test("runs classic, deferred, and async scripts with their current script and ready state", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/script-order.html");

  // The async script is parked, so it lands after the deferred one because the test says
  // so rather than because a response delay outran the browser's scheduling.
  await expect
    .poll(() => childValue(frame, (window) => (window as any).__scriptEvents))
    .toEqual([
      "classic-inline:classic-inline:loading",
      "classic-external:classic-external:loading",
      "defer-external:deferred-external:interactive",
    ]);
  await fixture.releaseAsyncScript();

  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");
  await expect
    .poll(() => childValue(frame, (window) => (window as any).__scriptEvents))
    .toEqual([
      "classic-inline:classic-inline:loading",
      "classic-external:classic-external:loading",
      "defer-external:deferred-external:interactive",
      "async-external:async-external:interactive",
      "load:complete",
    ]);
});

test("preserves insertion order for dynamic external scripts with async false", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/dynamic-external-order.html");

  // The guarantee is insertion order despite arrival order, so the first script answers
  // only once the second one's response has already been written.
  await fixture.dynamicScriptOrder.secondServed;
  await fixture.dynamicScriptOrder.releaseFirst();

  await expect
    .poll(() => childValue(frame, (window) => (window as any).__dynamicExternalEvents))
    .toEqual(["first", "second"]);
});

test("applies imported supports rules and preserves root selector specificity", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/import-and-root.html");

  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");
  await expect(frame.locator("#root-colour")).toHaveCSS("color", "rgb(8, 9, 10)");
  await expect(frame.locator("#imported-colour")).toHaveCSS("color", "rgb(13, 14, 15)");
});

test("keeps the signal and credentials when a Request is constructed from another request", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/request-abort.html");

  await expect(frame.locator("#request-result")).toHaveText(
    "true:true:include:include:AbortError",
  );
});

test("updates document base URLs after pushState without an explicit base", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/base-after-push.html");

  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");
  expect(await childValue(frame, (window) => (window as any).__baseAfterPush)).toEqual({
    baseURI: `${fixture.origin}/documents/nested/state.html`,
    src: `${fixture.origin}/documents/nested/asset.png`,
  });
});

test("preserves an explicit base URL after pushState", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/explicit-base-after-push.html");

  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");
  expect(
    await childValue(frame, (window) => (window as any).__explicitBaseAfterPush),
  ).toEqual({
    baseURI: `${fixture.origin}/base-root/`,
    src: `${fixture.origin}/base-root/asset.png`,
  });
});

test("forwards bubbling child-realm scroll events from document to window", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/scroll-events.html");
  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");

  await childValue(frame, (window) => {
    const events: Array<{
      listener: string;
      childRealm: boolean;
      target: boolean;
      currentTarget: boolean;
      bubbles: boolean;
    }> = [];
    window.document.addEventListener("scroll", (event) => {
      events.push({
        listener: "document",
        childRealm: event instanceof window.Event,
        target: event.target === window.document,
        currentTarget: event.currentTarget === window.document,
        bubbles: event.bubbles,
      });
    });
    window.addEventListener("scroll", (event) => {
      events.push({
        listener: "window",
        childRealm: event instanceof window.Event,
        target: event.target === window.document,
        currentTarget: event.currentTarget === window,
        bubbles: event.bubbles,
      });
    });
    (
      window as Window & typeof globalThis & { __viewportScrollEvents: typeof events }
    ).__viewportScrollEvents = events;
  });
  await frame.evaluate((element) => {
    element.setAttribute("style", "height: 100px;");
    element.scrollTop = 40;
  });
  await expect
    .poll(() =>
      childValue(
        frame,
        (window) =>
          (window as Window & typeof globalThis & { __viewportScrollEvents: unknown[] })
            .__viewportScrollEvents,
      ),
    )
    .toEqual([
      {
        listener: "document",
        childRealm: true,
        target: true,
        currentTarget: true,
        bubbles: true,
      },
      {
        listener: "window",
        childRealm: true,
        target: true,
        currentTarget: true,
        bubbles: true,
      },
    ]);
});

test("reflects the nonce property and attribute", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/nonce.html`,
    nonce: "first-nonce",
    settle: "none",
  });

  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");
  await expect(frame).toHaveAttribute("nonce", "first-nonce");
  expect(await frame.evaluate((element) => (element as HTMLScriptElement).nonce)).toBe(
    "first-nonce",
  );
  await frame.evaluate((element) => element.setAttribute("nonce", "second-nonce"));
  expect(await frame.evaluate((element) => (element as HTMLScriptElement).nonce)).toBe(
    "second-nonce",
  );
});

test("stops virtual history when navigation approval removes the frame", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/application.html");
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as HTMLElement & { status: string }).status),
    )
    .toBe("ready");

  const result = await frame.evaluate((element) => {
    const controlledFrame = element as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
      currentURL: string | null;
      status: string;
    };
    const child = controlledFrame.contentWindow;
    if (child === null) {
      throw new Error("The loaded frame did not expose a child window");
    }

    const retainedHistory = child.history;
    const navigate = child.open.bind(child);
    const initialHistoryLength = retainedHistory.length;
    const hostStyleSheet = new CSSStyleSheet();
    hostStyleSheet.replaceSync(":host { --retained-host-style: yes; }");
    const shadowRoot = controlledFrame.shadowRoot;
    if (shadowRoot === null) {
      throw new Error("The v-frame did not expose its shadow root");
    }
    shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, hostStyleSheet];

    let navigationCount = 0;
    let errorCount = 0;
    controlledFrame.addEventListener("v-frame-navigate", () => {
      navigationCount += 1;
      controlledFrame.remove();
    });
    controlledFrame.addEventListener("v-frame-error", () => {
      errorCount += 1;
    });

    let firstException: string | null = null;
    try {
      navigate("removed-state.html", "_self");
    } catch (error) {
      firstException = String(error);
    }

    let retainedException: string | null = null;
    try {
      retainedHistory.pushState({ attempt: 2 }, "", "http://[");
      retainedHistory.replaceState({ attempt: 3 }, "", "http://[");
    } catch (error) {
      retainedException = String(error);
    }

    return {
      firstException,
      retainedException,
      navigationCount,
      errorCount,
      historyLength: retainedHistory.length,
      initialHistoryLength,
      retainedHostStyle: shadowRoot.adoptedStyleSheets.includes(hostStyleSheet),
      status: controlledFrame.status,
      currentURL: controlledFrame.currentURL,
      hasContentWindow: controlledFrame.contentWindow !== null,
    };
  });

  expect(result).toEqual({
    firstException: null,
    retainedException: null,
    navigationCount: 1,
    errorCount: 0,
    historyLength: 1,
    initialHistoryLength: 1,
    retainedHostStyle: true,
    status: "idle",
    currentURL: null,
    hasContentWindow: false,
  });
});

test("stops old virtual history when navigation approval reloads the frame", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/application.html");
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as HTMLElement & { status: string }).status),
    )
    .toBe("ready");

  const result = await frame.evaluate(async (element) => {
    const controlledFrame = element as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
      currentURL: string | null;
      reload(): Promise<void>;
      status: string;
    };
    const previousWindow = controlledFrame.contentWindow;
    if (previousWindow === null) {
      throw new Error("The loaded frame did not expose a child window");
    }

    const retainedHistory = previousWindow.history;
    const initialHistoryLength = retainedHistory.length;
    let reload: Promise<void> | null = null;
    let navigationCount = 0;
    let errorCount = 0;
    controlledFrame.addEventListener("v-frame-navigate", () => {
      navigationCount += 1;
      reload ??= controlledFrame.reload();
    });
    controlledFrame.addEventListener("v-frame-error", () => {
      errorCount += 1;
    });

    let firstException: string | null = null;
    try {
      retainedHistory.pushState({ attempt: 1 }, "", "reloaded-state.html");
    } catch (error) {
      firstException = String(error);
    }
    if (reload === null) {
      throw new Error("The navigation event did not start a reload");
    }

    let reloadException: string | null = null;
    try {
      await reload;
    } catch (error) {
      reloadException = String(error);
    }

    let retainedException: string | null = null;
    try {
      retainedHistory.pushState({ attempt: 2 }, "", "http://[");
      retainedHistory.replaceState({ attempt: 3 }, "", "http://[");
    } catch (error) {
      retainedException = String(error);
    }

    return {
      firstException,
      reloadException,
      retainedException,
      navigationCount,
      errorCount,
      historyLength: retainedHistory.length,
      initialHistoryLength,
      recreatedWindow: controlledFrame.contentWindow !== previousWindow,
      status: controlledFrame.status,
      currentURL: controlledFrame.currentURL,
    };
  });

  expect(result).toEqual({
    firstException: null,
    reloadException: null,
    retainedException: null,
    navigationCount: 1,
    errorCount: 0,
    historyLength: 1,
    initialHistoryLength: 1,
    recreatedWindow: true,
    status: "ready",
    currentURL: `${fixture.origin}/documents/application.html`,
  });
});

test("disposes retained virtual history when realm bootstrap fails", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const failure = await page.evaluate(async (origin) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
      currentURL: string | null;
      reload(): Promise<void>;
      src: string;
      status: string;
    };
    const retained: { history: History | null } = { history: null };
    let navigationCount = 0;
    const failures: Array<{ phase: string; fatal: boolean }> = [];
    const realmObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const addedNode of record.addedNodes) {
          if (addedNode instanceof HTMLIFrameElement) {
            retained.history = addedNode.contentWindow?.history ?? null;
          }
        }
      }
    });
    realmObserver.observe(frame.shadowRoot!, { childList: true });
    frame.addEventListener("v-frame-navigate", () => {
      navigationCount += 1;
    });
    const bootstrapFailure = new Promise<void>((resolve) => {
      frame.addEventListener("v-frame-error", (event) => {
        const detail = (event as CustomEvent<{ phase: string; fatal: boolean }>).detail;
        failures.push({ phase: detail.phase, fatal: detail.fatal });
        if (detail.phase === "bootstrap" && detail.fatal) {
          resolve();
        }
      });
    });

    const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, "matchMedia");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: undefined,
    });

    let reloadRejection: string | null = null;
    try {
      frame.src = `${origin}/documents/application.html`;
      document.querySelector("#host")?.append(frame);
      const reload = frame.reload();
      await bootstrapFailure;
      reloadRejection = await reload.then(
        () => null,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      if (matchMediaDescriptor === undefined) {
        delete (window as unknown as { matchMedia?: typeof matchMedia }).matchMedia;
      } else {
        Object.defineProperty(window, "matchMedia", matchMediaDescriptor);
      }
      realmObserver.disconnect();
    }

    if (retained.history === null) {
      throw new Error("The bootstrap failure did not expose its child history");
    }
    let retainedException: string | null = null;
    try {
      retained.history.pushState({ attempt: 1 }, "", "http://[");
      retained.history.replaceState({ attempt: 2 }, "", "http://[");
    } catch (error) {
      retainedException = String(error);
    }

    return {
      failures,
      navigationCount,
      reloadRejection,
      retainedException,
      status: frame.status,
      currentURL: frame.currentURL,
      hasContentWindow: frame.contentWindow !== null,
    };
  }, fixture.origin);

  expect(failure).toEqual({
    failures: [{ phase: "bootstrap", fatal: true }],
    navigationCount: 0,
    reloadRejection: "v-frame requires a host window with matchMedia support",
    retainedException: null,
    status: "error",
    currentURL: null,
    hasContentWindow: false,
  });
});
