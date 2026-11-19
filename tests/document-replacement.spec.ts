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
      "/staged-interactions": htmlDocument(
        `<main><output id="staged-state"></output><button id="new-button">Replacement</button>
        <dialog id="deferred-dialog">Deferred modal</dialog><dialog id="closed-dialog">Closed before activation</dialog>
        <span id="below">Below the fold</span></main>
        <script type="module">
          const modal = document.querySelector('#deferred-dialog');
          const closed = document.querySelector('#closed-dialog');
          window.addEventListener('click', event => { window.firstClick = event.target.id }, { once: true });
          const focused = document.activeElement === document.body;
          const hasFocus = document.hasFocus();
          const hits = document.elementsFromPoint(10, 10).length;
          window.scrollTo(0, 600);
          document.scrollingElement.scrollTop += 50;
          window.scrollBy({ top: 25 });
          const below = document.querySelector('#below');
          let invalidScroll;
          try { below.scrollIntoView({ block: "invalid" }); }
          catch (error) { invalidScroll = error.name; }
          const stagedScroll = scrollY;
          below.scrollIntoView({ behavior: "instant" });
          window.scrollBy(0, -25);
          modal.showModal();
          closed.showModal();
          closed.close();
          window.showLater = closed.showModal.bind(closed);
          const show = HTMLDialogElement.prototype.showModal;
          HTMLDialogElement.prototype.showModal = function () {
            window.calledGuestWrapper = true;
            show.call(this);
          };
          document.querySelector('output').textContent = JSON.stringify({
            focused, hasFocus, hits, stagedScroll, invalidScroll, open: modal.open, modal: modal.matches(':modal')
          });
          await fetch("/activate");
        </script>`,
        "<style>html,body{margin:0}main{height:2000px;position:relative}#below{position:absolute;top:1500px}</style>",
      ),
      "/staged-top-layer":
        htmlDocument(`<main id="nested"></main><output id="layer-state"></output>
        <script type="module">
          const nested = document.querySelector('#nested').attachShadow({ mode: 'closed' });
          nested.innerHTML = '<dialog id="modal">Dialog</dialog><button id="invoker" commandfor="modal" command="show-modal">Open</button><div id="menu" popover>Menu</div><button id="popover-invoker" popovertarget="menu">Open menu</button><div id="blocked-menu" popover="manual">Canceled menu</div><button id="blocked-invoker" popovertarget="blocked-menu">Open canceled menu</button>';
          const dialog = nested.querySelector('dialog');
          const button = nested.querySelector('#invoker');
          const menu = nested.querySelector('#menu');
          const blocked = nested.querySelector('#blocked-menu');
          const programmatic = document.createElement('div');
          programmatic.popover = 'manual';
          document.body.append(programmatic);
          const toggledOn = programmatic.togglePopover();
          const toggledOff = programmatic.togglePopover();
          let invalidPopoverOptions = [];
          for (const method of ['showPopover', 'togglePopover']) {
            try { programmatic[method]({ source: {} }); }
            catch (error) { invalidPopoverOptions.push(error.name); }
          }
          programmatic.showPopover();
          window.getLayerState = () => ({
            modal: dialog.matches(':modal'),
            open: dialog.open,
            popover: menu.matches(':popover-open'),
            blocked: blocked.matches(':popover-open'),
            programmatic: programmatic.matches(':popover-open'),
          });
          const declarative = 'commandForElement' in button;
          let prevented = true;
          let syntheticIgnored = true;
          if (declarative) {
            dialog.addEventListener('command', event => event.preventDefault(), { once: true });
            button.click();
            await Promise.resolve();
            prevented = !dialog.open;
            dialog.dispatchEvent(new CommandEvent('command', { command: 'show-modal', source: button, cancelable: true }));
            await Promise.resolve();
            syntheticIgnored = !dialog.open;
            button.click();
          } else {
            dialog.showModal();
          }
          blocked.addEventListener('beforetoggle', event => event.preventDefault(), { once: true });
          nested.querySelector('#blocked-invoker').click();
          nested.querySelector('#popover-invoker').click();
          await Promise.resolve();
          document.querySelector('output').textContent = JSON.stringify({
            prevented, syntheticIgnored, toggledOn, toggledOff, invalidPopoverOptions, ...window.getLayerState()
          });
          await fetch('/activate');
        </script>`),
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

for (const outcome of ["reveal", "rollback"] as const) {
  test(`isolates focus, events, modals and scroll during staged interaction (${outcome})`, async ({
    page,
  }) => {
    const frame = await mount(page);
    let release: (() => Promise<void>) | undefined;
    await page.route("**/activate", (route) => {
      release = () => route.continue();
    });
    await frame.locator("#field").focus();
    await frame.evaluate(
      (element: VFrameElement) => (element.src = "/staged-interactions"),
    );
    await expect.poll(() => release !== undefined).toBe(true);
    expect(JSON.parse((await frame.locator("#staged-state").textContent())!)).toEqual({
      focused: true,
      hasFocus: false,
      hits: 0,
      stagedScroll: 675,
      invalidScroll: "TypeError",
      open: true,
      modal: false,
    });
    expect(await frame.evaluate((element) => element.scrollTop)).toBe(0);
    await frame.locator("#button").click();
    await expect(frame.locator("#count")).toHaveText("1");

    // Staging uses its own display rule, so exercise hidden here as well as
    // after the previous guest is revealed again.
    await frame.evaluate((element: VFrameElement) => (element.hidden = true));
    await expect(frame).toBeHidden();
    await frame.evaluate((element: VFrameElement) => (element.hidden = false));

    if (outcome === "rollback") {
      await frame.evaluate((element: VFrameElement) => (element.src = "/missing"));
      await expect.poll(() => frameFailures(frame)).toHaveLength(1);
      expect((await frameFailures(frame))[0]?.fatal).toBe(false);
      await expect(frame.locator("#staged-state")).toHaveCount(0);
      expect(await frame.evaluate((element) => element.scrollTop)).toBe(0);
      await frame.locator("#button").click();
      await expect(frame.locator("#count")).toHaveText("2");
      return;
    }

    await release!();
    await expect
      .poll(() => frame.evaluate((element: VFrameElement) => element.status))
      .toBe("ready");
    const committed = await frame.evaluate((element: VFrameElement) => {
      const child = element.contentWindow as Window & {
        firstClick?: string;
        showLater(): void;
        calledGuestWrapper?: boolean;
      };
      const primary =
        child.document.querySelector<HTMLDialogElement>("#deferred-dialog")!;
      const closed = child.document.querySelector<HTMLDialogElement>("#closed-dialog")!;
      const state = {
        modal: primary.matches(":modal"),
        closed: !closed.open,
        scroll: child.scrollY,
        firstClick: child.firstClick ?? null,
      };
      primary.close();
      child.document.querySelector<HTMLButtonElement>("#new-button")!.click();
      child.showLater();
      const retainedMethodWorks = closed.matches(":modal");
      closed.close();
      closed.showModal();
      return {
        ...state,
        nextClick: child.firstClick,
        retainedMethodWorks,
        wrapperWorks: child.calledGuestWrapper && closed.matches(":modal"),
      };
    });
    expect(committed).toEqual({
      modal: true,
      closed: true,
      scroll: 1475,
      firstClick: null,
      nextClick: "new-button",
      retainedMethodWorks: true,
      wrapperWorks: true,
    });
    await frame.evaluate((element: VFrameElement) => (element.hidden = true));
    await expect(frame).toBeHidden();
  });
}

test("stages declarative top-layer actions in a nested shadow tree", async ({ page }) => {
  const frame = await mount(page);
  await frame.evaluate((element: VFrameElement) => {
    const doc = element.contentWindow!.document;
    const popover = doc.createElement("div");
    popover.id = "old-menu";
    popover.popover = "auto";
    doc.body.append(popover);
    popover.showPopover();
  });
  let release: (() => Promise<void>) | undefined;
  await page.route("**/activate", (route) => {
    release = () => route.continue();
  });
  await frame.evaluate((element: VFrameElement) => (element.src = "/staged-top-layer"));
  await expect.poll(() => release !== undefined).toBe(true);
  expect(JSON.parse((await frame.locator("#layer-state").textContent())!)).toEqual({
    prevented: true,
    syntheticIgnored: true,
    toggledOn: true,
    toggledOff: false,
    invalidPopoverOptions: ["TypeError", "TypeError"],
    modal: false,
    open: true,
    popover: false,
    blocked: false,
    programmatic: false,
  });
  expect(
    await frame
      .locator("#old-menu")
      .evaluate((element) => element.matches(":popover-open")),
  ).toBe(true);
  await release!();
  await expect
    .poll(() => frame.evaluate((element: VFrameElement) => element.status))
    .toBe("ready");
  expect(
    await frame.evaluate((element: VFrameElement) => {
      const child = element.contentWindow as Window & { getLayerState(): object };
      return child.getLayerState();
    }),
  ).toEqual({
    modal: true,
    open: true,
    popover: true,
    blocked: false,
    programmatic: true,
  });
});
