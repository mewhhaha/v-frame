import { expect, test, type Page } from "@playwright/test";
import {
  bundleRoute,
  htmlDocument,
  type HTTPFixture,
  parkRoute,
  type Route,
  startHTTPFixture,
} from "./support/http-fixture";
import { installBundle } from "./support/mount-frame";
import { flushTasks } from "./support/settle";

interface RecordedFailure {
  phase: string;
  url: string;
  message: string;
  fatal: boolean;
}

/**
 * The guest orders its scripts against one another, not against the clock. A script
 * that has to still be pending when something else happens parks at `hold(name)`, a
 * request the fixture keeps open until the test releases that gate; releasing it only
 * after the event under test makes "still pending" true by construction, where a timer
 * only made it likely.
 *
 * An inline module's failure is not reported while a sibling is pending, because the
 * runner cannot tell which module threw until the pending ones settle. So the test
 * cannot wait for the report before releasing the sibling. Instead the failing module
 * sends `signal(name)` just before it throws, in the same task, and the test waits for
 * that request with `reached(name)`.
 */
const gateNames = [
  "external-tla",
  "inline-failed",
  "inline-tla",
  "shared-a",
  "shared-b",
  "async-inline-a",
  "failure-a",
  "failure-a-thrown",
  "failure-b",
  "failure-b-thrown",
  "success",
  "overlap-tla",
  "overlap-failure",
  "overlap-failure-thrown",
  "ordered-first",
] as const;
type GateName = (typeof gateNames)[number];

const gates = Object.fromEntries(
  gateNames.map((name) => [name, parkRoute({ type: "text/plain", body: "open" })]),
) as Record<GateName, ReturnType<typeof parkRoute>>;

/** Module source that stays at this point until the test releases the gate. */
function hold(name: GateName): string {
  return `await fetch("/gates/${name}");`;
}

/** Module source that tells the test, without waiting, that the guest got this far. */
function signal(name: GateName): string {
  return `void fetch("/gates/${name}").catch(() => undefined);`;
}

/** Resolves once the guest has run the `signal(name)` source. */
function reached(name: GateName): Promise<void> {
  return gates[name].release();
}

const nonce = "script-concurrency-nonce";
let fixture: HTTPFixture;

function module(body: string): Route {
  return { type: "text/javascript", body };
}

function startFixtureServer(): Promise<HTTPFixture> {
  return startHTTPFixture({
    headers: {
      "content-security-policy": `script-src 'self' 'nonce-${nonce}'; object-src 'none'`,
    },
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      ...Object.fromEntries(
        gateNames.map((name) => [`/gates/${name}`, gates[name].route]),
      ),
      "/documents/inline-failure-external-success.html": htmlDocument(`
        <script type="module" async src="../modules/external-tla-success.js"></script>
        <script type="module">
          import "../modules/inline-failure-signal.js";
          import "../modules/inline-dependency-failure.js";
        </script>
      `),
      "/documents/external-failure-inline-success.html": htmlDocument(`
        <script type="module" async src="../modules/external-dependency-entry.js"></script>
        <script type="module">
          window.__inlineTlaStarted = true;
          ${hold("inline-tla")}
          window.__inlineTlaFulfilled = true;
        </script>
      `),
      "/documents/concurrent-external-failures.html": htmlDocument(`
        <script type="module" async src="../modules/shared-failure-a.js"></script>
        <script type="module" async src="../modules/shared-failure-b.js"></script>
        <script type="module">
          setTimeout(() => { throw new Error("unrelated runtime failure"); }, 0);
        </script>
      `),
      "/documents/async-inline-order.html": htmlDocument(`
        <script>window.__asyncInlineEvents = [];</script>
        <script type="module" async>
          window.__asyncInlineEvents.push("A-start");
          ${hold("async-inline-a")}
          window.__asyncInlineEvents.push("A-end");
        </script>
        <script type="module" async>
          window.__asyncInlineEvents.push("B");
        </script>
      `),
      "/documents/concurrent-inline-failures.html": htmlDocument(`
        <script>window.__concurrentInlineEvents = [];</script>
        <script type="module" async>
          window.__concurrentInlineEvents.push("failure-a-start");
          ${hold("failure-a")}
          ${signal("failure-a-thrown")}
          throw new Error("async inline failure A");
        </script>
        <script type="module" async>
          window.__concurrentInlineEvents.push("failure-b-start");
          ${hold("failure-b")}
          ${signal("failure-b-thrown")}
          throw new Error("async inline failure B");
        </script>
        <script type="module" async>
          window.__concurrentInlineEvents.push("success-start");
          ${hold("success")}
          window.__concurrentInlineEvents.push("success-end");
        </script>
      `),
      "/documents/external-and-concurrent-inline-failures.html": htmlDocument(`
        <script type="module" async src="../modules/external-dependency-entry.js"></script>
        <script type="module" async>
          window.__inlineTlaStarted = true;
          ${hold("overlap-tla")}
          window.__inlineTlaFulfilled = true;
        </script>
        <script type="module" async>
          ${hold("overlap-failure")}
          ${signal("overlap-failure-thrown")}
          throw new Error("concurrent inline failure");
        </script>
      `),
      "/documents/blank.html": htmlDocument("<main>blank</main>"),
      "/modules/external-tla-success.js": module(`
        window.__externalTlaStarted = true;
        ${hold("external-tla")}
        window.__externalTlaFulfilled = true;
      `),
      "/modules/inline-failure-signal.js": module(signal("inline-failed")),
      "/modules/inline-dependency-failure.js": module(
        'throw new Error("inline dependency failure");',
      ),
      "/modules/external-dependency-entry.js": module(
        'import "./external-dependency-failure.js";',
      ),
      // Yields until the inline module beside it has started, so the failure is
      // ordered after that start rather than racing it.
      "/modules/external-dependency-failure.js": module(`
        while (!window.__inlineTlaStarted) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        throw new Error("external dependency failure");
      `),
      "/modules/shared-failure-a.js": module(`
        ${hold("shared-a")}
        window.__sharedExternalFailure ??= new Error("shared external failure");
        throw window.__sharedExternalFailure;
      `),
      "/modules/shared-failure-b.js": module(`
        ${hold("shared-b")}
        window.__sharedExternalFailure ??= new Error("shared external failure");
        throw window.__sharedExternalFailure;
      `),
    },
  });
}

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterEach(() => {
  // A parked request keeps its socket open, which would otherwise stall the close of a
  // server whose test failed before releasing it.
  for (const name of gateNames) gates[name].abandon();
});

test.afterAll(async () => {
  await fixture.close();
});

type GuestWindow = Window & Record<string, unknown>;

interface FrameRun {
  frame: HTMLElement & { contentWindow: GuestWindow | null; status: string };
  failures: RecordedFailure[];
  loaded: boolean;
}

type RunWindow = Window & { __run?: FrameRun };

/**
 * Mounts a frame on `pathname` and returns once it is connected, without waiting for it
 * to load: the load waits on the scripts the test still holds at their gates. What the
 * frame reports is kept on `window.__run` for the helpers below to read back.
 */
async function startFrame(page: Page, pathname: string): Promise<void> {
  await page.evaluate(
    ({ frameNonce, source }) => {
      const frame = document.createElement("v-frame") as FrameRun["frame"];
      const run: FrameRun = { frame, failures: [], loaded: false };
      (window as RunWindow).__run = run;
      frame.setAttribute("nonce", frameNonce);
      frame.addEventListener("v-frame-error", (event) => {
        const detail = (
          event as CustomEvent<{
            phase: string;
            url: string;
            error: unknown;
            fatal: boolean;
          }>
        ).detail;
        const error = detail.error as { message?: unknown } | null;
        run.failures.push({
          phase: detail.phase,
          url: detail.url,
          message:
            typeof error?.message === "string" ? error.message : String(detail.error),
          fatal: detail.fatal,
        });
      });
      frame.addEventListener(
        "v-frame-load",
        () => {
          run.loaded = true;
        },
        { once: true },
      );
      frame.setAttribute("src", source);
      document.querySelector("#host")?.append(frame);
    },
    { frameNonce: nonce, source: `${fixture.origin}${pathname}` },
  );
}

/** Waits until the frame has reported at least `count` failures. */
async function waitForFailures(page: Page, count: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as RunWindow).__run?.failures.length ?? 0))
    .toBeGreaterThanOrEqual(count);
}

/** Waits for `v-frame-load` of the frame `startFrame` mounted. */
async function waitForLoad(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => (window as RunWindow).__run?.loaded), {
      message: "v-frame-load",
    })
    .toBe(true);
}

/** Reads an array the guest keeps on its window, undefined until it exists. */
function guestEvents(page: Page, key: string): Promise<string[] | undefined> {
  return page.evaluate(
    (name) =>
      (
        (window as RunWindow).__run?.frame.contentWindow as
          | (Window & Record<string, string[] | undefined>)
          | null
          | undefined
      )?.[name],
    key,
  );
}

/** Waits for the load, which comes once every held script has been released. */
async function finishFrame(page: Page): Promise<{
  failures: RecordedFailure[];
  status: string;
  childState: Record<string, boolean>;
}> {
  await waitForLoad(page);
  return page.evaluate(async () => {
    const { frame, failures } = (window as RunWindow).__run!;
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    const childWindow = frame.contentWindow;
    return {
      failures,
      status: frame.status,
      childState: {
        externalTlaFulfilled: childWindow?.__externalTlaFulfilled === true,
        inlineTlaFulfilled: childWindow?.__inlineTlaFulfilled === true,
      },
    };
  });
}

test("attributes an inline dependency failure while an async external module is pending", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const pathname = "/documents/inline-failure-external-success.html";
  await startFrame(page, pathname);
  // The inline module fails while the external one is held at its top-level await. Which
  // of the two threw cannot be told until the external module settles, so the failure
  // is reported only after the release below.
  await reached("inline-failed");
  await gates["external-tla"].release();
  const result = await finishFrame(page);

  expect(result).toEqual({
    failures: [
      {
        phase: "script",
        url: `${fixture.origin}${pathname}`,
        message: "inline dependency failure",
        fatal: false,
      },
    ],
    status: "ready",
    childState: {
      externalTlaFulfilled: true,
      inlineTlaFulfilled: false,
    },
  });
});

test("attributes an external dependency failure while an inline module has pending top-level await", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await startFrame(page, "/documents/external-failure-inline-success.html");
  // The inline module is held at its top-level await until the external failure is in.
  await waitForFailures(page, 1);
  await gates["inline-tla"].release();
  const result = await finishFrame(page);

  expect(result).toEqual({
    failures: [
      {
        phase: "script",
        url: `${fixture.origin}/modules/external-dependency-entry.js`,
        message: "external dependency failure",
        fatal: false,
      },
    ],
    status: "ready",
    childState: {
      externalTlaFulfilled: false,
      inlineTlaFulfilled: true,
    },
  });
});

test("reports two concurrent external failures and an unrelated runtime failure once each", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await startFrame(page, "/documents/concurrent-external-failures.html");
  // Both external modules are held, so the runtime failure arrives with both pending
  // and the two script failures then arrive in the order they are released.
  await waitForFailures(page, 1);
  await gates["shared-a"].release();
  await waitForFailures(page, 2);
  await gates["shared-b"].release();
  const result = await finishFrame(page);

  expect(result.status).toBe("ready");
  expect(result.failures).toHaveLength(3);
  expect(result.failures.filter((failure) => failure.phase === "script")).toEqual([
    {
      phase: "script",
      url: `${fixture.origin}/modules/shared-failure-a.js`,
      message: "shared external failure",
      fatal: false,
    },
    {
      phase: "script",
      url: `${fixture.origin}/modules/shared-failure-b.js`,
      message: "shared external failure",
      fatal: false,
    },
  ]);
  expect(result.failures.filter((failure) => failure.phase === "runtime")).toEqual([
    expect.objectContaining({
      phase: "runtime",
      message: "unrelated runtime failure",
      fatal: false,
    }),
  ]);
});

test("runs async inline modules concurrently while preserving their native start order", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await startFrame(page, "/documents/async-inline-order.html");
  // B runs while A is held at its top-level await. Were B queued behind A, it would
  // never run, and this wait would be the failure.
  await expect
    .poll(() => guestEvents(page, "__asyncInlineEvents"))
    .toEqual(["A-start", "B"]);
  await gates["async-inline-a"].release();
  const result = await finishFrame(page);

  expect(await guestEvents(page, "__asyncInlineEvents")).toEqual([
    "A-start",
    "B",
    "A-end",
  ]);
  expect(result.status).toBe("ready");
});

test("settles concurrent failing and successful inline modules without duplicate reports", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const pathname = "/documents/concurrent-inline-failures.html";
  await startFrame(page, pathname);
  // All three modules are held at once, then both failures land while the successful
  // module is still pending, B's before A's. Neither is reported until that module
  // settles, so the test waits for each module to have thrown instead.
  await expect
    .poll(() => guestEvents(page, "__concurrentInlineEvents"))
    .toEqual(["failure-a-start", "failure-b-start", "success-start"]);
  await gates["failure-b"].release();
  await reached("failure-b-thrown");
  await gates["failure-a"].release();
  await reached("failure-a-thrown");
  await gates.success.release();
  const result = await finishFrame(page);

  expect(await guestEvents(page, "__concurrentInlineEvents")).toEqual([
    "failure-a-start",
    "failure-b-start",
    "success-start",
    "success-end",
  ]);
  expect(result.status).toBe("ready");
  expect(result.failures).toHaveLength(2);
  expect(result.failures.map((failure) => failure.message).sort()).toEqual([
    "async inline failure A",
    "async inline failure B",
  ]);
  expect(result.failures).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        phase: "script",
        url: `${fixture.origin}${pathname}`,
        fatal: false,
      }),
      expect.objectContaining({
        phase: "script",
        url: `${fixture.origin}${pathname}`,
        fatal: false,
      }),
    ]),
  );
});

test("separates an external failure from overlapping concurrent inline modules", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const pathname = "/documents/external-and-concurrent-inline-failures.html";
  await startFrame(page, pathname);
  // The external failure follows the inline module's start and is reported at once. The
  // inline failure is released after it and is reported only when the pending inline
  // module settles, so the test waits for it to have thrown rather than for the report.
  await waitForFailures(page, 1);
  await gates["overlap-failure"].release();
  await reached("overlap-failure-thrown");
  await gates["overlap-tla"].release();
  const result = await finishFrame(page);

  expect(result.status).toBe("ready");
  expect(result.childState.inlineTlaFulfilled).toBe(true);
  expect(result.failures).toHaveLength(2);
  expect(result.failures).toEqual(
    expect.arrayContaining([
      {
        phase: "script",
        url: `${fixture.origin}/modules/external-dependency-entry.js`,
        message: "external dependency failure",
        fatal: false,
      },
      {
        phase: "script",
        url: `${fixture.origin}${pathname}`,
        message: "concurrent inline failure",
        fatal: false,
      },
    ]),
  );
});

test("serializes dynamic inline modules whose async property is false", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  await startFrame(page, "/documents/blank.html");
  await waitForLoad(page);

  await page.evaluate((holdFirst) => {
    const childWindow = (window as RunWindow).__run!.frame.contentWindow!;
    childWindow.__orderedInlineEvents = [];
    const first = childWindow.document.createElement("script");
    first.type = "module";
    first.async = false;
    first.text = `
      window.__orderedInlineEvents.push("first-start");
      ${holdFirst}
      window.__orderedInlineEvents.push("first-end");
    `;
    const second = childWindow.document.createElement("script");
    second.type = "module";
    second.async = false;
    second.text = 'window.__orderedInlineEvents.push("second");';
    childWindow.document.body.append(first, second);
  }, hold("ordered-first"));

  await expect
    .poll(() => guestEvents(page, "__orderedInlineEvents"))
    .toEqual(["first-start"]);
  // Had the second script been free to run alongside the first, it would have run by
  // the time the page has handled another task and painted.
  await flushTasks(page);
  expect(await guestEvents(page, "__orderedInlineEvents")).toEqual(["first-start"]);

  await gates["ordered-first"].release();
  await expect
    .poll(() => guestEvents(page, "__orderedInlineEvents"))
    .toEqual(["first-start", "first-end", "second"]);
});
