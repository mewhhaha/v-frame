import { expect, test } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: HTTPFixture;

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/documents/blank.html": htmlDocument("<main>Guest</main>"),
      "/documents/bootstrap.html": htmlDocument(`
        <script>window.__emptyEvents = [];</script>
        <script src="" onerror="window.__emptyEvents.push('initial-error')">window.__emptyEvents.push('wrong-inline')</script>
        <script>
          window.__emptyEvents.push('following-inline');
          const empty = document.createElement('script');
          empty.src = '';
          document.head.append(empty);
          empty.addEventListener('error', () => window.__emptyEvents.push('dynamic-error'));
          window.__emptyEvents.push('after-append');
          Promise.resolve().then(() => window.__emptyEvents.push('microtask'));
          window.addEventListener('load', () => window.__emptyEvents.push('load'));
        </script>
      `),
      "/documents/cancel-bootstrap.html": htmlDocument(`
        <script>document.body.dataset.errors = '0';</script>
        <script src="" onerror="document.body.dataset.errors = String(Number(document.body.dataset.errors) + 1)"></script>
        <script src="" onerror="document.body.dataset.errors = String(Number(document.body.dataset.errors) + 1)"></script>
      `),
    },
  });
});

test.afterAll(async () => {
  await fixture.close();
});

for (const category of ["classic", "module"]) {
  test(`queues dynamic empty ${category} errors after append and microtasks`, async ({
    page,
    browserName,
  }) => {
    await installBundle(page, fixture.origin);
    await mountFrame(page, {
      src: fixture.origin + "/documents/blank.html",
      id: "frame",
    });
    const result = await page.evaluate(async (category) => {
      const frame = document.querySelector<VFrameElement>("#frame")!;
      const child = frame.contentWindow! as Window & typeof globalThis;
      const failures: Array<{ phase: string; fatal: boolean }> = [];
      frame.addEventListener("v-frame-error", (event) => {
        failures.push({ phase: event.detail.phase, fatal: event.detail.fatal });
      });
      async function exercise(view: Window & typeof globalThis) {
        const events: string[] = [];
        const script = view.document.createElement("script");
        if (category === "module") script.type = "module";
        script.src = "";
        script.text = "window.__unexpectedEmptyExecution = true";
        script.addEventListener("error", () => events.push("error"));
        view.document.head.append(script);
        events.push("append");
        script.addEventListener("error", () => events.push("late-listener"));
        script.onerror = () => events.push("late-handler");
        const failed = new Promise<void>((resolve) => {
          script.addEventListener("error", () => resolve(), { once: true });
        });
        await Promise.resolve().then(() => events.push("microtask"));
        await Promise.race([
          failed,
          new Promise<void>((resolve) => setTimeout(resolve, 100)),
        ]);
        script.remove();
        return {
          events,
          executed:
            (view as Window & { __unexpectedEmptyExecution?: boolean })
              .__unexpectedEmptyExecution === true,
        };
      }
      return {
        native: await exercise(window),
        virtual: await exercise(child),
        failures,
        status: frame.status,
      };
    }, category);
    const queued = {
      events: ["append", "microtask", "error", "late-listener", "late-handler"],
      executed: false,
    };
    // WebKit reports an empty module source synchronously; guest source
    // failures stay queued, as native classics and other engines' modules do.
    expect(result.native).toEqual(
      category === "module" && browserName === "webkit"
        ? { events: ["error", "append", "microtask"], executed: false }
        : queued,
    );
    expect(result.virtual).toEqual(queued);
    expect(result.failures).toEqual([{ phase: "script", fatal: false }]);
    expect(result.status).toBe("ready");
  });
}

test("cancels pending bootstrap errors when an error handler removes the frame", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const result = await page.evaluate(async (source) => {
    const frame = document.createElement("v-frame") as VFrameElement;
    const events: string[] = [];
    let body: HTMLElement | null = null;
    const removed = new Promise<void>((resolve) => {
      frame.addEventListener("v-frame-error", () => {
        events.push("frame-error");
        body = frame.shadowRoot!.querySelector<HTMLElement>("v-body");
        frame.remove();
        resolve();
      });
    });
    frame.addEventListener("v-frame-load", () => events.push("frame-load"));
    frame.src = source;
    document.querySelector("#host")!.append(frame);
    await removed;
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { events, errors: body!.dataset.errors, status: frame.status };
  }, fixture.origin + "/documents/cancel-bootstrap.html");
  expect(result).toEqual({ events: ["frame-error"], errors: "1", status: "idle" });
});

test("continues inline bootstrap before queued errors and settles them before frame load", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const result = await page.evaluate(async (source) => {
    const frame = document.createElement("v-frame") as VFrameElement;
    const failures: Array<{ phase: string; fatal: boolean }> = [];
    frame.addEventListener("v-frame-error", (event) => {
      failures.push({ phase: event.detail.phase, fatal: event.detail.fatal });
    });
    const loaded = new Promise<void>((resolve) =>
      frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    frame.src = source;
    document.querySelector("#host")!.append(frame);
    await loaded;
    return {
      events: (frame.contentWindow as Window & { __emptyEvents: string[] }).__emptyEvents,
      failures,
      status: frame.status,
    };
  }, fixture.origin + "/documents/bootstrap.html");
  expect(result).toEqual({
    events: [
      "following-inline",
      "after-append",
      "microtask",
      "initial-error",
      "dynamic-error",
      "load",
    ],
    failures: [
      { phase: "script", fatal: false },
      { phase: "script", fatal: false },
    ],
    status: "ready",
  });
});

for (const teardown of ["remove", "clear"] as const) {
  test(`cancels queued empty-source errors on ${teardown}`, async ({ page }) => {
    await installBundle(page, fixture.origin);
    await mountFrame(page, {
      src: fixture.origin + "/documents/blank.html",
      id: "frame",
    });
    const result = await page.evaluate(async (teardown) => {
      const frame = document.querySelector<VFrameElement>("#frame")!;
      const child = frame.contentWindow!;
      const events: string[] = [];
      frame.addEventListener("v-frame-error", () => events.push("frame-error"));
      for (const category of ["classic", "module"]) {
        const script = child.document.createElement("script");
        if (category === "module") script.type = "module";
        script.src = "";
        script.addEventListener("error", () => events.push(category));
        child.document.head.append(script);
      }
      if (teardown === "remove") {
        frame.remove();
      } else {
        frame.src = "";
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { events, status: frame.status };
    }, teardown);
    expect(result).toEqual({
      events: [],
      status: "idle",
    });
  });
}

test("delivers the live guest's queued errors while a src replacement is loading", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: fixture.origin + "/documents/blank.html",
  });
  let release: (() => Promise<void>) | undefined;
  await page.route("**/blank.html?replacement", (route) => {
    release = () => route.continue();
  });
  const child = await frame.evaluateHandle((element: VFrameElement) => {
    const child = element.contentWindow as Window & { errors: string[] };
    child.errors = [];
    for (const category of ["classic", "module"]) {
      const script = child.document.createElement("script");
      if (category === "module") script.type = "module";
      script.src = "";
      script.addEventListener("error", () => child.errors.push(category));
      child.document.head.append(script);
    }
    element.src += "?replacement";
    return child;
  });
  await expect.poll(() => !!release).toBe(true);
  await expect
    .poll(() => child.evaluate((child) => child.errors))
    .toEqual(["classic", "module"]);
  expect(
    await frame.evaluate(
      (element: VFrameElement, child) => element.contentWindow === child,
      child,
    ),
  ).toBe(true);
  await release!();
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  expect(
    await frame.evaluate(
      (element: VFrameElement, child) => element.contentWindow === child,
      child,
    ),
  ).toBe(false);
});
