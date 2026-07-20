import { expect, test, type Locator, type Page } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

const nonce = "fixture-nonce";
let fixture: FixtureServer;

const legacyJavaScriptTypes = [
  "text/javascript",
  "application/javascript",
  "text/ecmascript",
  "application/ecmascript",
  "text/jscript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
] as const;

const inertJavaScriptTypes = [
  "text/javascript; charset=utf-8",
  "application/x-javascript; charset=utf-8",
  "application/x-unknown",
] as const;

const documentSource = (body: string, head = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

function reply(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-security-policy": `script-src 'self' 'nonce-${nonce}'; object-src 'none'`,
    "content-type": contentType,
  });
  response.end(body);
}

function pageSource(pathname: string): string | null {
  switch (pathname) {
    case "/module-parse.html":
      return documentSource("<main>parse failure</main>", '<script type="module">export const = 1</script>');
    case "/module-link.html":
      return documentSource("<main>link failure</main>", '<script type="module">import "./missing-module.js";</script>');
    case "/module-evaluation.html":
      return documentSource("<main>evaluation failure</main>", '<script type="module">throw new Error("module evaluation rejected")</script>');
    case "/module-tla.html":
      return documentSource("<main>TLA failure</main>", '<script type="module">await Promise.reject(new Error("module TLA rejected"))</script>');
    case "/blank.html":
      return documentSource('<main id="script-root">Script safety</main>');
    case "/bad-src.html":
      return documentSource('<main id="script-root">Bad src</main><script src="http://["></script><script>window.__afterBadSrc = true;</script>');
    case "/nomodule.html":
      return documentSource(`
        <main id="script-root">Script safety</main>
        <script id="initial-nomodule" nomodule>
          window.__initialNomodule = true;
        </script>
        <script id="initial-classic">
          window.__initialClassic = true;
        </script>
      `);
    case "/legacy-mime.html":
      return documentSource(`
        <main id="script-root">Script safety</main>
        <script>window.__initialLegacyTypes = []; window.__initialInertTypes = [];</script>
        ${legacyJavaScriptTypes.map((type) => `<script type="${type}">window.__initialLegacyTypes.push(${JSON.stringify(type)});</script>`).join("")}
        ${inertJavaScriptTypes.map((type) => `<script type="${type}">window.__initialInertTypes.push(${JSON.stringify(type)});</script>`).join("")}
      `);
    case "/events.html":
      return documentSource(`
        <a id="prevented" href="/prevented-navigation" onclick="window.__inlineHandler = { realm: globalThis === window, event: event instanceof MouseEvent, view: event.view === window, target: event.target === this, currentTarget: event.currentTarget === this }; return false">Prevented</a>
        <a id="stopped" href="/stopped-navigation">Stopped</a>
        <script>
          window.__listenerEvents = [];
          const record = (scope, event) => window.__listenerEvents.push({
            scope,
            event: event instanceof Event,
            mouse: event instanceof MouseEvent,
            view: event.view === window,
            target: event.target.id,
            currentTarget: event.currentTarget === (scope === 'document' ? document : window),
          });
          document.addEventListener('click', (event) => record('document', event));
          window.addEventListener('click', (event) => {
            record('window', event);
            if (event.target.id === 'prevented') event.preventDefault();
          });
          document.addEventListener('realm-document', (event) => {
            window.__documentEvent = {
              event: event instanceof Event,
              target: event.target === document,
              currentTarget: event.currentTarget === document,
            };
          });

          const dynamicAttribute = document.createElement('button');
          dynamicAttribute.id = 'dynamic-attribute';
          dynamicAttribute.setAttribute('onclick', "window.__dynamicAttribute = { realm: globalThis === window, event: event instanceof MouseEvent, view: event.view === window, target: event.target === this, currentTarget: event.currentTarget === this }");
          document.body.append(dynamicAttribute);

          const dynamicProperty = document.createElement('button');
          dynamicProperty.id = 'dynamic-property';
          dynamicProperty.onclick = function (event) {
            window.__dynamicProperty = {
              realm: globalThis === window,
              event: event instanceof MouseEvent,
              view: event.view === window,
              target: event.target === this,
              currentTarget: event.currentTarget === this,
            };
          };
          document.body.append(dynamicProperty);
          document.querySelector('#stopped').addEventListener('click', (event) => event.stopPropagation());
        </script>
      `);
    case "/stopped-navigation":
      return documentSource('<main id="stopped-destination">Stopped propagation still navigated</main>');
    case "/window-events.html":
      return documentSource(`
        <button id="event-target">Dispatch event</button>
        <input id="input-target">
        <a id="blocked-link" href="/blocked-by-window-handler">Blocked link</a>
        <script>
          const state = window.__windowEventFidelity = {
            propagation: [],
            nonBubbling: [],
            firstClickCalls: 0,
            firstInputCalls: 0,
            replacementClickCalls: 0,
            replacementInputCalls: 0,
            hostLifecycleCalls: 0,
          };
          const recordPropagation = (scope) => (event) => state.propagation.push({
            scope,
            event: event instanceof Event,
            mouse: event instanceof MouseEvent,
            currentTarget: event.currentTarget === (scope.startsWith('window') ? window : document),
            eventPhase: event.eventPhase,
          });

          window.addEventListener('click', recordPropagation('window-bubble'));
          document.addEventListener('click', recordPropagation('document-bubble'));
          document.addEventListener('click', recordPropagation('document-capture'), true);
          window.addEventListener('click', recordPropagation('window-capture'), true);

          window.addEventListener('document-only', (event) => {
            event.preventDefault();
            state.nonBubbling.push({
              scope: 'window-capture',
              event: event instanceof Event,
              target: event.target === document,
              currentTarget: event.currentTarget === window,
              eventPhase: event.eventPhase,
              defaultPrevented: event.defaultPrevented,
            });
          }, true);
          window.addEventListener('document-only', () => {
            state.nonBubbling.push({ scope: 'window-bubble' });
          });
          window.addEventListener('v-frame-load', () => state.hostLifecycleCalls += 1);

          const firstClick = () => state.firstClickCalls += 1;
          const replacementClick = function (event) {
            state.replacementClickCalls += 1;
            state.clickHandler = {
              realm: globalThis === window,
              event: event instanceof Event,
              mouse: event instanceof MouseEvent,
              currentTarget: event.currentTarget === window,
              thisValue: this === window,
              eventPhase: event.eventPhase,
            };
          };
          window.onclick = firstClick;
          window.onclick = replacementClick;
          state.clickReplacementVisible = window.onclick === replacementClick;

          const firstInput = () => state.firstInputCalls += 1;
          const replacementInput = function (event) {
            state.replacementInputCalls += 1;
            state.inputHandler = {
              realm: globalThis === window,
              event: event instanceof Event,
              input: event instanceof InputEvent,
              currentTarget: event.currentTarget === window,
              thisValue: this === window,
              eventPhase: event.eventPhase,
            };
          };
          window.oninput = firstInput;
          window.oninput = replacementInput;
          state.inputReplacementVisible = window.oninput === replacementInput;

          window.__dispatchWindowEventChecks = () => {
            document.querySelector('#input-target').dispatchEvent(
              new InputEvent('input', { bubbles: true }),
            );
            state.nonBubblingDispatchResult = document.dispatchEvent(
              new Event('document-only', { cancelable: true }),
            );
          };
          window.__clearWindowHandlers = () => {
            window.onclick = null;
            window.oninput = null;
            state.handlersCleared = window.onclick === null && window.oninput === null;
            document.querySelector('#event-target').click();
            document.querySelector('#input-target').dispatchEvent(
              new InputEvent('input', { bubbles: true }),
            );
          };
          window.__installCancelingWindowClick = () => {
            window.onclick = function (event) {
              state.cancelingHandler = {
                realm: globalThis === window,
                event: event instanceof MouseEvent,
                currentTarget: event.currentTarget === window,
                thisValue: this === window,
                eventPhase: event.eventPhase,
              };
              return false;
            };
            window.addEventListener('click', (event) => {
              state.cancellationObserved = event.defaultPrevented;
            }, { once: true });
          };
        </script>
      `);
    default:
      return null;
  }
}

async function startFixtureServer(): Promise<FixtureServer> {
  const distFile = resolve(process.cwd(), "dist/index.js");
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    if (pathname === "/") {
      reply(response, 200, "text/html", documentSource('<div id="host"></div>'));
      return;
    }
    if (pathname === "/dist/index.js") {
      if (!existsSync(distFile)) {
        reply(response, 404, "text/plain", "Build output not found");
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/javascript",
      });
      createReadStream(distFile).pipe(response);
      return;
    }
    if (pathname === "/late-external.js") {
      reply(
        response,
        200,
        "text/javascript",
        "window.__lateExternal = (window.__lateExternal ?? 0) + 1;",
      );
      return;
    }
    if (pathname === "/fragment-order-first.js") {
      setTimeout(() => {
        reply(
          response,
          200,
          "text/javascript",
          'window.__fragmentExternalEvents.push("first");',
        );
      }, 50);
      return;
    }
    if (pathname === "/fragment-order-second.js") {
      reply(
        response,
        200,
        "text/javascript",
        'window.__fragmentExternalEvents.push("second");',
      );
      return;
    }

    const source = pageSource(pathname);
    if (source !== null) {
      reply(response, 200, "text/html", source);
      return;
    }
    reply(response, 404, "text/plain", `No fixture for ${pathname}`);
  });

  await new Promise<void>((resolveListening) => {
    server.listen(0, "127.0.0.1", resolveListening);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Script safety fixture did not expose a TCP address");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClosed, reject) => {
      server.close((error) => error === undefined ? resolveClosed() : reject(error));
    }),
  };
}

test.beforeAll(async () => {
  fixture = await startFixtureServer();
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

async function mountFrame(page: Page, pathname: string, id = "subject"): Promise<Locator> {
  await page.evaluate(({ frameID, frameNonce, source }) => {
    const frame = document.createElement("v-frame");
    frame.id = frameID;
    frame.setAttribute("nonce", frameNonce);
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
  }, { frameID: id, frameNonce: nonce, source: `${fixture.origin}${pathname}` });
  const frame = page.locator(`v-frame#${id}`);
  await expect.poll(() => frame.evaluate((element) => (element as { status: string }).status)).toBe("ready");
  return frame;
}

async function childValue<T>(
  frame: Locator,
  expression: (window: Window & typeof globalThis) => T,
): Promise<T> {
  return frame.evaluate((element, source) => {
    const evaluate = new Function("window", `return (${source})(window)`);
    return evaluate((element as HTMLElement & { contentWindow: Window | null }).contentWindow);
  }, expression.toString()) as Promise<T>;
}

for (const [name, pathname] of [
  ["parse", "/module-parse.html"],
  ["link", "/module-link.html"],
  ["evaluation", "/module-evaluation.html"],
  ["top-level await", "/module-tla.html"],
] as const) {
  test(`reports an inline module ${name} failure and still becomes ready`, async ({ page }) => {
    await installBundle(page);
    const result = await page.evaluate(async ({ frameNonce, source }) => {
      const frame = document.createElement("v-frame") as HTMLElement & { status: string };
      const failures: Array<{ phase: string; fatal: boolean }> = [];
      frame.setAttribute("nonce", frameNonce);
      frame.addEventListener("v-frame-error", (event) => {
        const detail = (event as CustomEvent<{ phase: string; fatal: boolean }>).detail;
        failures.push({ phase: detail.phase, fatal: detail.fatal });
      });
      const loaded = new Promise<void>((resolve) => {
        frame.addEventListener("v-frame-load", () => resolve(), { once: true });
      });
      frame.setAttribute("src", source);
      document.querySelector("#host")?.append(frame);
      await loaded;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { failures, status: frame.status };
    }, { frameNonce: nonce, source: `${fixture.origin}${pathname}` });

    expect(result).toEqual({
      failures: [{ phase: "script", fatal: false }],
      status: "ready",
    });
  });
}

test("reports an unresolvable script source as an Error without failing the load", async ({ page }) => {
  await installBundle(page);
  const result = await page.evaluate(async ({ frameNonce, source }) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      status: string;
      contentWindow: (Window & { __afterBadSrc?: boolean }) | null;
    };
    const failures: Array<{ phase: string; fatal: boolean; isError: boolean }> = [];
    frame.setAttribute("nonce", frameNonce);
    frame.addEventListener("v-frame-error", (event) => {
      const detail = (event as CustomEvent<{ phase: string; fatal: boolean; error: unknown }>).detail;
      failures.push({
        phase: detail.phase,
        fatal: detail.fatal,
        isError: detail.error instanceof Error,
      });
    });
    const loaded = new Promise<void>((resolve) => {
      frame.addEventListener("v-frame-load", () => resolve(), { once: true });
    });
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
    await loaded;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      failures,
      status: frame.status,
      ranFollowing: frame.contentWindow?.__afterBadSrc === true,
    };
  }, { frameNonce: nonce, source: `${fixture.origin}/bad-src.html` });

  expect(result).toEqual({
    failures: [{ phase: "script", fatal: false, isError: true }],
    status: "ready",
    ranFollowing: true,
  });
});

test("routes late and cloned dynamic scripts through the child runner only", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "/blank.html");

  const immediate = await childValue(frame, (window) => {
    const document = window.document;
    const lateText = document.createElement("script");
    document.body.append(lateText);
    lateText.text = "window.__lateText = (window.__lateText ?? 0) + 1";

    const lateExternal = document.createElement("script");
    document.body.append(lateExternal);
    lateExternal.src = "/late-external.js";

    const lateTyped = document.createElement("script");
    document.body.append(lateTyped);
    lateTyped.type = "text/javascript";
    lateTyped.text = "window.__lateTyped = (window.__lateTyped ?? 0) + 1";

    const cloneSource = document.createElement("script");
    cloneSource.text = "window.__eligibleClone = (window.__eligibleClone ?? 0) + 1";
    const eligibleClone = cloneSource.cloneNode(true) as HTMLScriptElement;
    document.body.append(eligibleClone);

    const executedSource = document.createElement("script");
    executedSource.text = "window.__executedSource = (window.__executedSource ?? 0) + 1";
    document.body.append(executedSource);
    document.body.append(executedSource.cloneNode(true));

    const parsedContainer = document.createElement("div");
    parsedContainer.innerHTML = '<script>window.__parsedScript = true</script>';
    document.body.append(parsedContainer);
    document.body.append(parsedContainer.querySelector("script")!.cloneNode(true));

    return {
      lateText: (window as typeof window & { __lateText?: number }).__lateText,
      lateTyped: (window as typeof window & { __lateTyped?: number }).__lateTyped,
      eligibleClone: (window as typeof window & { __eligibleClone?: number }).__eligibleClone,
      executedSource: (window as typeof window & { __executedSource?: number }).__executedSource,
      parsedScript: "__parsedScript" in window,
      logicalCloneType: eligibleClone.getAttribute("type"),
    };
  });

  expect(immediate).toEqual({
    lateText: 1,
    lateTyped: 1,
    eligibleClone: 1,
    executedSource: 1,
    parsedScript: false,
    logicalCloneType: null,
  });
  await expect.poll(() => childValue(frame, (window) =>
    (window as typeof window & { __lateExternal?: number }).__lateExternal,
  )).toBe(1);
  expect(await page.evaluate(() => ({
    lateText: "__lateText" in window,
    lateExternal: "__lateExternal" in window,
    lateTyped: "__lateTyped" in window,
    eligibleClone: "__eligibleClone" in window,
    executedSource: "__executedSource" in window,
    parsedScript: "__parsedScript" in window,
  }))).toEqual({
    lateText: false,
    lateExternal: false,
    lateTyped: false,
    eligibleClone: false,
    executedSource: false,
    parsedScript: false,
  });
});

test("executes eligible scripts inserted through fragments once in document order", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "/blank.html");

  const immediate = await frame.evaluate((element) => {
    const childWindow = (element as HTMLElement & { contentWindow: Window | null })
      .contentWindow as Window & typeof globalThis & {
        __fragmentEvents: string[];
        __fragmentExternalEvents: string[];
        __parsedFragmentScript?: boolean;
        __foreignFragmentScript?: boolean;
      };
    const childDocument = childWindow.document;
    childWindow.__fragmentEvents = [];
    childWindow.__fragmentExternalEvents = [];
    const createScript = (name: string) => {
      const script = childDocument.createElement("script");
      script.text = `window.__fragmentEvents.push(${JSON.stringify(name)});`;
      return script;
    };

    const appendChildFragment = childDocument.createDocumentFragment();
    const nested = childDocument.createElement("section");
    nested.append(createScript("append-child-nested"));
    const parsedContainer = childDocument.createElement("div");
    parsedContainer.innerHTML = "<script>window.__parsedFragmentScript = true</script>";
    appendChildFragment.append(
      createScript("append-child-first"),
      nested,
      parsedContainer.querySelector("script")!,
    );
    childDocument.body.appendChild(appendChildFragment);

    const appendFragment = childDocument.createDocumentFragment();
    appendFragment.append(createScript("append"));
    childDocument.body.append(appendFragment);

    const prependFragment = childDocument.createDocumentFragment();
    prependFragment.append(createScript("prepend"));
    childDocument.body.prepend(prependFragment);

    const insertReference = childDocument.createElement("div");
    childDocument.body.append(insertReference);
    const insertFragment = childDocument.createDocumentFragment();
    insertFragment.append(createScript("insert-before"));
    childDocument.body.insertBefore(insertFragment, insertReference);

    const replaceTarget = childDocument.createElement("div");
    childDocument.body.append(replaceTarget);
    const replaceFragment = childDocument.createDocumentFragment();
    replaceFragment.append(createScript("replace-child"));
    childDocument.body.replaceChild(replaceFragment, replaceTarget);

    const replaceWithTarget = childDocument.createElement("div");
    childDocument.body.append(replaceWithTarget);
    const replaceWithFragment = childDocument.createDocumentFragment();
    replaceWithFragment.append(createScript("replace-with"));
    replaceWithTarget.replaceWith(replaceWithFragment);

    const replaceChildrenTarget = childDocument.createElement("div");
    replaceChildrenTarget.append(childDocument.createElement("span"));
    childDocument.body.append(replaceChildrenTarget);
    const replaceChildrenFragment = childDocument.createDocumentFragment();
    replaceChildrenFragment.append(createScript("replace-children"));
    replaceChildrenTarget.replaceChildren(replaceChildrenFragment);

    const externalFragment = childDocument.createDocumentFragment();
    for (const source of ["/fragment-order-first.js", "/fragment-order-second.js"]) {
      const script = childDocument.createElement("script");
      script.async = false;
      script.src = source;
      externalFragment.append(script);
    }
    childDocument.body.append(externalFragment);

    const foreignFragment = childDocument.createDocumentFragment();
    const foreignScript = document.createElement("script");
    foreignScript.text = "window.__foreignFragmentScript = true";
    foreignFragment.append(foreignScript);
    childDocument.body.append(foreignFragment);

    return {
      events: childWindow.__fragmentEvents,
      fragmentsEmptied: [
        appendChildFragment,
        appendFragment,
        prependFragment,
        insertFragment,
        replaceFragment,
        replaceWithFragment,
        replaceChildrenFragment,
        externalFragment,
        foreignFragment,
      ].every((fragment) => fragment.childNodes.length === 0),
      parsedRan: childWindow.__parsedFragmentScript === true,
      foreignRanInChild: childWindow.__foreignFragmentScript === true,
      foreignRanInHost: "__foreignFragmentScript" in window,
    };
  });

  expect(immediate).toEqual({
    events: [
      "append-child-first",
      "append-child-nested",
      "append",
      "prepend",
      "insert-before",
      "replace-child",
      "replace-with",
      "replace-children",
    ],
    fragmentsEmptied: true,
    parsedRan: false,
    foreignRanInChild: false,
    foreignRanInHost: false,
  });
  await expect.poll(() => childValue(frame, (window) =>
    (window as typeof window & { __fragmentExternalEvents: string[] })
      .__fragmentExternalEvents,
  )).toEqual(["first", "second"]);
  expect(await page.evaluate(() => "__fragmentEvents" in window)).toBe(false);
});

test("executes every browser-recognized legacy JavaScript MIME alias initially", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "/legacy-mime.html");

  expect(await childValue(frame, (window) => ({
    executed: (window as typeof window & { __initialLegacyTypes: string[] }).__initialLegacyTypes,
    inert: (window as typeof window & { __initialInertTypes: string[] }).__initialInertTypes,
  }))).toEqual({ executed: [...legacyJavaScriptTypes], inert: [] });
  expect(await page.evaluate(() => ({
    executed: "__initialLegacyTypes" in window,
    inert: "__initialInertTypes" in window,
  }))).toEqual({ executed: false, inert: false });
});

test("executes every browser-recognized legacy JavaScript MIME alias dynamically", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "/blank.html");

  const state = await frame.evaluate((element, options) => {
    const childWindow = (element as HTMLElement & { contentWindow: Window | null }).contentWindow as Window & {
      __dynamicLegacyTypes?: string[];
      __dynamicInertTypes?: string[];
    };
    const childDocument = childWindow.document;
    childWindow.__dynamicLegacyTypes = [];
    childWindow.__dynamicInertTypes = [];
    for (const type of options.legacy) {
      const script = childDocument.createElement("script");
      script.type = type;
      script.text = `window.__dynamicLegacyTypes.push(${JSON.stringify(type)});`;
      childDocument.body.append(script);
    }
    for (const type of options.inert) {
      const script = childDocument.createElement("script");
      script.type = type;
      script.text = `window.__dynamicInertTypes.push(${JSON.stringify(type)});`;
      childDocument.body.append(script);
    }
    return {
      executed: childWindow.__dynamicLegacyTypes,
      inert: childWindow.__dynamicInertTypes,
    };
  }, { legacy: [...legacyJavaScriptTypes], inert: [...inertJavaScriptTypes] });

  expect(state).toEqual({ executed: [...legacyJavaScriptTypes], inert: [] });
  expect(await page.evaluate(() => ({
    executed: "__dynamicLegacyTypes" in window,
    inert: "__dynamicInertTypes" in window,
  }))).toEqual({ executed: false, inert: false });
});

test("keeps initial nomodule scripts logical without executing them in either realm", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "/nomodule.html");

  expect(await childValue(frame, (window) => {
    const script = window.document.querySelector("#initial-nomodule") as HTMLScriptElement | null;
    return {
      present: script !== null,
      attribute: script?.getAttribute("nomodule"),
      property: script?.noModule,
      nomoduleRan: "__initialNomodule" in window,
      classicRan: "__initialClassic" in window,
    };
  })).toEqual({
    present: true,
    attribute: "",
    property: true,
    nomoduleRan: false,
    classicRan: true,
  });
  expect(await page.evaluate(() => ({
    nomoduleRan: "__initialNomodule" in window,
    classicRan: "__initialClassic" in window,
  }))).toEqual({ nomoduleRan: false, classicRan: false });
});

test("keeps dynamically created nomodule scripts logical without executing them in either realm", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "/blank.html");

  const state = await childValue(frame, (window) => {
    const attributeScript = window.document.createElement("script");
    attributeScript.id = "dynamic-nomodule-attribute";
    attributeScript.setAttribute("nomodule", "");
    attributeScript.text = "window.__dynamicNomoduleAttribute = true";
    window.document.body.append(attributeScript);

    const propertyScript = window.document.createElement("script");
    propertyScript.id = "dynamic-nomodule-property";
    propertyScript.noModule = true;
    propertyScript.text = "window.__dynamicNomoduleProperty = true";
    window.document.body.append(propertyScript);

    return {
      attribute: {
        present: window.document.querySelector("#dynamic-nomodule-attribute") !== null,
        value: attributeScript.noModule,
        ran: "__dynamicNomoduleAttribute" in window,
      },
      property: {
        present: window.document.querySelector("#dynamic-nomodule-property") !== null,
        value: propertyScript.noModule,
        attribute: propertyScript.getAttribute("nomodule"),
        ran: "__dynamicNomoduleProperty" in window,
      },
    };
  });

  expect(state).toEqual({
    attribute: { present: true, value: true, ran: false },
    property: { present: true, value: true, attribute: "", ran: false },
  });
  expect(await page.evaluate(() => ({
    attributeRan: "__dynamicNomoduleAttribute" in window,
    propertyRan: "__dynamicNomoduleProperty" in window,
  }))).toEqual({ attributeRan: false, propertyRan: false });
});

test("runs declarative and property event handlers in the child realm", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "/events.html");

  await frame.locator("#prevented").click();
  await frame.locator("#dynamic-attribute").click();
  await frame.locator("#dynamic-property").click();
  const state = await childValue(frame, (window) => ({
    inline: (window as typeof window & { __inlineHandler?: unknown }).__inlineHandler,
    dynamicAttribute: (window as typeof window & { __dynamicAttribute?: unknown }).__dynamicAttribute,
    dynamicProperty: (window as typeof window & { __dynamicProperty?: unknown }).__dynamicProperty,
  }));

  const expectedHandlerState = {
    realm: true,
    event: true,
    view: true,
    target: true,
    currentTarget: true,
  };
  expect(state).toEqual({
    inline: expectedHandlerState,
    dynamicAttribute: expectedHandlerState,
    dynamicProperty: expectedHandlerState,
  });
  expect(await page.evaluate(() => ({
    inline: "__inlineHandler" in window,
    dynamicAttribute: "__dynamicAttribute" in window,
    dynamicProperty: "__dynamicProperty" in window,
  }))).toEqual({ inline: false, dynamicAttribute: false, dynamicProperty: false });
});

test("preserves the logical window event path and window handler properties", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "/window-events.html");
  await frame.evaluate((element) => {
    (element as HTMLElement & { navigations: string[] }).navigations = [];
    element.addEventListener("v-frame-navigate", (event) => {
      (element as HTMLElement & { navigations: string[] }).navigations.push(
        (event as CustomEvent<{ to: string }>).detail.to,
      );
    });
  });

  await frame.locator("#event-target").click();
  const initialState = await childValue(frame, (window) => {
    (window as typeof window & { __dispatchWindowEventChecks(): void })
      .__dispatchWindowEventChecks();
    return (window as typeof window & { __windowEventFidelity: unknown })
      .__windowEventFidelity;
  });

  expect(initialState).toMatchObject({
    propagation: [
      {
        scope: "window-capture",
        event: true,
        mouse: true,
        currentTarget: true,
        eventPhase: 1,
      },
      {
        scope: "document-capture",
        event: true,
        mouse: true,
        currentTarget: true,
        eventPhase: 1,
      },
      {
        scope: "document-bubble",
        event: true,
        mouse: true,
        currentTarget: true,
        eventPhase: 3,
      },
      {
        scope: "window-bubble",
        event: true,
        mouse: true,
        currentTarget: true,
        eventPhase: 3,
      },
    ],
    nonBubbling: [{
      scope: "window-capture",
      event: true,
      target: true,
      currentTarget: true,
      eventPhase: 1,
      defaultPrevented: true,
    }],
    nonBubblingDispatchResult: false,
    firstClickCalls: 0,
    firstInputCalls: 0,
    replacementClickCalls: 1,
    replacementInputCalls: 1,
    hostLifecycleCalls: 0,
    clickReplacementVisible: true,
    inputReplacementVisible: true,
    clickHandler: {
      realm: true,
      event: true,
      mouse: true,
      currentTarget: true,
      thisValue: true,
      eventPhase: 3,
    },
    inputHandler: {
      realm: true,
      event: true,
      input: true,
      currentTarget: true,
      thisValue: true,
      eventPhase: 3,
    },
  });

  const clearedState = await childValue(frame, (window) => {
    const childWindow = window as typeof window & {
      __clearWindowHandlers(): void;
      __installCancelingWindowClick(): void;
      __windowEventFidelity: unknown;
    };
    childWindow.__clearWindowHandlers();
    childWindow.__installCancelingWindowClick();
    return childWindow.__windowEventFidelity;
  });
  expect(clearedState).toMatchObject({
    handlersCleared: true,
    replacementClickCalls: 1,
    replacementInputCalls: 1,
  });

  await frame.locator("#blocked-link").click();
  await page.waitForTimeout(20);
  const canceledState = await childValue(frame, (window) =>
    (window as typeof window & { __windowEventFidelity: unknown }).__windowEventFidelity
  );
  expect(canceledState).toMatchObject({
    cancelingHandler: {
      realm: true,
      event: true,
      currentTarget: true,
      thisValue: true,
      eventPhase: 3,
    },
    cancellationObserved: true,
  });
  expect(await frame.evaluate((element) =>
    (element as HTMLElement & { navigations: string[] }).navigations
  )).toEqual([]);
});

test("cancels navigation only when child event listeners prevent the default", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "/events.html");
  await frame.evaluate((element) => {
    (element as HTMLElement & { navigations: Array<{ from: string; to: string }> }).navigations = [];
    element.addEventListener("v-frame-navigate", (event) => {
      const detail = (event as CustomEvent<{ from: string; to: string }>).detail;
      (element as HTMLElement & {
        navigations: Array<{ from: string; to: string }>;
      }).navigations.push({ from: detail.from, to: detail.to });
    });
  });
  const hostURL = page.url();

  await frame.locator("#prevented").click();
  const state = await childValue(frame, async (window) => {
    window.document.dispatchEvent(new window.Event("realm-document"));
    return {
      events: (window as typeof window & { __listenerEvents: unknown[] }).__listenerEvents,
      documentEvent: (window as typeof window & { __documentEvent: unknown }).__documentEvent,
    };
  });

  expect(state).toEqual({
    events: [
      {
        scope: "document",
        event: true,
        mouse: true,
        view: true,
        target: "prevented",
        currentTarget: true,
      },
      {
        scope: "window",
        event: true,
        mouse: true,
        view: true,
        target: "prevented",
        currentTarget: true,
      },
    ],
    documentEvent: { event: true, target: true, currentTarget: true },
  });
  await frame.locator("#stopped").click();
  await expect(frame.locator("#stopped-destination")).toHaveText(
    "Stopped propagation still navigated",
  );
  await expect.poll(() => frame.evaluate(
    (element) => (element as HTMLElement & { currentURL: string }).currentURL,
  )).toBe(`${fixture.origin}/stopped-navigation`);
  expect(await frame.evaluate((element) =>
    (element as HTMLElement & { navigations: Array<{ from: string; to: string }> }).navigations,
  )).toEqual([{
    from: `${fixture.origin}/events.html`,
    to: `${fixture.origin}/stopped-navigation`,
  }]);
  expect(page.url()).toBe(hostURL);
});
