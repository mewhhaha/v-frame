import { expect, test, type Page } from "@playwright/test";
import type { VFrameElement } from "../src/index";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { frameFailures, installBundle, mountFrame } from "./support/mount-frame";

let fixture: HTTPFixture;
test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument('<div id="host"></div>'),
      "/dist/index.js": bundleRoute,
      "/original": htmlDocument(
        `<main id="original"><input id="field" value="initial"><button id="button">Interact</button><output id="count">0</output></main><script>
          document.querySelector("button").onclick = async () => {
            const increment = await (await fetch("/increment")).text();
            const request = new XMLHttpRequest();
            request.onload = () => {
              document.querySelector("output").textContent = String(
                +document.querySelector("output").textContent +
                Number(increment) * Number(request.responseText)
              );
            };
            request.open("GET", "/increment");
            request.send();
          };
        </script>`,
        '<style>html,body{margin:0}main{height:2000px;background:rgb(210,230,250)}main::before{content:"Original pseudo";color:rgb(10,20,30)}</style>',
      ),
      "/replacement": htmlDocument(
        `<main id="replacement">Replacement</main><script type="module">
          const main = document.querySelector("main");
          const sheet = document.querySelector("style").sheet;
          window.retainedRule = sheet.cssRules[1];
          retainedRule.selectorText = "main:not(.excluded)";
          window.ruleText = retainedRule.cssText;
          window.groupText = sheet.cssRules[2].cssText;
          const clone = document.createElement("style");
          clone.textContent = ruleText + groupText;
          document.head.append(clone);
          sheet.insertRule("#replacement { color:rgb(30,40,50) }");
          const component = document.createElement("article");
          main.append(component);
          const shadow = component.attachShadow({ mode: "open" });
          shadow.innerHTML = '<style>span{color:rgb(70,80,90)}</style><span>Component</span>';
          window.beforeActivation = {
            selector: retainedRule.selectorText,
            background: getComputedStyle(main).backgroundColor,
            color: getComputedStyle(main).color,
            pseudo: getComputedStyle(main,"::before").color,
            shadow: getComputedStyle(shadow.querySelector("span")).color,
          };
          await fetch("/activate");
          window.activated = true;
        </script>`,
        '<style>html,body{margin:0}main{height:2000px;background:rgb(250,230,210)}@media(min-width:1px){main::before{content:"Replacement pseudo";color:rgb(50,60,70)}}</style>',
      ),
      "/activate": { type: "text/plain", body: "activated" },
      "/increment": { type: "text/plain", body: "1" },
    },
  });
});
test.afterAll(async () => fixture.close());

async function mount(page: Page, failBootstrap = false) {
  await installBundle(page, fixture.origin);
  const frame = await mountFrame(page, { src: fixture.origin + "/original" });
  if (failBootstrap) {
    await frame.evaluate((element: VFrameElement) => {
      element.trustedTypesPolicy = {
        name: "replacement-policy",
        createHTML(source) {
          if (element.src.endsWith("/replacement"))
            throw new Error("Cannot bootstrap replacement");
          return source;
        },
        createScript: (source) => source,
        createScriptURL: (source) => source,
      };
    });
    await expect
      .poll(() => frame.evaluate((element: VFrameElement) => element.status))
      .toBe("ready");
  }
  await frame.evaluate((element: VFrameElement) => {
    element.style.cssText = "width:400px;height:240px";
    const guest = element.contentWindow!;
    guest.history.pushState({ preserved: true }, "", "#edited");
    (guest.document.querySelector("#field") as HTMLInputElement).value = "edited";
  });
  return frame;
}

test("keeps a src replacement pixel-stable and interactive through entry and script loading", async ({
  page,
}) => {
  const frame = await mount(page);
  const oldWindow = await frame.evaluateHandle(
    (element: VFrameElement) => element.contentWindow!,
  );
  const before = await frame.screenshot({ caret: "hide" });
  let releaseEntry: (() => Promise<void>) | undefined;
  let releaseScripts: (() => Promise<void>) | undefined;
  await page.route("**/replacement", (route) => {
    releaseEntry = () => route.continue();
  });
  await page.route("**/activate", (route) => {
    releaseScripts = () => route.continue();
  });
  await frame.evaluate(
    (element: VFrameElement, url) => (element.src = url),
    fixture.origin + "/replacement",
  );
  await expect.poll(() => !!releaseEntry).toBe(true);
  expect(
    (await frame.screenshot({ caret: "hide" })).equals(before),
    "Entry loading changed the live guest's paint",
  ).toBe(true);
  const paints = await frame.evaluate(async (element: VFrameElement) => {
    const paints = [];
    for (let index = 0; index < 3; index++) {
      await new Promise(requestAnimationFrame);
      paints.push({
        status: element.status,
        url: element.currentURL,
        original: !!element.contentWindow?.document.querySelector("#original"),
      });
    }
    return paints;
  });
  expect(paints).toEqual(
    Array.from({ length: 3 }, () => ({
      status: "loading",
      url: fixture.origin + "/original#edited",
      original: true,
    })),
  );
  await releaseEntry!();
  await expect.poll(() => !!releaseScripts).toBe(true);
  const staged = await frame.screenshot({ caret: "hide" });
  await test.info().attach("before", { body: before, contentType: "image/png" });
  await test.info().attach("staged", { body: staged, contentType: "image/png" });
  expect(staged.equals(before), "Staged styles changed the live guest's paint").toBe(
    true,
  );
  await frame.locator("#button").click();
  await expect(frame.locator("#count")).toHaveText("1");
  expect(
    await frame.evaluate(
      (element: VFrameElement, oldWindow) => ({
        sameWindow: element.contentWindow === oldWindow,
        url: element.currentURL,
        history: element.contentWindow!.history.length,
        edited: (
          element.contentWindow!.document.querySelector("#field") as HTMLInputElement
        ).value,
      }),
      oldWindow,
    ),
  ).toEqual({
    sameWindow: true,
    url: fixture.origin + "/original#edited",
    history: 2,
    edited: "edited",
  });
  await releaseScripts!();
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  expect(
    await frame.evaluate(
      (element: VFrameElement, oldWindow) => ({
        sameWindow: element.contentWindow === oldWindow,
        url: element.currentURL,
        history: element.contentWindow!.history.length,
        replacement: !!element.contentWindow!.document.querySelector("#replacement"),
        display: getComputedStyle(element).display,
        roots: element.shadowRoot!.querySelectorAll("v-html").length,
      }),
      oldWindow,
    ),
  ).toEqual({
    sameWindow: false,
    url: fixture.origin + "/replacement",
    history: 1,
    replacement: true,
    display: "block",
    roots: 1,
  });
  expect(await frameFailures(frame)).toEqual([]);
  const styles = await frame.evaluate((element: VFrameElement) => {
    const child = element.contentWindow as Window & {
      retainedRule: CSSStyleRule;
      ruleText: string;
      groupText: string;
      beforeActivation: {
        selector: string;
        background: string;
        color: string;
        pseudo: string;
        shadow: string;
      };
    };
    return {
      before: child.beforeActivation,
      afterSelector: child.retainedRule.selectorText,
      copiedText: child.ruleText,
      copiedGroup: child.groupText,
      copiedRules: Array.from(child.document.querySelectorAll("style")).at(-1)!.sheet!
        .cssRules.length,
      background: child.getComputedStyle(child.document.querySelector("main")!)
        .backgroundColor,
    };
  });
  expect(styles.before).toEqual({
    selector: "main:not(.excluded)",
    background: "rgb(250, 230, 210)",
    color: "rgb(30, 40, 50)",
    pseudo: "rgb(50, 60, 70)",
    shadow: "rgb(70, 80, 90)",
  });
  expect(styles.afterSelector).toBe("main:not(.excluded)");
  expect(styles.copiedText).not.toContain(":host");
  expect(styles.copiedGroup).not.toContain(":host");
  expect(styles.copiedRules).toBe(2);
  expect(styles.background).toBe("rgb(250, 230, 210)");
});

for (const failure of ["entry", "bootstrap", "invalid-url"] as const) {
  test(`a failed src replacement preserves the live guest and history (${failure})`, async ({
    page,
  }) => {
    const frame = await mount(page, failure === "bootstrap");
    const oldWindow = await frame.evaluateHandle(
      (element: VFrameElement) => element.contentWindow!,
    );
    if (failure === "entry") {
      await page.route("**/replacement", (route) =>
        route.fulfill({ status: 503, body: "Unavailable" }),
      );
    }
    await frame.evaluate(
      (element: VFrameElement, source) => (element.src = source),
      failure === "invalid-url"
        ? "mailto:invalid@example.test"
        : fixture.origin + "/replacement",
    );
    await expect.poll(() => frameFailures(frame)).toHaveLength(1);
    expect((await frameFailures(frame))[0]!.fatal).toBe(false);
    expect(
      await frame.evaluate(
        (element: VFrameElement, oldWindow) => ({
          sameWindow: element.contentWindow === oldWindow,
          status: element.status,
          url: element.currentURL,
          history: element.contentWindow!.history.length,
          edited: (
            element.contentWindow!.document.querySelector("#field") as HTMLInputElement
          ).value,
          roots: element.shadowRoot!.querySelectorAll("v-html").length,
        }),
        oldWindow,
      ),
    ).toEqual({
      sameWindow: true,
      status: "ready",
      url: fixture.origin + "/original#edited",
      history: 2,
      edited: "edited",
      roots: 1,
    });
    await frame.locator("#button").click();
    await expect(frame.locator("#count")).toHaveText("1");
    expect(page.url()).toBe(fixture.origin + "/");
  });
}
