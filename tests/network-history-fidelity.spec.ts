import { expect, test, type Locator, type Page } from "@playwright/test";
import { bundleRoute, startHTTPFixture } from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";
import { flushTasks, settleAfterRoundTrip } from "./support/settle";

let origin: string;
let requests: string[];
let close: () => Promise<void>;

test.beforeAll(async () => {
  const fixture = await startHTTPFixture({
    routes: {
      "/": '<!doctype html><div id="host"></div>',
      "/dist/index.js": bundleRoute,
      "/documents/based.html":
        '<!doctype html><html><head><base href="/based-root/"></head><body><p>based</p></body></html>',
      "/documents/svg-anchor.html":
        '<!doctype html><html><body><svg width="20" height="20"><a href="next.html"><rect width="20" height="20"/></a></svg></body></html>',
      "/documents/guest.html":
        "<!doctype html><html><head></head><body><p>guest</p></body></html>",
    },
    fallback: { type: "text/plain", body: "ok" },
  });
  origin = fixture.origin;
  requests = fixture.requests;
  close = fixture.close;
});

test.afterAll(async () => {
  await close();
});

async function mountGuest(page: Page): Promise<Locator> {
  await installBundle(page, origin);
  return mountFrame(page, { src: `${origin}/documents/guest.html`, id: "guest" });
}

test("a patched Request keeps the native prototype chain", async ({ page }) => {
  const frame = await mountGuest(page);
  const result = await frame.evaluate((element) => {
    const guest = (element as HTMLElement & { contentWindow: Window & typeof globalThis })
      .contentWindow;
    const GuestRequest = guest.Request;
    const request = new GuestRequest("relative/path");
    class Subclass extends GuestRequest {
      marker = "subclass";
    }
    const sub = new Subclass("sub");
    return {
      url: request.url,
      cloneIsInstance: request.clone() instanceof GuestRequest,
      prototypeIsNative: GuestRequest.prototype === Object.getPrototypeOf(request),
      constructorIsExposed: request.constructor === GuestRequest,
      name: GuestRequest.name,
      length: GuestRequest.length,
      subInstance: sub instanceof GuestRequest && sub instanceof Subclass,
      subMarker: sub.marker,
      subURL: sub.url,
      fromRequest: new GuestRequest(request).url,
      noArguments: (() => {
        try {
          new (GuestRequest as unknown as new () => Request)();
          return "constructed";
        } catch (error) {
          return (error as Error).name;
        }
      })(),
    };
  });

  expect(result).toEqual({
    url: `${origin}/documents/relative/path`,
    cloneIsInstance: true,
    prototypeIsNative: true,
    constructorIsExposed: true,
    name: "Request",
    length: 1,
    subInstance: true,
    subMarker: "subclass",
    subURL: `${origin}/documents/sub`,
    fromRequest: `${origin}/documents/relative/path`,
    noArguments: "TypeError",
  });
});

test("history.pushState and replaceState throw SecurityError for an unparsable URL", async ({
  page,
}) => {
  const frame = await mountGuest(page);
  const names = await frame.evaluate((element) => {
    const guest = (element as HTMLElement & { contentWindow: Window & typeof globalThis })
      .contentWindow;
    const nameOf = (action: () => void) => {
      try {
        action();
        return "none";
      } catch (error) {
        return (error as DOMException).name;
      }
    };
    return {
      push: nameOf(() => guest.history.pushState(null, "", "http://[")),
      replace: nameOf(() => guest.history.replaceState(null, "", "http://[")),
      crossOrigin: nameOf(() =>
        guest.history.pushState(null, "", "https://elsewhere.invalid/"),
      ),
    };
  });

  expect(names).toEqual({
    push: "SecurityError",
    replace: "SecurityError",
    crossOrigin: "SecurityError",
  });
});

test("an XHR opened before teardown cannot be sent afterwards", async ({ page }) => {
  const frame = await mountGuest(page);
  const outcome = await frame.evaluate(async (element) => {
    const guest = (element as HTMLElement & { contentWindow: Window & typeof globalThis })
      .contentWindow;
    const request = new guest.XMLHttpRequest();
    request.open("GET", "never-sent-after-teardown.txt");
    const neverSent = new guest.XMLHttpRequest();
    neverSent.open("GET", "opened-only.txt");
    element.remove();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    try {
      request.send();
      return "sent";
    } catch (error) {
      return (error as DOMException).name;
    }
  });

  // Chromium reports the detached document as a NetworkError, others as an
  // InvalidStateError; what matters is that nothing was sent.
  expect(outcome).not.toBe("sent");
  await settleAfterRoundTrip(page, `${origin}/sentinel`);
  expect(requests.filter((path) => path.includes("never-sent-after-teardown"))).toEqual(
    [],
  );
  expect(requests.filter((path) => path.includes("opened-only"))).toEqual([]);
});

async function mountHostModeGuest(page: Page, path: string): Promise<Locator> {
  await installBundle(page, origin);
  await page.evaluate(async (source) => {
    const frame = document.createElement("v-frame");
    frame.id = "guest";
    frame.setAttribute("navigation", "host");
    const loaded = new Promise<void>((resolve) =>
      frame.addEventListener("v-frame-load", () => resolve(), { once: true }),
    );
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
    await loaded;
  }, `${origin}${path}`);
  return page.locator("v-frame#guest");
}

test("host-mode history.go coerces its delta and never reloads the host page", async ({
  page,
}) => {
  const frame = await mountHostModeGuest(page, "/documents/guest.html");
  let loads = 0;
  page.on("load", () => (loads += 1));
  await page.evaluate(
    () => ((window as unknown as { hostMarker: boolean }).hostMarker = true),
  );
  await frame.evaluate((element) => {
    const guest = (element as HTMLElement & { contentWindow: Window & typeof globalThis })
      .contentWindow;
    guest.history.go();
    guest.history.go(0);
    guest.history.go(0.9);
    guest.history.go(Number.NaN);
    guest.history.go("x" as unknown as number);
    guest.history.go(undefined);
  });
  await flushTasks(page);
  await page.waitForTimeout(250);
  expect(loads).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as { hostMarker?: boolean }).hostMarker),
  ).toBe(true);
});

test("host-mode history.go still traverses with a coerced delta", async ({ page }) => {
  const frame = await mountHostModeGuest(page, "/documents/guest.html");
  const result = await frame.evaluate(async (element) => {
    const guest = (element as HTMLElement & { contentWindow: Window & typeof globalThis })
      .contentWindow;
    guest.history.pushState(null, "", "/documents/one");
    guest.history.pushState(null, "", "/documents/two");
    const popped = new Promise<void>((resolve) =>
      guest.addEventListener("popstate", () => resolve(), { once: true }),
    );
    guest.history.go("-1.9" as unknown as number);
    await popped;
    return guest.location.pathname;
  });
  expect(result).toBe("/documents/one");
});

test("host-mode pushState and replaceState resolve against the guest base URL", async ({
  page,
}) => {
  const frame = await mountHostModeGuest(page, "/documents/based.html");
  const result = await frame.evaluate((element) => {
    const guest = (element as HTMLElement & { contentWindow: Window & typeof globalThis })
      .contentWindow;
    guest.history.pushState(null, "", "pushed");
    const afterPush = [guest.location.href, location.href];
    guest.history.replaceState(null, "", "replaced");
    return [afterPush, [guest.location.href, location.href]];
  });
  expect(result).toEqual([
    [`${origin}/based-root/pushed`, `${origin}/based-root/pushed`],
    [`${origin}/based-root/replaced`, `${origin}/based-root/replaced`],
  ]);
});

test("rebases an svg a href for the rendered tree while the guest reads its authored value", async ({
  page,
}) => {
  await installBundle(page, origin);
  const frame = await mountFrame(page, {
    src: `${origin}/documents/svg-anchor.html`,
    id: "guest",
  });
  const result = await frame.evaluate((element) => {
    const host = element as HTMLElement & {
      contentWindow: Window & typeof globalThis;
      shadowRoot: ShadowRoot;
    };
    const guestAnchor = host.contentWindow.document.querySelector("svg a")!;
    const rendered = host.shadowRoot.querySelector("svg a")!;
    return {
      authored: guestAnchor.getAttribute("href"),
      // The guest's getAttribute and serializers are virtualized to the authored value;
      // the host page's own getAttribute reads the physical attribute the browser acts on.
      rendered: Element.prototype.getAttribute.call(rendered, "href"),
    };
  });
  expect(result).toEqual({
    authored: "next.html",
    rendered: `${origin}/documents/next.html`,
  });
});

test("connection constructors throw SyntaxError for an unparsable URL; fetch-like APIs keep TypeError", async ({
  page,
}) => {
  const frame = await mountGuest(page);
  const result = await frame.evaluate(async (element) => {
    const guest = (element as HTMLElement & { contentWindow: Window & typeof globalThis })
      .contentWindow;
    const nameOf = (action: () => unknown): string => {
      try {
        action();
        return "none";
      } catch (error) {
        return (error as Error).name;
      }
    };
    const invalid = "http://[";
    return {
      webSocket: nameOf(() => new guest.WebSocket(invalid)),
      eventSource: nameOf(() => new guest.EventSource(invalid)),
      worker: nameOf(() => new guest.Worker(invalid)),
      sharedWorker: nameOf(() => new guest.SharedWorker(invalid)),
      request: nameOf(() => new guest.Request(invalid)),
      sendBeacon: nameOf(() => guest.navigator.sendBeacon(invalid)),
      fetch: await guest.fetch(invalid).then(
        () => "none",
        (error: Error) => error.name,
      ),
    };
  });
  expect(result).toEqual({
    webSocket: "SyntaxError",
    eventSource: "SyntaxError",
    worker: "SyntaxError",
    sharedWorker: "SyntaxError",
    request: "TypeError",
    sendBeacon: "TypeError",
    fetch: "TypeError",
  });
});
