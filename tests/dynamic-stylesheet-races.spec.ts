import { expect, test } from "@playwright/test";
import type { ServerResponse } from "node:http";
import {
  bundleRoute,
  type Route,
  sendResponse,
  startHTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";

interface PendingStylesheet {
  requested: Promise<void>;
  resolveRequested(): void;
  response: ServerResponse | null;
}

interface DynamicStylesheetFixture {
  origin: string;
  requestCount(pathname: string): number;
  waitForRequest(pathname: string): Promise<void>;
  release(pathname: string, status: number, source: string): void;
  close(): Promise<void>;
}

interface Failure {
  phase: string;
  url: string;
  fatal: boolean;
}

/** Stylesheets whose responses a test releases by hand, to open a revision race. */
const delayedStylesheets = [
  "/styles/inline-first.css",
  "/styles/inline-observer.css",
  "/styles/inline-clear.css",
  "/styles/inline-stale-failure.css",
  "/styles/final-failure.css",
  "/styles/removal.css",
  "/styles/teardown.css",
  "/styles/link-first.css",
  "/styles/link-reconnect.css",
];

let fixture: DynamicStylesheetFixture;

function pendingStylesheet(): PendingStylesheet {
  let resolveRequested: (() => void) | undefined;
  const requested = new Promise<void>((resolve) => {
    resolveRequested = resolve;
  });
  return {
    requested,
    resolveRequested() {
      resolveRequested?.();
    },
    response: null,
  };
}

/**
 * Parks the request instead of answering it, unless the browser is preloading the
 * stylesheet, in which case it gets an immediate empty sheet.
 */
function holdStylesheet(pathname: string, delayed: PendingStylesheet): Route {
  return (request, response) => {
    if (request.headers["sec-fetch-dest"] === "style") {
      return { type: "text/css", body: "" };
    }
    if (delayed.response !== null) {
      return {
        status: 409,
        type: "text/plain",
        body: `Duplicate delayed request for ${pathname}`,
      };
    }
    delayed.response = response;
    delayed.resolveRequested();
    return undefined;
  };
}

async function startFixture(): Promise<DynamicStylesheetFixture> {
  const pending = new Map(
    delayedStylesheets.map((pathname) => [pathname, pendingStylesheet()] as const),
  );
  const routes: Record<string, Route> = {
    "/": '<!doctype html><div id="host"></div>',
    "/dist/index.js": bundleRoute,
    "/documents/race.html":
      '<!doctype html><html><head></head><body><p id="race-target">race target</p></body></html>',
    "/styles/link-third.css": {
      type: "text/css",
      body: ":host { background-color: rgb(101, 102, 103); } body { color: rgb(201, 202, 203); } #race-target { color: rgb(61, 62, 63); }",
    },
  };
  for (const [pathname, delayed] of pending) {
    routes[pathname] = holdStylesheet(pathname, delayed);
  }

  const server = await startHTTPFixture({ routes });
  return {
    origin: server.origin,
    requestCount(pathname) {
      return server.requests.filter((recorded) => recorded === pathname).length;
    },
    waitForRequest(pathname) {
      const delayed = pending.get(pathname);
      if (delayed === undefined) {
        throw new Error(`No delayed stylesheet is registered for ${pathname}`);
      }
      return delayed.requested;
    },
    release(pathname, status, source) {
      const delayed = pending.get(pathname);
      if (delayed === undefined || delayed.response === null) {
        throw new Error(
          `Delayed stylesheet ${pathname} was released before its request arrived`,
        );
      }
      sendResponse(delayed.response, {
        status,
        type: status === 200 ? "text/css" : "text/plain",
        body: source,
      });
      delayed.response = null;
    },
    close: () => server.close(),
  };
}

test.beforeAll(async () => {
  fixture = await startFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

async function appendStyle(
  frame: import("@playwright/test").Locator,
  id: string,
  source: string,
): Promise<void> {
  await frame.evaluate(
    (element, values) => {
      const child = (
        element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
      ).contentWindow;
      if (child === null) {
        throw new Error("The race frame did not expose its child window");
      }
      const style = child.document.createElement("style");
      style.id = values.id;
      style.textContent = values.source;
      child.document.head.append(style);
    },
    { id, source },
  );
}

async function failures(frame: import("@playwright/test").Locator): Promise<Failure[]> {
  return frame.evaluate(
    (element) =>
      (element as HTMLElement & { raceFailures?: Failure[] }).raceFailures ?? [],
  );
}

async function collectFailures(frame: import("@playwright/test").Locator): Promise<void> {
  await frame.evaluate((element) => {
    const raceFrame = element as HTMLElement & { raceFailures?: Failure[] };
    raceFrame.raceFailures = [];
    raceFrame.addEventListener("v-frame-error", (event) => {
      const detail = (event as CustomEvent<Failure>).detail;
      raceFrame.raceFailures?.push({
        phase: detail.phase,
        url: detail.url,
        fatal: detail.fatal,
      });
    });
  });
}

test("keeps the third dynamic inline stylesheet revision when its first import finishes last", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/race.html`,
    id: "inline-race",
    settle: "load",
  });
  await appendStyle(
    frame,
    "inline-race-style",
    '@import url("/styles/inline-first.css"); #race-target { color: rgb(1, 2, 3); }',
  );
  await fixture.waitForRequest("/styles/inline-first.css");

  const transientHostBackground = await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const style = child.document.querySelector("#inline-race-style") as HTMLStyleElement;
    style.textContent = "#race-target { color: rgb(21, 22, 23); }";
    style.textContent =
      ":host { background-color: rgb(101, 102, 103); } body { color: rgb(201, 202, 203); } #race-target { color: rgb(31, 32, 33); }";
    return getComputedStyle(element).backgroundColor;
  });
  fixture.release(
    "/styles/inline-first.css",
    200,
    "#race-target { color: rgb(1, 2, 3); }",
  );

  expect(transientHostBackground).toBe("rgba(0, 0, 0, 0)");
  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(31, 32, 33)");
  await expect(frame).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(frame).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(frame.locator("v-body")).toHaveCSS("color", "rgb(201, 202, 203)");
});

test("keeps a page observer revision that reacts to implementation neutralization", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/race.html`,
    id: "observer-race",
    settle: "load",
  });
  await frame.evaluate(async (element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const style = child.document.createElement("style");
    style.id = "observer-race-style";
    style.textContent =
      '@import url("/styles/inline-observer.css"); #race-target { color: rgb(1, 2, 3); }';
    const authoredRevisionObserved = new Promise<void>((resolveObserved) => {
      const observer = new child.MutationObserver(() => {
        if (style.textContent !== "") {
          return;
        }
        observer.disconnect();
        style.textContent = "#race-target { color: rgb(91, 92, 93); }";
        resolveObserved();
      });
      observer.observe(style, { childList: true });
    });
    child.document.head.append(style);
    await authoredRevisionObserved;
  });
  await fixture.waitForRequest("/styles/inline-observer.css");
  fixture.release(
    "/styles/inline-observer.css",
    200,
    "#race-target { color: rgb(11, 12, 13); }",
  );

  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(91, 92, 93)");
});

test("keeps an authored clear while an inline rewrite is pending", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/race.html`,
    id: "clear-race",
    settle: "load",
  });
  await appendStyle(
    frame,
    "clear-race-style",
    '@import url("/styles/inline-clear.css"); #race-target { color: rgb(1, 2, 3); }',
  );
  await fixture.waitForRequest("/styles/inline-clear.css");
  await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const style = child.document.querySelector("#clear-race-style") as HTMLStyleElement;
    style.textContent = "";
  });
  fixture.release(
    "/styles/inline-clear.css",
    200,
    "#race-target { color: rgb(21, 22, 23); }",
  );
  await page.waitForTimeout(50);

  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(0, 0, 0)");
  expect(
    await frame.evaluate((element) => {
      const child = (
        element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
      ).contentWindow!;
      return child.document.querySelector("#clear-race-style")?.textContent;
    }),
  ).toBe("");
});

test("processes batched child and innerHTML style mutations as complete authored sources", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/race.html`,
    id: "style-batches",
    settle: "load",
  });
  await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const style = child.document.createElement("style");
    style.id = "style-batches-style";
    child.document.head.append(style);
    style.append("#race-", "target { color: rgb(101, 102, 103); }");
  });
  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(101, 102, 103)");

  const transientHostBackground = await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const style = child.document.querySelector(
      "#style-batches-style",
    ) as HTMLStyleElement;
    style.innerHTML =
      ":host { background-color: rgb(111, 112, 113); } body { color: rgb(121, 122, 123); } #race-target { color: rgb(131, 132, 133); }";
    return getComputedStyle(element).backgroundColor;
  });

  expect(transientHostBackground).toBe("rgba(0, 0, 0, 0)");
  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(131, 132, 133)");
  await expect(frame.locator("v-body")).toHaveCSS("color", "rgb(121, 122, 123)");
  await expect(frame).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("installs CSSOM rewriting on rules created by an asynchronous dynamic style commit", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/race.html`,
    id: "dynamic-cssom",
    settle: "load",
  });
  await appendStyle(
    frame,
    "dynamic-cssom-style",
    "#race-target { color: rgb(71, 72, 73); }",
  );
  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(71, 72, 73)");

  const result = await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const style = child.document.querySelector(
      "#dynamic-cssom-style",
    ) as HTMLStyleElement;
    const rule = style.sheet!.cssRules[0] as CSSStyleRule;
    rule.selectorText = ":host";
    rule.style.cssText = 'background-image: url("./asset.png")';
    return {
      backgroundImage: rule.style.backgroundImage,
      selector: rule.selectorText,
    };
  });

  expect(result).toEqual({
    backgroundImage: `url("${fixture.origin}/documents/asset.png")`,
    selector: ":not(*)",
  });
  await expect(frame).toHaveCSS("background-image", "none");
});

test("ignores a stale inline import failure and reports the current final failure once", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/race.html`,
    id: "failure-race",
    settle: "load",
  });
  await collectFailures(frame);
  await appendStyle(
    frame,
    "failure-race-style",
    '@import url("/styles/inline-stale-failure.css"); #race-target { color: rgb(1, 2, 3); }',
  );
  await fixture.waitForRequest("/styles/inline-stale-failure.css");

  await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const style = child.document.querySelector("#failure-race-style") as HTMLStyleElement;
    style.textContent = "#race-target { color: rgb(21, 22, 23); }";
    style.textContent =
      '@import url("/styles/final-failure.css"); #race-target { color: rgb(41, 42, 43); }';
  });
  await fixture.waitForRequest("/styles/final-failure.css");
  fixture.release("/styles/inline-stale-failure.css", 500, "Stale stylesheet failed");
  fixture.release("/styles/final-failure.css", 500, "Current stylesheet failed");

  await expect
    .poll(() => failures(frame))
    .toEqual([
      {
        phase: "stylesheet",
        url: `${fixture.origin}/styles/final-failure.css`,
        fatal: false,
      },
    ]);
  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(41, 42, 43)");
});

test("does not commit delayed dynamic styles after removal or frame teardown", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const removedFrame = await mountFrame(page, {
    src: `${fixture.origin}/documents/race.html`,
    id: "removed-style-race",
    settle: "load",
  });
  const tornDownFrame = await mountFrame(page, {
    src: `${fixture.origin}/documents/race.html`,
    id: "teardown-style-race",
    settle: "load",
  });
  await collectFailures(removedFrame);
  await collectFailures(tornDownFrame);

  await appendStyle(
    removedFrame,
    "removed-style",
    '@import url("/styles/removal.css"); #race-target { color: rgb(1, 2, 3); }',
  );
  await fixture.waitForRequest("/styles/removal.css");
  await removedFrame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const style = child.document.querySelector("#removed-style") as HTMLStyleElement;
    (child as Window & { removedRaceStyle?: HTMLStyleElement }).removedRaceStyle = style;
    style.remove();
  });

  await appendStyle(
    tornDownFrame,
    "teardown-style",
    '@import url("/styles/teardown.css"); #race-target { color: rgb(1, 2, 3); }',
  );
  await fixture.waitForRequest("/styles/teardown.css");
  await tornDownFrame.evaluate((element) => {
    const frame = element as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
      tornDownRaceStyle?: HTMLStyleElement;
    };
    const style = frame.contentWindow!.document.querySelector(
      "#teardown-style",
    ) as HTMLStyleElement;
    (
      window as Window & {
        teardownRace?: { frame: typeof frame; style: HTMLStyleElement };
      }
    ).teardownRace = { frame, style };
    frame.remove();
  });

  fixture.release("/styles/removal.css", 200, "#race-target { color: rgb(1, 2, 3); }");
  fixture.release("/styles/teardown.css", 200, "#race-target { color: rgb(1, 2, 3); }");
  await page.waitForTimeout(50);

  await expect(removedFrame.locator("#race-target")).toHaveCSS("color", "rgb(0, 0, 0)");
  expect(await failures(removedFrame)).toEqual([]);
  const teardown = await page.evaluate(() => {
    const race = (
      window as Window & {
        teardownRace?: {
          frame: HTMLElement & {
            isConnected: boolean;
            contentWindow: (Window & typeof globalThis) | null;
            raceFailures?: Failure[];
          };
          style: HTMLStyleElement;
        };
      }
    ).teardownRace;
    const frame = race?.frame;
    return {
      frameRemoved: frame !== undefined && !frame.isConnected,
      hasContentWindow: frame?.contentWindow !== null,
      staleText: race?.style.textContent ?? null,
      failures: frame?.raceFailures ?? [],
    };
  });
  expect(teardown).toEqual({
    frameRemoved: true,
    hasContentWindow: false,
    staleText: "",
    failures: [],
  });
  const removedStyleText = await removedFrame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    return (child as Window & { removedRaceStyle?: HTMLStyleElement }).removedRaceStyle
      ?.textContent;
  });
  expect(removedStyleText).toBe("");
});

test("keeps the latest dynamic link href, media, and disabled state after its first fetch finishes late", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/race.html`,
    id: "link-race",
    settle: "load",
  });
  await collectFailures(frame);
  await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const link = child.document.createElement("link");
    link.id = "link-race-style";
    link.rel = "stylesheet";
    link.href = "/styles/link-first.css";
    link.media = "print";
    child.document.head.append(link);
  });
  await fixture.waitForRequest("/styles/link-first.css");

  await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const link = child.document.querySelector("#link-race-style") as HTMLLinkElement;
    link.href = "/styles/link-second.css";
    link.media = "print";
    link.disabled = true;
    link.href = "/styles/link-third.css";
    link.media = "screen";
    link.disabled = false;
  });
  fixture.release("/styles/link-first.css", 500, "Stale linked stylesheet failed");

  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(61, 62, 63)");
  await expect
    .poll(() =>
      frame.evaluate((element) => {
        const style = element.shadowRoot?.querySelector(
          "style[data-v-frame-source]",
        ) as HTMLStyleElement | null;
        return style === null
          ? null
          : {
              disabled: style.disabled,
              media: style.media,
              source: style.dataset.vFrameSource,
            };
      }),
    )
    .toEqual({
      disabled: false,
      media: "screen",
      source: `${fixture.origin}/styles/link-third.css`,
    });
  expect(await failures(frame)).toEqual([]);
  expect(fixture.requestCount("/styles/link-first.css")).toBe(1);
  expect(fixture.requestCount("/styles/link-third.css")).toBe(1);
  await expect(frame).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("restores the authored link relation after pending work is disconnected and canceled", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, {
    src: `${fixture.origin}/documents/race.html`,
    id: "link-reconnect",
    settle: "load",
  });
  await collectFailures(frame);
  await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const link = child.document.createElement("link");
    link.id = "link-reconnect-style";
    link.rel = "stylesheet";
    link.href = "/styles/link-reconnect.css";
    child.document.head.append(link);
  });
  await fixture.waitForRequest("/styles/link-reconnect.css");

  await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const link = child.document.querySelector("#link-reconnect-style") as HTMLLinkElement;
    (child as Window & { disconnectedRaceLink?: HTMLLinkElement }).disconnectedRaceLink =
      link;
    link.remove();
  });
  await page.waitForTimeout(0);
  const reconnected = await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow!;
    const link = (child as Window & { disconnectedRaceLink?: HTMLLinkElement })
      .disconnectedRaceLink!;
    link.removeAttribute("href");
    child.document.head.append(link);
    return {
      hasHref: link.hasAttribute("href"),
      relation: link.rel,
    };
  });
  fixture.release(
    "/styles/link-reconnect.css",
    200,
    "#race-target { color: rgb(81, 82, 83); }",
  );
  await page.waitForTimeout(50);

  expect(reconnected).toEqual({ hasHref: false, relation: "stylesheet" });
  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(0, 0, 0)");
  expect(await failures(frame)).toEqual([]);
});
