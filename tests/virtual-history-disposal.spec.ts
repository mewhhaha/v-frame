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
      get() {
        // Capture the history after its facade has been installed. WebKit
        // replaces the initial srcdoc global during document.open(); observing
        // iframe insertion alone retains an unrelated, inactive native History.
        retained.history =
          frame.shadowRoot!.querySelector("iframe")?.contentWindow?.history ?? null;
        return undefined;
      },
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
