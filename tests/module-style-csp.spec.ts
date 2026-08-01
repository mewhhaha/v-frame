import { expect, test, type Locator, type Page } from "@playwright/test";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";

interface FixtureServer {
  origin: string;
  close(): Promise<void>;
}

const nonce = "module-style-csp-nonce";
const nextNonce = "module-style-csp-next-nonce";
const contentSecurityPolicy = `script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}' 'nonce-${nextNonce}'; object-src 'none'`;
const trustedTypesContentSecurityPolicy = `${contentSecurityPolicy}; trusted-types v-frame-test; require-trusted-types-for 'script'`;
let fixture: FixtureServer;

function html(body: string, head = ""): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

function reply(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  responseContentSecurityPolicy?: string,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": contentType,
    ...(responseContentSecurityPolicy === undefined ? {} : {
      "content-security-policy": responseContentSecurityPolicy,
    }),
  });
  response.end(body);
}

function documentSource(pathname: string): string | undefined {
  switch (pathname) {
    case "/documents/external-module.html":
      return html(
        '<output id="module-result">pending</output><script id="external-module" type="module" src="../modules/entry.js"></script>',
      );
    case "/documents/external-module-fetch-failure.html":
      return html('<script type="module" src="../modules/missing.js"></script>');
    case "/documents/external-module-link-failure.html":
      return html('<script type="module" src="../modules/link-failure.js"></script>');
    case "/documents/external-module-evaluation-failure.html":
      return html('<script type="module" src="../modules/evaluation-failure.js"></script>');
    case "/documents/nonce-styles.html":
      return html(
        `<p id="initial-inline">initial inline</p>
          <p id="source-inline" data-literal="quoted > <style> style=" style="color: rgb(61, 62, 63)">source inline</p>
          <p id="imported">imported</p><p id="linked">linked</p><p id="dynamic">dynamic</p>
          <textarea id="literal-text"><style> style=</textarea>
          <!-- literal comment: <style> style= -->
          <script id="literal-script" type="application/json">{"literal":"<style> style="}</script>`,
        `<style id="initial-style">@import url("../styles/imported.css"); #initial-inline { --style-literal: "<style> & style="; color: rgb(11, 12, 13); } #cascade-style-target { color: rgb(141, 142, 143); } #cascade-important-target { color: rgb(171, 172, 173) !important; }</style><link rel="stylesheet" href="../styles/linked.css">`,
      );
    case "/documents/trusted-types.html":
      return html(
        `<output id="trusted-html">Trusted source</output>
          <button id="trusted-handler" onclick="this.dataset.inlineHandler = 'ran'">Run handler</button>
          <script src="../modules/trusted-types.js"></script>
          <script>document.body.insertAdjacentHTML("beforeend", '<output id="trusted-fragment">Trusted source</output>');</script>`,
      );
    default:
      return undefined;
  }
}

function moduleSource(pathname: string): string | undefined {
  switch (pathname) {
    case "/modules/entry.js":
      return `import { dependencyRealm } from "./dependency.js";
window.__externalModuleEvents = ["entry-start:" + document.readyState];
await new Promise((resolve) => setTimeout(resolve, 25));
window.__externalModuleEvents.push("entry-after-await:" + document.readyState);
window.__externalModuleState = {
  dependencyRealm,
  currentScriptIsNull: document.currentScript === null,
  realm: globalThis === window,
};
document.querySelector("#module-result").textContent = "module settled";
window.addEventListener("load", () => window.__externalModuleEvents.push("load:" + document.readyState));`;
    case "/modules/dependency.js":
      return "export const dependencyRealm = globalThis === window;";
    case "/modules/link-failure.js":
      return 'import "./missing-dependency.js";';
    case "/modules/evaluation-failure.js":
      return 'throw new Error("external module evaluation failure");';
    case "/modules/trusted-types.js":
      return 'document.querySelector("#trusted-html").dataset.externalScript = "ran";';
    default:
      return undefined;
  }
}

function stylesheetSource(pathname: string): string | undefined {
  switch (pathname) {
    case "/styles/imported.css":
      return "#imported { color: rgb(21, 22, 23); }";
    case "/styles/linked.css":
      return "#linked { color: rgb(31, 32, 33); }";
    default:
      return undefined;
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClosed, reject) => {
    server.close((error) => error === undefined ? resolveClosed() : reject(error));
  });
}

async function startFixtureServer(): Promise<FixtureServer> {
  const bundle = resolve(process.cwd(), "dist/index.js");
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture.invalid").pathname;
    if (pathname === "/") {
      reply(
        response,
        200,
        "text/html",
        html(
          '<div id="host"></div><script type="module" nonce="module-style-csp-nonce">import { defineVFrame } from "/dist/index.js"; defineVFrame();</script>',
        ),
        contentSecurityPolicy,
      );
      return;
    }
    if (pathname === "/trusted-types") {
      reply(
        response,
        200,
        "text/html",
        html(
          '<div id="host"></div><script type="module" nonce="module-style-csp-nonce">import { defineVFrame } from "/dist/index.js"; defineVFrame();</script>',
        ),
        trustedTypesContentSecurityPolicy,
      );
      return;
    }
    if (pathname === "/dist/index.js") {
      if (!existsSync(bundle)) {
        reply(response, 404, "text/plain", "Build output not found");
        return;
      }
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/javascript",
      });
      createReadStream(bundle).pipe(response);
      return;
    }

    const document = documentSource(pathname);
    if (document !== undefined) {
      reply(response, 200, "text/html", document);
      return;
    }
    const module = moduleSource(pathname);
    if (module !== undefined) {
      reply(response, 200, "text/javascript", module);
      return;
    }
    const stylesheet = stylesheetSource(pathname);
    if (stylesheet !== undefined) {
      reply(response, 200, "text/css", stylesheet);
      return;
    }
    reply(response, 404, "text/plain", `No fixture for ${pathname}`);
  });

  await new Promise<void>((resolveListening) => server.listen(0, "127.0.0.1", resolveListening));
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("Module and CSP fixture did not expose a TCP address");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
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
  await expect.poll(() => page.evaluate(() => Boolean(customElements.get("v-frame")))).toBe(true);
}

async function mountFrame(page: Page, pathname: string): Promise<Locator> {
  await page.evaluate(({ frameNonce, source }) => {
    const frame = document.createElement("v-frame") as HTMLElement & { src: string };
    frame.nonce = frameNonce;
    frame.src = source;
    document.querySelector("#host")?.append(frame);
  }, { frameNonce: nonce, source: `${fixture.origin}${pathname}` });
  return page.locator("v-frame");
}

async function childValue<T>(
  frame: Locator,
  expression: (window: Window & typeof globalThis) => T,
): Promise<T> {
  return frame.evaluate((element, source) => {
    const evaluate = new Function("window", `return (${source})(window)`);
    return evaluate((element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }).contentWindow);
  }, expression.toString()) as Promise<T>;
}

test("runs an external module with a relative import and top-level await before load in its child realm", async ({ page }) => {
  await installBundle(page);
  const frame = await mountFrame(page, "/documents/external-module.html");

  await expect.poll(() => frame.evaluate((element: HTMLElement & { status: string }) => element.status)).toBe("ready");
  await expect(frame.locator("#module-result")).toHaveText("module settled");
  expect(await childValue(frame, (window) => ({
    events: (window as typeof window & { __externalModuleEvents?: string[] }).__externalModuleEvents,
    state: (window as typeof window & {
      __externalModuleState?: {
        dependencyRealm: boolean;
        currentScriptIsNull: boolean;
        realm: boolean;
      };
    }).__externalModuleState,
  }))).toEqual({
    events: ["entry-start:interactive", "entry-after-await:interactive", "load:complete"],
    state: {
      dependencyRealm: true,
      currentScriptIsNull: true,
      realm: true,
    },
  });
  expect(await page.evaluate(() => "__externalModuleState" in window)).toBe(false);
});

test("loads documents and scripts through an explicit Trusted Types policy", async ({ page }) => {
  await page.goto(`${fixture.origin}/trusted-types`);
  await expect.poll(() => page.evaluate(() => Boolean(customElements.get("v-frame")))).toBe(true);

  const frame = page.locator("v-frame");
  await page.evaluate(({ frameNonce, source }) => {
    const element = document.createElement("v-frame") as HTMLElement & {
      nonce: string;
      src: string;
      trustedTypesPolicy: {
        name: string;
        createHTML(source: string): string;
        createScript(source: string): string;
        createScriptURL(source: string): string;
      };
    };
    element.nonce = frameNonce;
    element.trustedTypesPolicy = {
      name: "v-frame-test",
      createHTML: (htmlSource) => htmlSource.replaceAll(
        "Trusted source",
        "Trusted HTML policy applied",
      ),
      createScript: (scriptSource) => `${scriptSource}\n;globalThis.__trustedScriptPolicyApplied = true;`,
      createScriptURL: (scriptURL) => scriptURL,
    };
    element.src = source;
    document.querySelector("#host")?.append(element);
  }, {
    frameNonce: nonce,
    source: `${fixture.origin}/documents/trusted-types.html`,
  });

  await expect.poll(() => frame.evaluate(
    (element: HTMLElement & { status: string }) => element.status,
  )).toBe("ready");
  await expect(frame.locator("#trusted-html")).toHaveText("Trusted HTML policy applied");
  await expect(frame.locator("#trusted-fragment")).toHaveText("Trusted HTML policy applied");
  await frame.locator("#trusted-handler").click();
  expect(await childValue(frame, (window) => ({
    externalScript: window.document.querySelector("#trusted-html")?.getAttribute(
      "data-external-script",
    ),
    trustedScriptPolicyApplied: (
      window as typeof window & { __trustedScriptPolicyApplied?: boolean }
    ).__trustedScriptPolicyApplied,
    inlineHandler: window.document.querySelector("#trusted-handler")?.getAttribute(
      "data-inline-handler",
    ),
  }))).toEqual({
    externalScript: "ran",
    trustedScriptPolicyApplied: true,
    inlineHandler: "ran",
  });
});

test("uses a named identity Trusted Types policy without callback boilerplate", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "chromium", "Trusted Types enforcement is unavailable");
  await page.goto(`${fixture.origin}/trusted-types`);
  await expect.poll(() => page.evaluate(() => Boolean(customElements.get("v-frame")))).toBe(true);

  const frame = page.locator("v-frame");
  await page.evaluate(({ frameNonce, source }) => {
    const element = document.createElement("v-frame") as HTMLElement & {
      nonce: string;
      src: string;
      trustedTypesPolicy: string;
    };
    element.nonce = frameNonce;
    element.trustedTypesPolicy = "v-frame-test";
    element.src = source;
    document.querySelector("#host")?.append(element);
  }, {
    frameNonce: nonce,
    source: `${fixture.origin}/documents/trusted-types.html`,
  });

  await expect.poll(() => frame.evaluate(
    (element: HTMLElement & { status: string }) => element.status,
  )).toBe("ready");
  await expect(frame.locator("#trusted-html")).toHaveText("Trusted source");
  await expect(frame.locator("#trusted-fragment")).toHaveText("Trusted source");
});

test("reports a fatal bootstrap error when Trusted Types enforcement has no policy", async ({
  browserName,
  page,
}) => {
  test.skip(browserName !== "chromium", "Trusted Types enforcement is unavailable");
  await page.goto(`${fixture.origin}/trusted-types`);
  await expect.poll(() => page.evaluate(() => Boolean(customElements.get("v-frame")))).toBe(true);

  const failure = await page.evaluate(async ({ frameNonce, source }) => {
    const frame = document.createElement("v-frame") as HTMLElement & {
      nonce: string;
      src: string;
      status: string;
    };
    frame.nonce = frameNonce;
    const failed = new Promise<{ phase: string; fatal: boolean; errorName: string }>(
      (resolveFailed) => {
        frame.addEventListener("v-frame-error", (event) => {
          const detail = (event as CustomEvent<{
            phase: string;
            fatal: boolean;
            error: { name?: string };
          }>).detail;
          resolveFailed({
            phase: detail.phase,
            fatal: detail.fatal,
            errorName: detail.error.name ?? "",
          });
        }, { once: true });
      },
    );
    frame.src = source;
    document.querySelector("#host")?.append(frame);
    return { ...await failed, status: frame.status };
  }, {
    frameNonce: nonce,
    source: `${fixture.origin}/documents/trusted-types.html`,
  });

  expect(failure).toEqual({
    phase: "bootstrap",
    fatal: true,
    errorName: "TypeError",
    status: "error",
  });
});

for (const [name, pathname] of [
  ["fetch", "/documents/external-module-fetch-failure.html"],
  ["link", "/documents/external-module-link-failure.html"],
  ["evaluation", "/documents/external-module-evaluation-failure.html"],
] as const) {
  test(`reports one nonfatal external module ${name} failure and becomes ready`, async ({ page }) => {
    await installBundle(page);
    const result = await page.evaluate(async ({ frameNonce, source }) => {
      const frame = document.createElement("v-frame") as HTMLElement & { src: string; status: string };
      const failures: Array<{ phase: string; fatal: boolean }> = [];
      frame.nonce = frameNonce;
      frame.addEventListener("v-frame-error", (event) => {
        const detail = (event as CustomEvent<{ phase: string; fatal: boolean }>).detail;
        failures.push({ phase: detail.phase, fatal: detail.fatal });
      });
      const loaded = new Promise<void>((resolveLoaded) => {
        frame.addEventListener("v-frame-load", () => resolveLoaded(), { once: true });
      });
      frame.src = source;
      document.querySelector("#host")?.append(frame);
      await loaded;
      return { failures, status: frame.status };
    }, { frameNonce: nonce, source: `${fixture.origin}${pathname}` });

    expect(result).toEqual({
      failures: [{ phase: "script", fatal: false }],
      status: "ready",
    });
  });
}

test("uses the frame nonce for initial, linked, imported, and changing dynamic styles under a nonce-only CSP", async ({ page }) => {
  const cspViolations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|\bcsp\b/i.test(message.text())) {
      cspViolations.push(message.text());
    }
  });

  await installBundle(page);
  const frame = await mountFrame(page, "/documents/nonce-styles.html");
  await expect.poll(() => frame.evaluate((element: HTMLElement & { status: string }) => element.status)).toBe("ready");

  await expect(frame.locator("#initial-inline")).toHaveCSS("color", "rgb(11, 12, 13)");
  await expect(frame.locator("#source-inline")).toHaveCSS("color", "rgb(61, 62, 63)");
  await expect(frame.locator("#imported")).toHaveCSS("color", "rgb(21, 22, 23)");
  await expect(frame.locator("#linked")).toHaveCSS("color", "rgb(31, 32, 33)");
  expect(await childValue(frame, (window) => ({
    initialNonce: (window.document.querySelector("#initial-style") as HTMLStyleElement | null)?.nonce,
    linkedNonce: (window.document.querySelector("style[data-v-frame-source]") as HTMLStyleElement | null)?.nonce,
    stylesheetLiteral: window.document.querySelector("#initial-style")?.textContent.includes("<style> & style="),
    attributeLiteral: window.document.querySelector("#source-inline")?.getAttribute("data-literal"),
    textLiteral: (window.document.querySelector("#literal-text") as HTMLTextAreaElement | null)?.value,
    scriptLiteral: window.document.querySelector("#literal-script")?.textContent,
    commentLiteral: window.document.createTreeWalker(
      window.document.body,
      window.NodeFilter.SHOW_COMMENT,
    ).nextNode()?.textContent,
  }))).toEqual({
    initialNonce: nonce,
    linkedNonce: nonce,
    stylesheetLiteral: true,
    attributeLiteral: "quoted > <style> style=",
    textLiteral: "<style> style=",
    scriptLiteral: '{"literal":"<style> style="}',
    commentLiteral: " literal comment: <style> style= ",
  });
  expect(await frame.evaluate((element) => (
    element.shadowRoot?.querySelector(
      "style[data-v-frame-inline-styles]",
    ) as HTMLStyleElement | null
  )?.nonce)).toBe(nonce);
  expect(cspViolations).toEqual([]);

  await childValue(frame, (window) => {
    const style = window.document.createElement("style");
    style.id = "dynamic-style";
    style.textContent = "#dynamic { color: rgb(41, 42, 43); }";
    window.document.head.append(style);
  });
  await expect(frame.locator("#dynamic")).toHaveCSS("color", "rgb(41, 42, 43)");

  await childValue(frame, (window) => {
    const style = window.document.querySelector("#dynamic-style") as HTMLStyleElement;
    style.textContent = "#dynamic { color: rgb(51, 52, 53); }";
  });
  await expect(frame.locator("#dynamic")).toHaveCSS("color", "rgb(51, 52, 53)");
  expect(await childValue(frame, (window) =>
    (window.document.querySelector("#dynamic-style") as HTMLStyleElement | null)?.nonce,
  )).toBe(nonce);
  expect(cspViolations).toEqual([]);
});

test("facades inline style attributes and CSSOM through the nonce stylesheet", async ({ page }) => {
  const consoleViolations: string[] = [];

  await installBundle(page);
  const frame = await mountFrame(page, "/documents/nonce-styles.html");
  await expect.poll(() => frame.evaluate((element: HTMLElement & { status: string }) => element.status)).toBe("ready");

  await page.evaluate(() => {
    const foreignDocument = document.implementation.createHTMLDocument("");
    const foreign = foreignDocument.createElement("div");
    foreign.id = "foreign-style-target";
    foreign.setAttribute(
      "style",
      'color: rgb(111, 112, 113); background-image: url("foreign.png")',
    );
    const adopted = foreignDocument.createElement("div");
    adopted.id = "adopted-style-target";
    adopted.setAttribute("style", "color: rgb(121, 122, 123)");
    (window as typeof window & {
      __foreignStyleNodes?: { foreign: HTMLElement; adopted: HTMLElement };
    }).__foreignStyleNodes = { foreign, adopted };
  });
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|\bcsp\b/i.test(message.text())) {
      consoleViolations.push(message.text());
    }
  });
  await page.evaluate(() => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.violatedDirective}:${event.blockedURI}`);
    });
    (window as typeof window & { __styleCSPViolations?: string[] }).__styleCSPViolations = violations;
  });

  const initialStyle = await childValue(frame, (window) => {
    const element = window.document.querySelector("#source-inline") as HTMLElement;
    return {
      attribute: element.getAttribute("style"),
      hasAttribute: element.hasAttribute("style"),
      names: element.getAttributeNames(),
      cssText: element.style.cssText,
      color: element.style.color,
      length: element.style.length,
      firstProperty: element.style.item(0),
      declarationInstance: element.style instanceof window.CSSStyleDeclaration,
      declarationTag: Object.prototype.toString.call(element.style),
      computedColor: window.getComputedStyle(element).color,
    };
  });
  expect(initialStyle).toEqual({
    attribute: "color: rgb(61, 62, 63)",
    hasAttribute: true,
    names: ["id", "data-literal", "style"],
    cssText: "color: rgb(61, 62, 63);",
    color: "rgb(61, 62, 63)",
    length: 1,
    firstProperty: "color",
    declarationInstance: true,
    declarationTag: initialStyle.declarationTag,
    computedColor: "rgb(61, 62, 63)",
  });
  expect([
    "[object CSSStyleDeclaration]",
    "[object CSSStyleProperties]",
  ]).toContain(initialStyle.declarationTag);

  const result = await page.evaluate(({ frameNonce, origin }) => {
    const frame = document.querySelector("v-frame") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
      nonce: string;
    };
    const child = frame.contentWindow!;
    const virtualDocument = child.document;
    const nativeGetAttribute = Element.prototype.getAttribute;

    const attributeTarget = virtualDocument.createElement("div");
    attributeTarget.id = "attribute-style-target";
    virtualDocument.body.append(attributeTarget);
    attributeTarget.setAttribute("style", "color: rgb(71, 72, 73)");
    const afterSetAttribute = {
      value: attributeTarget.getAttribute("style"),
      color: child.getComputedStyle(attributeTarget).color,
      physical: nativeGetAttribute.call(attributeTarget, "style"),
    };
    attributeTarget.removeAttribute("style");
    const afterRemoveAttribute = {
      value: attributeTarget.getAttribute("style"),
      has: attributeTarget.hasAttribute("style"),
    };
    const toggleOn = attributeTarget.toggleAttribute("style");
    const afterToggleOn = {
      value: attributeTarget.getAttribute("style"),
      has: attributeTarget.hasAttribute("style"),
    };
    const toggleOff = attributeTarget.toggleAttribute("style");

    const cssomTarget = virtualDocument.createElement("div");
    cssomTarget.id = "cssom-style-target";
    cssomTarget.style.cssText =
      'color: rgb(81, 82, 83); background-image: url("../images/cssom.png")';
    virtualDocument.body.append(cssomTarget);
    const beforeBase = child.getComputedStyle(cssomTarget).backgroundImage;
    cssomTarget.style.setProperty("border-top-color", "rgb(91, 92, 93)", "important");
    cssomTarget.style.color = "rgb(101, 102, 103)";
    const assignedColor = child.getComputedStyle(cssomTarget).color;
    const removedColor = cssomTarget.style.removeProperty("color");
    const authoredBackground = cssomTarget.style.getPropertyValue("background-image");
    const authoredCssText = cssomTarget.style.cssText;

    const base = virtualDocument.createElement("base");
    base.href = "/alternate/nested/";
    virtualDocument.head.prepend(base);
    const afterBase = child.getComputedStyle(cssomTarget).backgroundImage;
    const baseURI = virtualDocument.baseURI;
    const afterBaseStyleText = frame.shadowRoot?.querySelector(
      "style[data-v-frame-inline-styles]",
    )?.textContent ?? "";
    cssomTarget.style.backgroundImage = 'url("property.png")';
    const assignedBackgroundValue = cssomTarget.style.backgroundImage;
    const afterPropertyAssignment = child.getComputedStyle(cssomTarget).backgroundImage;

    const clone = cssomTarget.cloneNode(true) as HTMLElement;
    clone.id = "cloned-style-target";
    virtualDocument.body.append(clone);
    const imported = virtualDocument.importNode(cssomTarget, true) as HTMLElement;
    imported.id = "imported-style-target";
    virtualDocument.body.append(imported);

    const markerAttribute = Array.from(cssomTarget.attributes)
      .find((attribute) => attribute.name.startsWith("data-v-frame-inline-style-"))!;
    const foreignNodes = (window as typeof window & {
      __foreignStyleNodes?: { foreign: HTMLElement; adopted: HTMLElement };
    }).__foreignStyleNodes!;
    const foreign = foreignNodes.foreign;
    foreign.setAttribute(markerAttribute.name, markerAttribute.value);
    virtualDocument.body.append(foreign);

    const adopted = foreignNodes.adopted;
    virtualDocument.adoptNode(adopted);
    virtualDocument.body.append(adopted);

    const svg = virtualDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    const rect = virtualDocument.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("style", "fill: rgb(131, 132, 133)");
    svg.append(rect);
    virtualDocument.body.append(svg);

    const cascadeTarget = virtualDocument.createElement("div");
    cascadeTarget.id = "cascade-style-target";
    cascadeTarget.setAttribute("style", "color: rgb(151, 152, 153)");
    virtualDocument.body.append(cascadeTarget);
    const normalInlineColor = child.getComputedStyle(cascadeTarget).color;
    cascadeTarget.style.setProperty("color", "rgb(161, 162, 163)", "important");
    const importantInlineColor = child.getComputedStyle(cascadeTarget).color;
    const cascadeImportantTarget = virtualDocument.createElement("div");
    cascadeImportantTarget.id = "cascade-important-target";
    cascadeImportantTarget.setAttribute("style", "color: rgb(181, 182, 183)");
    virtualDocument.body.append(cascadeImportantTarget);
    const pageImportantColor = child.getComputedStyle(cascadeImportantTarget).color;
    cascadeImportantTarget.style.setProperty(
      "color",
      "rgb(191, 192, 193)",
      "important",
    );
    const inlineImportantColor = child.getComputedStyle(cascadeImportantTarget).color;

    const markerValues = [cssomTarget, clone, imported, foreign]
      .map((element) => nativeGetAttribute.call(element, markerAttribute.name));
    frame.nonce = frameNonce;
    cssomTarget.style.opacity = "0.75";
    const aggregateStyle = frame.shadowRoot?.querySelector(
      "style[data-v-frame-inline-styles]",
    ) as HTMLStyleElement;

    return {
      afterSetAttribute,
      afterRemoveAttribute,
      toggleOn,
      afterToggleOn,
      toggleOff,
      afterToggleOff: {
        value: attributeTarget.getAttribute("style"),
        has: attributeTarget.hasAttribute("style"),
      },
      cssom: {
        beforeBase,
        afterBase,
        baseURI,
        afterBaseStyleText,
        afterPropertyAssignment,
        assignedBackgroundValue,
        assignedColor,
        removedColor,
        authoredBackground,
        authoredCssText,
        priority: cssomTarget.style.getPropertyPriority("border-top-color"),
        borderColor: cssomTarget.style.getPropertyValue("border-top-color"),
        attributeMatchesCssText:
          cssomTarget.getAttribute("style") === cssomTarget.style.cssText,
        indexedProperties: Array.from(
          { length: cssomTarget.style.length },
          (_value, index) => cssomTarget.style[index],
        ),
      },
      clone: {
        value: clone.getAttribute("style"),
        background: child.getComputedStyle(clone).backgroundImage,
      },
      imported: {
        value: imported.getAttribute("style"),
        background: child.getComputedStyle(imported).backgroundImage,
      },
      foreign: {
        value: foreign.getAttribute("style"),
        physical: nativeGetAttribute.call(foreign, "style"),
        color: child.getComputedStyle(foreign).color,
        background: child.getComputedStyle(foreign).backgroundImage,
        declarationInstance: foreign.style instanceof child.CSSStyleDeclaration,
      },
      adopted: {
        value: adopted.getAttribute("style"),
        physical: nativeGetAttribute.call(adopted, "style"),
        color: child.getComputedStyle(adopted).color,
      },
      svg: {
        value: rect.getAttribute("style"),
        physical: nativeGetAttribute.call(rect, "style"),
        fill: child.getComputedStyle(rect).fill,
        declarationInstance: rect.style instanceof child.CSSStyleDeclaration,
      },
      cascade: {
        normalInlineColor,
        importantInlineColor,
        pageImportantColor,
        inlineImportantColor,
      },
      markerValues,
      logicalMarkerNames: [cssomTarget, clone, imported, foreign]
        .flatMap((element) => element.getAttributeNames())
        .filter((name) => name.startsWith("data-v-frame-inline-style-")),
      aggregateNonce: aggregateStyle.nonce,
      opacity: child.getComputedStyle(cssomTarget).opacity,
      expected: {
        beforeBase: `url("${origin}/images/cssom.png")`,
        afterBase: `url("${origin}/alternate/images/cssom.png")`,
        property: `url("${origin}/alternate/nested/property.png")`,
        foreign: `url("${origin}/alternate/nested/foreign.png")`,
      },
    };
  }, { frameNonce: nextNonce, origin: fixture.origin });
  const historyRebase = await childValue(frame, (window) => {
    const target = window.document.createElement("div");
    target.style.backgroundImage = 'url("history.png")';
    window.document.body.append(target);
    const beforeHistory = window.getComputedStyle(target).backgroundImage;
    window.document.querySelector("base")?.remove();
    window.history.pushState({}, "", "history/nested.html");
    return {
      beforeHistory,
      afterHistory: window.getComputedStyle(target).backgroundImage,
      baseURI: window.document.baseURI,
    };
  });

  expect(result.afterSetAttribute).toEqual({
    value: "color: rgb(71, 72, 73)",
    color: "rgb(71, 72, 73)",
    physical: null,
  });
  expect(result.afterRemoveAttribute).toEqual({ value: null, has: false });
  expect(result.toggleOn).toBe(true);
  expect(result.afterToggleOn).toEqual({ value: "", has: true });
  expect(result.toggleOff).toBe(false);
  expect(result.afterToggleOff).toEqual({ value: null, has: false });
  expect(result.cssom.authoredBackground).toBe("url(../images/cssom.png)");
  expect(result.cssom.authoredCssText).toContain("url(../images/cssom.png)");
  expect(result.cssom.beforeBase).toBe(result.expected.beforeBase);
  expect(result.cssom.baseURI).toBe(`${fixture.origin}/alternate/nested/`);
  expect(result.cssom.afterBaseStyleText).toContain(`${fixture.origin}/alternate/images/cssom.png`);
  expect(result.cssom.afterBase).toBe(result.expected.afterBase);
  expect(result.cssom.afterPropertyAssignment).toBe(result.expected.property);
  expect(result.cssom.assignedBackgroundValue).toBe("url(property.png)");
  expect(result.cssom.assignedColor).toBe("rgb(101, 102, 103)");
  expect(result.cssom.removedColor).toBe("rgb(101, 102, 103)");
  expect(result.cssom.priority).toBe("important");
  expect(result.cssom.borderColor).toBe("rgb(91, 92, 93)");
  expect(result.cssom.attributeMatchesCssText).toBe(true);
  expect(result.cssom.indexedProperties).toEqual([
    "background-image",
    "border-top-color",
    "opacity",
  ]);
  expect(result.clone.background).toBe(result.expected.property);
  expect(result.imported.background).toBe(result.expected.property);
  expect(result.clone.value).toBe(result.imported.value);
  expect(result.foreign).toEqual({
    value: 'color: rgb(111, 112, 113); background-image: url("foreign.png")',
    physical: null,
    color: "rgb(111, 112, 113)",
    background: result.expected.foreign,
    declarationInstance: true,
  });
  expect(result.adopted).toEqual({
    value: "color: rgb(121, 122, 123)",
    physical: null,
    color: "rgb(121, 122, 123)",
  });
  expect(result.svg).toEqual({
    value: "fill: rgb(131, 132, 133)",
    physical: null,
    fill: "rgb(131, 132, 133)",
    declarationInstance: true,
  });
  expect(result.cascade).toEqual({
    normalInlineColor: "rgb(151, 152, 153)",
    importantInlineColor: "rgb(161, 162, 163)",
    pageImportantColor: "rgb(171, 172, 173)",
    inlineImportantColor: "rgb(191, 192, 193)",
  });
  expect(result.markerValues.every((value) => value !== null)).toBe(true);
  expect(new Set(result.markerValues).size).toBe(result.markerValues.length);
  expect(result.logicalMarkerNames).toEqual([]);
  expect(result.aggregateNonce).toBe(nextNonce);
  expect(result.opacity).toBe("0.75");
  expect(historyRebase).toEqual({
    beforeHistory: `url("${fixture.origin}/alternate/nested/history.png")`,
    afterHistory: `url("${fixture.origin}/documents/history/history.png")`,
    baseURI: `${fixture.origin}/documents/history/nested.html`,
  });
  expect(consoleViolations).toEqual([]);
  expect(await page.evaluate(() =>
    (window as typeof window & { __styleCSPViolations?: string[] }).__styleCSPViolations,
  )).toEqual([]);

  await frame.evaluate((element) => element.remove());
  await expect(frame).toHaveCount(0);
});
