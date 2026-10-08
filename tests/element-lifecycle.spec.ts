import { expect, test, type Route } from "@playwright/test";
import { bundleRoute, htmlDocument, startHTTPFixture } from "./support/http-fixture";
import type { HTTPFixture } from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";
import type { VFrameElement } from "../src/index";
import { settleAfterRoundTrip } from "./support/settle";

let fixture: HTTPFixture;
let counted = 0;

test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div><div id="other"></div>'),
      "/dist/index.js": bundleRoute,
      "/guest": htmlDocument(
        '<h1 id="title">Guest</h1><a id="next" href="/guest?id=linked">Linked</a><a id="again" href="/guest?id=again">Again</a>',
      ),
      "/counted": () => {
        counted += 1;
        return { body: htmlDocument('<h1 id="title">Counted</h1>') };
      },
    },
  });
});
test.afterAll(async () => fixture.close());

const status = (frame: import("@playwright/test").Locator) =>
  frame.evaluate((element) => (element as VFrameElement).status);
const currentURL = (frame: import("@playwright/test").Locator) =>
  frame.evaluate((element) => (element as VFrameElement).currentURL);

test("a failed reload that superseded a slow load restores ready, not loading", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    id: "rollback",
    src: fixture.origin + "/guest?id=initial",
  });

  let slow: Route | undefined;
  await page.route("**/guest?id=slow", (route) => {
    slow = route;
  });
  await frame.evaluate((element, url) => {
    (element as VFrameElement).src = url;
  }, fixture.origin + "/guest?id=slow");
  await expect.poll(() => slow !== undefined).toBe(true);
  expect(await status(frame)).toBe("loading");

  // Load C supersedes the slow staged load B and then fails.
  await frame.evaluate((element, url) => {
    (element as VFrameElement).src = url;
  }, fixture.origin + "/missing");
  await expect
    .poll(() =>
      frame.evaluate(
        (element) => (element as unknown as { failures: unknown[] }).failures.length,
      ),
    )
    .toBe(1);

  expect(await status(frame)).toBe("ready");
  expect(
    await frame.evaluate((element) => ({
      ready: element.matches(":state(ready)"),
      loading: element.matches(":state(loading)"),
    })),
  ).toEqual({ ready: true, loading: false });
  expect(await currentURL(frame)).toBe(fixture.origin + "/guest?id=initial");

  // The restored guest owns its callbacks again, and the dead load B cannot commit.
  await slow!.fulfill({
    contentType: "text/html",
    body: htmlDocument('<h1 id="stale">Slow</h1>'),
  });
  await settleAfterRoundTrip(page, `${fixture.origin}/sentinel`);
  await expect(frame.locator("#stale")).toHaveCount(0);
  await frame.locator("#next").click();
  await expect.poll(() => currentURL(frame)).toBe(fixture.origin + "/guest?id=linked");
  await expect.poll(() => status(frame)).toBe("ready");

  await frame.evaluate((element, url) => {
    (element as VFrameElement).src = url;
  }, fixture.origin + "/guest?id=after");
  await expect.poll(() => currentURL(frame)).toBe(fixture.origin + "/guest?id=after");
  await expect.poll(() => status(frame)).toBe("ready");
});

test("v-frame-navigated and v-frame-load fire once the frame is ready, and a listener may navigate", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    id: "committed",
    src: fixture.origin + "/guest?id=initial",
  });

  await frame.evaluate((element, chained) => {
    const control = element as VFrameElement;
    const log: string[] = [];
    (window as unknown as { log: string[] }).log = log;
    let chainedOnce = false;
    control.addEventListener("v-frame-navigated", (event) => {
      log.push(`navigated ${control.status} ${event.detail.to}`);
      if (!chainedOnce) {
        chainedOnce = true;
        control.src = chained;
      }
    });
    control.addEventListener("v-frame-load", (event) => {
      log.push(`load ${event.detail.url}`);
    });
  }, fixture.origin + "/guest?id=chained");

  await frame.locator("#next").click();
  await expect.poll(() => currentURL(frame)).toBe(fixture.origin + "/guest?id=chained");
  await expect.poll(() => status(frame)).toBe("ready");
  expect(await page.evaluate(() => (window as unknown as { log: string[] }).log)).toEqual(
    [
      `navigated ready ${fixture.origin}/guest?id=linked`,
      // The linked load was superseded from its own navigated listener, so only the
      // load that replaced it reports v-frame-load.
      `load ${fixture.origin}/guest?id=chained`,
    ],
  );
});

test("the latest of two navigations requested in one task wins", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    id: "latest",
    src: fixture.origin + "/guest?id=initial",
  });

  await frame.evaluate(
    (element, { first, second }) => {
      const guest = (element as VFrameElement).contentWindow!;
      guest.location.assign(first);
      guest.location.assign(second);
    },
    {
      first: fixture.origin + "/guest?id=first",
      second: fixture.origin + "/guest?id=second",
    },
  );
  await expect.poll(() => currentURL(frame)).toBe(fixture.origin + "/guest?id=second");
  await expect.poll(() => status(frame)).toBe("ready");
});

test("a host src change after an allowed guest navigation wins", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    id: "host-wins",
    src: fixture.origin + "/guest?id=initial",
  });

  await frame.evaluate(
    (element, { guestURL, hostURL }) => {
      const control = element as VFrameElement;
      control.contentWindow!.location.assign(guestURL);
      control.src = hostURL;
    },
    {
      guestURL: fixture.origin + "/guest?id=guest",
      hostURL: fixture.origin + "/guest?id=host",
    },
  );
  await expect.poll(() => currentURL(frame)).toBe(fixture.origin + "/guest?id=host");
  await expect.poll(() => status(frame)).toBe("ready");
});

test("attribute changes that keep the effective value do not reload the guest", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  counted = 0;
  const frame = await mountFrame(page, {
    id: "effective",
    src: fixture.origin + "/counted",
  });
  expect(counted).toBe(1);

  const settle = () => settleAfterRoundTrip(page, `${fixture.origin}/sentinel`);
  await frame.evaluate((element) => {
    element.setAttribute("credentials", "same-origin");
    element.setAttribute("credentials", "bogus");
    element.setAttribute("navigation", "guest");
    element.setAttribute("navigation", "bogus");
    element.removeAttribute("navigation");
    element.setAttribute("trusted-types-policy", "  ");
  });
  await settle();
  expect(counted).toBe(1);
  expect(await status(frame)).toBe("ready");

  await frame.evaluate((element) => element.setAttribute("credentials", "omit"));
  await expect.poll(() => counted).toBe(2);
  await expect.poll(() => status(frame)).toBe("ready");
});

test("moveBefore keeps the guest alive and remove + insert restarts it", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  test.skip(
    !(await page.evaluate(() => "moveBefore" in Element.prototype)),
    "moveBefore is not available in this browser",
  );
  counted = 0;
  const frame = await mountFrame(page, {
    id: "moving",
    src: fixture.origin + "/counted",
  });
  await frame.evaluate((element) => {
    const control = element as VFrameElement;
    (control.contentWindow as unknown as { marker: string }).marker = "alive";
  });

  const moved = await frame.evaluate((element) => {
    const control = element as VFrameElement;
    const before = control.contentWindow;
    const target = document.querySelector("#other")!;
    (
      target as unknown as { moveBefore(node: Node, child: Node | null): void }
    ).moveBefore(control, null);
    return {
      parent: control.parentElement?.id,
      status: control.status,
      sameWindow: control.contentWindow === before,
      marker: (control.contentWindow as unknown as { marker?: string }).marker,
    };
  });
  expect(moved).toEqual({
    parent: "other",
    status: "ready",
    sameWindow: true,
    marker: "alive",
  });
  await settleAfterRoundTrip(page, `${fixture.origin}/sentinel`);
  expect(counted).toBe(1);
  expect(await status(frame)).toBe("ready");

  await frame.evaluate((element) => {
    const host = document.querySelector("#host")!;
    element.remove();
    host.append(element);
  });
  await expect.poll(() => counted).toBe(2);
  await expect.poll(() => status(frame)).toBe("ready");
  // The restarted guest is a new document, so the marker the old one carried is gone.
  expect(
    await frame.evaluate(
      (element) =>
        ((element as VFrameElement).contentWindow as unknown as { marker?: string })
          .marker ?? null,
    ),
  ).toBeNull();
});

// Drives a guest link click: a document navigation that commits and then reports
// `v-frame-navigated`, the event whose listeners these tests use to supersede it.
const clickGuestLink = (frame: import("@playwright/test").Locator, id: string) =>
  frame.evaluate((element, linkID) => {
    (element as VFrameElement)
      .contentWindow!.document.querySelector<HTMLElement>(`#${linkID}`)!
      .click();
  }, id);

test("a v-frame-navigated listener that removes the frame suppresses v-frame-load", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    id: "navigated-remove",
    src: fixture.origin + "/guest?id=start",
  });
  await frame.evaluate((element) => {
    const log: string[] = [];
    (window as unknown as { log: string[]; removed: VFrameElement }).log = log;
    (window as unknown as { removed: Element }).removed = element;
    for (const type of ["v-frame-loadstart", "v-frame-navigated", "v-frame-load"]) {
      element.addEventListener(type, () => log.push(type));
    }
    element.addEventListener("v-frame-navigated", () => element.remove(), {
      once: true,
    });
  });

  await clickGuestLink(frame, "next");
  // The removed element is no longer addressable through the locator.
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { removed: VFrameElement }).removed.status,
      ),
    )
    .toBe("idle");
  await settleAfterRoundTrip(page, `${fixture.origin}/sentinel`);
  expect(await page.evaluate(() => (window as unknown as { log: string[] }).log)).toEqual(
    ["v-frame-loadstart", "v-frame-navigated"],
  );
});

test("a v-frame-navigated listener that sets src replaces v-frame-load with the new load's", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    id: "navigated-src",
    src: fixture.origin + "/guest?id=start",
  });
  const loads = await frame.evaluate(async (element, again) => {
    const urls: string[] = [];
    element.addEventListener("v-frame-load", (event) =>
      urls.push((event as CustomEvent<{ url: string }>).detail.url),
    );
    element.addEventListener(
      "v-frame-navigated",
      () => ((element as VFrameElement).src = again),
      { once: true },
    );
    const finished = new Promise<void>((resolve) =>
      element.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    (element as VFrameElement)
      .contentWindow!.document.querySelector<HTMLElement>("#next")!
      .click();
    await finished;
    return urls;
  }, fixture.origin + "/guest?id=replacement");
  expect(loads).toEqual([fixture.origin + "/guest?id=replacement"]);
});

test("a traversal still resolves when a v-frame-navigated listener starts another load", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    id: "traverse-superseded-after-commit",
    src: fixture.origin + "/guest?id=start",
  });
  await clickGuestLink(frame, "next");
  await expect.poll(() => currentURL(frame)).toBe(fixture.origin + "/guest?id=linked");

  const outcome = await frame.evaluate(async (element, replacement) => {
    const control = element as VFrameElement;
    control.addEventListener(
      "v-frame-navigated",
      () => {
        control.src = replacement;
      },
      { once: true },
    );
    try {
      await control.back();
      return "resolved";
    } catch (error) {
      return `rejected: ${(error as Error).message}`;
    }
  }, fixture.origin + "/guest?id=replacement");
  expect(outcome).toBe("resolved");
});

test("reload() rejects when nothing can be reloaded", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const names = await page.evaluate(async () => {
    const frame = document.createElement("v-frame") as VFrameElement;
    const settle = (promise: Promise<void>) =>
      promise.then(
        () => "resolved",
        (error: DOMException) => error.name,
      );
    const disconnected = await settle(frame.reload());
    document.querySelector("#host")!.append(frame);
    const withoutSource = await settle(frame.reload());
    return { disconnected, withoutSource };
  });
  expect(names).toEqual({
    disconnected: "InvalidStateError",
    withoutSource: "InvalidStateError",
  });
});

test("reload() rejects with AbortError when a newer load supersedes it", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    id: "reload-superseded",
    src: fixture.origin + "/guest?id=reload",
  });
  const outcomes = await frame.evaluate(async (element) => {
    const control = element as VFrameElement;
    const settle = (promise: Promise<void>) =>
      promise.then(
        () => "resolved",
        (error: DOMException) => error.name,
      );
    const first = settle(control.reload());
    const second = settle(control.reload());
    return [await first, await second];
  });
  expect(outcomes).toEqual(["AbortError", "resolved"]);
});

test("reload() rejects with AbortError when the frame is removed before it commits", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    id: "reload-removed",
    src: fixture.origin + "/guest?id=reload",
  });
  const outcome = await frame.evaluate(async (element) => {
    const control = element as VFrameElement;
    const pending = control.reload().then(
      () => "resolved",
      (error: DOMException) => error.name,
    );
    control.remove();
    return pending;
  });
  expect(outcome).toBe("AbortError");
});

test("host navigation during a staged load rejects as InvalidStateError, not canceled", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    id: "navigate-while-loading",
    src: fixture.origin + "/guest?id=initial",
  });

  let slow: Route | undefined;
  await page.route("**/guest?id=slow-staged", (route) => {
    slow = route;
  });
  await frame.evaluate((element, url) => {
    (element as VFrameElement).src = url;
  }, fixture.origin + "/guest?id=slow-staged");
  await expect.poll(() => slow !== undefined).toBe(true);

  const outcomes = await frame.evaluate(async (element, route) => {
    const control = element as VFrameElement;
    const settle = (promise: Promise<void>) =>
      promise.then(
        () => "resolved",
        (error: DOMException) => `${error.name}: ${error.message}`,
      );
    return [
      await settle(control.navigate(route)),
      await settle(control.back()),
      await settle(control.forward()),
      await settle(control.go(-1)),
    ];
  }, fixture.origin + "/guest?id=elsewhere");
  for (const outcome of outcomes) {
    expect(outcome).toMatch(/^InvalidStateError: .*loading/);
  }
  await slow!.abort();
});
