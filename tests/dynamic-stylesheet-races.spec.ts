import { expect, test, type Page } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

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

let fixture: DynamicStylesheetFixture;

function reply(response: ServerResponse, status: number, type: string, source: string): void {
  response.writeHead(status, { "cache-control": "no-store", "content-type": type });
  response.end(source);
}

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

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
}

async function startFixture(): Promise<DynamicStylesheetFixture> {
  const bundle = resolve(process.cwd(), "dist/index.js");
  const requestCounts = new Map<string, number>();
  const pending = new Map([
    ["/styles/inline-first.css", pendingStylesheet()],
    ["/styles/inline-observer.css", pendingStylesheet()],
    ["/styles/inline-clear.css", pendingStylesheet()],
    ["/styles/inline-stale-failure.css", pendingStylesheet()],
    ["/styles/removal.css", pendingStylesheet()],
    ["/styles/teardown.css", pendingStylesheet()],
    ["/styles/link-first.css", pendingStylesheet()],
    ["/styles/link-reconnect.css", pendingStylesheet()],
  ]);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture.test").pathname;
    requestCounts.set(pathname, (requestCounts.get(pathname) ?? 0) + 1);
    if (pathname === "/") {
      reply(response, 200, "text/html", "<!doctype html><div id=\"host\"></div>");
      return;
    }
    if (pathname === "/dist/index.js") {
      if (!existsSync(bundle)) {
        reply(response, 404, "text/plain", "Build output not found");
        return;
      }
      response.writeHead(200, { "cache-control": "no-store", "content-type": "text/javascript" });
      createReadStream(bundle).pipe(response);
      return;
    }
    if (pathname === "/documents/race.html") {
      reply(
        response,
        200,
        "text/html",
        "<!doctype html><html><head></head><body><p id=\"race-target\">race target</p></body></html>",
      );
      return;
    }

    const delayed = pending.get(pathname);
    if (delayed !== undefined) {
      if (delayed.response !== null) {
        reply(response, 409, "text/plain", `Duplicate delayed request for ${pathname}`);
        return;
      }
      delayed.response = response;
      delayed.resolveRequested();
      return;
    }
    if (pathname === "/styles/final-failure.css") {
      reply(response, 500, "text/plain", "Current stylesheet failed");
      return;
    }
    if (pathname === "/styles/link-third.css") {
      reply(
        response,
        200,
        "text/css",
        ":host { background-color: rgb(101, 102, 103); } body { color: rgb(201, 202, 203); } #race-target { color: rgb(61, 62, 63); }",
      );
      return;
    }
    reply(response, 404, "text/plain", `No fixture for ${pathname}`);
  });

  await new Promise<void>((resolveListening) => {
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Dynamic stylesheet fixture server did not expose a TCP address");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requestCount(pathname) {
      return requestCounts.get(pathname) ?? 0;
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
      if (delayed?.response === null || delayed === undefined) {
        throw new Error(`Delayed stylesheet ${pathname} was released before its request arrived`);
      }
      reply(delayed.response, status, status === 200 ? "text/css" : "text/plain", source);
      delayed.response = null;
    },
    close: () => closeServer(server),
  };
}

test.beforeAll(async () => {
  fixture = await startFixture();
});

test.afterAll(async () => {
  await fixture.close();
});

async function installBundle(page: Page): Promise<void> {
  await page.goto(fixture.origin);
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
  }, `${fixture.origin}/dist/index.js`);
}

async function mountFrame(page: Page, id: string): Promise<import("@playwright/test").Locator> {
  await page.evaluate(async ({ origin, frameID }) => {
    const frame = document.createElement("v-frame") as HTMLElement & { src: string };
    frame.id = frameID;
    const loaded = new Promise<void>((resolveLoaded) => {
      frame.addEventListener("v-frame-load", () => resolveLoaded(), { once: true });
    });
    frame.src = `${origin}/documents/race.html`;
    document.querySelector("#host")?.append(frame);
    await loaded;
  }, { origin: fixture.origin, frameID: id });
  return page.locator(`v-frame#${id}`);
}

async function appendStyle(
  frame: import("@playwright/test").Locator,
  id: string,
  source: string,
): Promise<void> {
  await frame.evaluate((element, values) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow;
    if (child === null) {
      throw new Error("The race frame did not expose its child window");
    }
    const style = child.document.createElement("style");
    style.id = values.id;
    style.textContent = values.source;
    child.document.head.append(style);
  }, { id, source });
}

async function failures(frame: import("@playwright/test").Locator): Promise<Failure[]> {
  return frame.evaluate((element) => (
    (element as HTMLElement & { raceFailures?: Failure[] }).raceFailures ?? []
  ));
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

test("keeps the third dynamic inline stylesheet revision when its first import finishes last", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "inline-race");
  await appendStyle(
    frame,
    "inline-race-style",
    '@import url("/styles/inline-first.css"); #race-target { color: rgb(1, 2, 3); }',
  );
  await fixture.waitForRequest("/styles/inline-first.css");

  const transientHostBackground = await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
    const style = child.document.querySelector("#inline-race-style") as HTMLStyleElement;
    style.textContent = "#race-target { color: rgb(21, 22, 23); }";
    style.textContent = ":host { background-color: rgb(101, 102, 103); } body { color: rgb(201, 202, 203); } #race-target { color: rgb(31, 32, 33); }";
    return getComputedStyle(element).backgroundColor;
  });
  fixture.release("/styles/inline-first.css", 200, "#race-target { color: rgb(1, 2, 3); }");

  expect(transientHostBackground).toBe("rgba(0, 0, 0, 0)");
  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(31, 32, 33)");
  await expect(frame).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(frame).toHaveCSS("color", "rgb(0, 0, 0)");
  await expect(frame.locator("v-body")).toHaveCSS("color", "rgb(201, 202, 203)");
});

test("keeps a page observer revision that reacts to implementation neutralization", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "observer-race");
  await frame.evaluate(async (element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
    const style = child.document.createElement("style");
    style.id = "observer-race-style";
    style.textContent = '@import url("/styles/inline-observer.css"); #race-target { color: rgb(1, 2, 3); }';
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
  await installBundle(page);
  const frame = await mountFrame(page, "clear-race");
  await appendStyle(
    frame,
    "clear-race-style",
    '@import url("/styles/inline-clear.css"); #race-target { color: rgb(1, 2, 3); }',
  );
  await fixture.waitForRequest("/styles/inline-clear.css");
  await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
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
  expect(await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
    return child.document.querySelector("#clear-race-style")?.textContent;
  })).toBe("");
});

test("processes batched child and innerHTML style mutations as complete authored sources", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "style-batches");
  await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
    const style = child.document.createElement("style");
    style.id = "style-batches-style";
    child.document.head.append(style);
    style.append(
      "#race-",
      "target { color: rgb(101, 102, 103); }",
    );
  });
  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(101, 102, 103)");

  const transientHostBackground = await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
    const style = child.document.querySelector("#style-batches-style") as HTMLStyleElement;
    style.innerHTML = ":host { background-color: rgb(111, 112, 113); } body { color: rgb(121, 122, 123); } #race-target { color: rgb(131, 132, 133); }";
    return getComputedStyle(element).backgroundColor;
  });

  expect(transientHostBackground).toBe("rgba(0, 0, 0, 0)");
  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(131, 132, 133)");
  await expect(frame.locator("v-body")).toHaveCSS("color", "rgb(121, 122, 123)");
  await expect(frame).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("installs CSSOM rewriting on rules created by an asynchronous dynamic style commit", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "dynamic-cssom");
  await appendStyle(
    frame,
    "dynamic-cssom-style",
    "#race-target { color: rgb(71, 72, 73); }",
  );
  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(71, 72, 73)");

  const result = await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
    const style = child.document.querySelector("#dynamic-cssom-style") as HTMLStyleElement;
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

test("ignores a stale inline import failure and reports the current final failure once", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "failure-race");
  await collectFailures(frame);
  await appendStyle(
    frame,
    "failure-race-style",
    '@import url("/styles/inline-stale-failure.css"); #race-target { color: rgb(1, 2, 3); }',
  );
  await fixture.waitForRequest("/styles/inline-stale-failure.css");

  await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
    const style = child.document.querySelector("#failure-race-style") as HTMLStyleElement;
    style.textContent = "#race-target { color: rgb(21, 22, 23); }";
    style.textContent = '@import url("/styles/final-failure.css"); #race-target { color: rgb(41, 42, 43); }';
  });
  fixture.release("/styles/inline-stale-failure.css", 500, "Stale stylesheet failed");

  await expect.poll(() => failures(frame)).toEqual([{
    phase: "stylesheet",
    url: `${fixture.origin}/styles/final-failure.css`,
    fatal: false,
  }]);
  await expect(frame.locator("#race-target")).toHaveCSS("color", "rgb(41, 42, 43)");
});

test("does not commit delayed dynamic styles after removal or frame teardown", async ({ page }) => {
  await installBundle(page);
  const removedFrame = await mountFrame(page, "removed-style-race");
  const tornDownFrame = await mountFrame(page, "teardown-style-race");
  await collectFailures(removedFrame);
  await collectFailures(tornDownFrame);

  await appendStyle(
    removedFrame,
    "removed-style",
    '@import url("/styles/removal.css"); #race-target { color: rgb(1, 2, 3); }',
  );
  await fixture.waitForRequest("/styles/removal.css");
  await removedFrame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
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
    const frame = element as HTMLElement & { contentWindow: Window | null; tornDownRaceStyle?: HTMLStyleElement };
    const style = frame.contentWindow!.document.querySelector("#teardown-style") as HTMLStyleElement;
    (window as Window & {
      teardownRace?: { frame: typeof frame; style: HTMLStyleElement };
    }).teardownRace = { frame, style };
    frame.remove();
  });

  fixture.release("/styles/removal.css", 200, "#race-target { color: rgb(1, 2, 3); }");
  fixture.release("/styles/teardown.css", 200, "#race-target { color: rgb(1, 2, 3); }");
  await page.waitForTimeout(50);

  await expect(removedFrame.locator("#race-target")).toHaveCSS("color", "rgb(0, 0, 0)");
  expect(await failures(removedFrame)).toEqual([]);
  const teardown = await page.evaluate(() => {
    const race = (window as Window & {
      teardownRace?: {
        frame: HTMLElement & {
          isConnected: boolean;
          contentWindow: Window | null;
          raceFailures?: Failure[];
        };
        style: HTMLStyleElement;
      };
    }).teardownRace;
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
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
    return (child as Window & { removedRaceStyle?: HTMLStyleElement }).removedRaceStyle?.textContent;
  });
  expect(removedStyleText).toBe("");
});

test("keeps the latest dynamic link href, media, and disabled state after its first fetch finishes late", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "link-race");
  await collectFailures(frame);
  await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
    const link = child.document.createElement("link");
    link.id = "link-race-style";
    link.rel = "stylesheet";
    link.href = "/styles/link-first.css";
    link.media = "print";
    child.document.head.append(link);
  });
  await fixture.waitForRequest("/styles/link-first.css");

  await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
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
  await expect.poll(() => frame.evaluate((element) => {
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
  })).toEqual({
    disabled: false,
    media: "screen",
    source: `${fixture.origin}/styles/link-third.css`,
  });
  expect(await failures(frame)).toEqual([]);
  expect(fixture.requestCount("/styles/link-first.css")).toBe(1);
  expect(fixture.requestCount("/styles/link-third.css")).toBe(1);
  await expect(frame).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("restores the authored link relation after pending work is disconnected and canceled", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "link-reconnect");
  await collectFailures(frame);
  await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
    const link = child.document.createElement("link");
    link.id = "link-reconnect-style";
    link.rel = "stylesheet";
    link.href = "/styles/link-reconnect.css";
    child.document.head.append(link);
  });
  await fixture.waitForRequest("/styles/link-reconnect.css");

  await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
    const link = child.document.querySelector("#link-reconnect-style") as HTMLLinkElement;
    (child as Window & { disconnectedRaceLink?: HTMLLinkElement }).disconnectedRaceLink = link;
    link.remove();
  });
  await page.waitForTimeout(0);
  const reconnected = await frame.evaluate((element) => {
    const child = (element as HTMLElement & { contentWindow: Window | null }).contentWindow!;
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
