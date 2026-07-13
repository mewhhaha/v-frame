import { expect, test } from "@playwright/test";
import { startFixtureServer, type FixtureServer } from "./support/fixture-server";

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
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

async function mountFrame(
  page: import("@playwright/test").Page,
  id: string,
  credentials: "omit" | "same-origin",
) {
  await page.evaluate(({ frameID, frameSource, frameCredentials }) => {
    const frame = document.createElement("v-frame");
    frame.id = frameID;
    frame.setAttribute("credentials", frameCredentials);
    frame.setAttribute("src", frameSource);
    document.querySelector("#host")?.append(frame);
  }, {
    frameID: id,
    frameSource: `${fixture.origin}/documents/first.html`,
    frameCredentials: credentials,
  });
  const frame = page.locator(`v-frame#${id}`);
  await expect.poll(() => frame.evaluate((element) => (element as { status: string }).status)).toBe("ready");
  return frame;
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

test("preserves native missing network argument errors without issuing requests", async ({ page }) => {
  await installBundle(page);

  for (const credentials of ["omit", "same-origin"] as const) {
    const frame = await mountFrame(page, `required-${credentials}`, credentials);
    const requestsBefore = fixture.requests.length;
    const result = await childValue(frame, async (window) => {
      const exception = (operation: () => unknown) => {
        try {
          operation();
          return null;
        } catch (error) {
          return {
            name: (error as Error).name,
            isRealmTypeError: error instanceof window.TypeError,
          };
        }
      };
      const asynchronousException = async (operation: () => Promise<unknown>) => {
        try {
          await operation();
          return null;
        } catch (error) {
          return {
            name: (error as Error).name,
            isRealmTypeError: error instanceof window.TypeError,
          };
        }
      };
      const omittedOpen = async (argumentsList: unknown[]) => {
        const xhr = new window.XMLHttpRequest();
        const error = exception(() => Reflect.apply(xhr.open, xhr, argumentsList));
        if (error !== null) {
          return error;
        }
        await new Promise<void>((resolve) => {
          xhr.addEventListener("loadend", () => resolve(), { once: true });
          xhr.send();
        });
        return null;
      };
      const omittedConstructor = (
        constructor: typeof window.WebSocket | typeof window.EventSource | typeof window.Worker | typeof window.SharedWorker,
        dispose: (connection: WebSocket | EventSource | Worker | SharedWorker) => void,
      ) => exception(() => {
        const connection = Reflect.construct(constructor, []);
        dispose(connection as WebSocket | EventSource | Worker | SharedWorker);
      });

      return {
        request: exception(() => Reflect.construct(window.Request, [])),
        fetch: await asynchronousException(() => Reflect.apply(window.fetch, window, [])),
        xhr: await Promise.all([omittedOpen([]), omittedOpen(["GET"])]),
        webSocket: omittedConstructor(window.WebSocket, (connection) => (connection as WebSocket).close()),
        eventSource: omittedConstructor(window.EventSource, (connection) => (connection as EventSource).close()),
        worker: omittedConstructor(window.Worker, (connection) => (connection as Worker).terminate()),
        sharedWorker: omittedConstructor(window.SharedWorker, (connection) => (connection as SharedWorker).port.close()),
        sendBeacon: exception(() => Reflect.apply(window.navigator.sendBeacon, window.navigator, [])),
      };
    });

    expect(result).toEqual({
      request: { name: "TypeError", isRealmTypeError: true },
      fetch: { name: "TypeError", isRealmTypeError: true },
      xhr: [
        { name: "TypeError", isRealmTypeError: true },
        { name: "TypeError", isRealmTypeError: true },
      ],
      webSocket: { name: "TypeError", isRealmTypeError: true },
      eventSource: { name: "TypeError", isRealmTypeError: true },
      worker: { name: "TypeError", isRealmTypeError: true },
      sharedWorker: { name: "TypeError", isRealmTypeError: true },
      sendBeacon: { name: "TypeError", isRealmTypeError: true },
    });

    await page.waitForTimeout(100);
    expect(fixture.requests.slice(requestsBefore)).toEqual([]);

    const explicitURLs = await childValue(frame, async (window) => {
      const xhr = (input: unknown) => new Promise<string>((resolve) => {
        const request = new window.XMLHttpRequest();
        request.addEventListener("loadend", () => resolve(request.responseURL), { once: true });
        Reflect.apply(request.open, request, ["GET", input]);
        request.send();
      });

      return {
        request: [undefined, null].map((input) => (Reflect.construct(window.Request, [input]) as Request).url),
        fetch: await Promise.all([undefined, null].map(async (input) => {
          const response = await Reflect.apply(window.fetch, window, [input]);
          return response.url;
        })),
        xhr: await Promise.all([undefined, null].map(xhr)),
      };
    });
    expect(explicitURLs).toEqual({
      request: [
        `${fixture.origin}/documents/undefined`,
        `${fixture.origin}/documents/null`,
      ],
      fetch: [
        `${fixture.origin}/documents/undefined`,
        `${fixture.origin}/documents/null`,
      ],
      xhr: [
        `${fixture.origin}/documents/undefined`,
        `${fixture.origin}/documents/null`,
      ],
    });
  }
});
