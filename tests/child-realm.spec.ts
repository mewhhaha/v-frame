import { expect, test } from "@playwright/test";
import {
  type ContractFixtureServers,
  startContractFixtureServers,
} from "./support/fixture-server";
import { childValue, mountContractFrame } from "./support/guest-frames";
import { installBundle } from "./support/mount-frame";

let fixture: ContractFixtureServers;

test.beforeAll(async () => {
  fixture = await startContractFixtureServers();
});

test.afterAll(async () => {
  await fixture.close();
});

test("provides document queries, mutations, focus, and listeners through the child realm", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "dom",
    `${fixture.origin}/documents/dom.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  const state = await childValue(frame, async (window) => {
    const document = window.document;
    const root = document.querySelector("#dom-root");
    const clickTarget = document.querySelector("#click-target") as HTMLButtonElement;
    let clicks = 0;
    let mutations = 0;
    document.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).id === "click-target") {
        clicks += 1;
      }
    });
    const observer = new window.MutationObserver((records) => {
      mutations += records.length;
    });
    observer.observe(document, { childList: true, subtree: true });
    const created = document.createElement("button");
    created.id = "created-button";
    created.textContent = "Created";
    root?.append(created);
    clickTarget.click();
    (document.querySelector("#focus-target") as HTMLInputElement).focus();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    observer.disconnect();
    return {
      rootID: root?.id,
      createdFound: document.getElementById("created-button") === created,
      buttonCount: document.querySelectorAll("button").length,
      activeID: (document.activeElement as HTMLElement).id,
      clicks,
      mutations,
    };
  });

  expect(state).toMatchObject({
    rootID: "dom-root",
    createdFound: true,
    buttonCount: 2,
    activeID: "focus-target",
    clicks: 1,
  });
  expect(state.mutations).toBeGreaterThan(0);
});

test("routes postMessage through the child window and keeps two realms separate", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const first = await mountContractFrame(
    page,
    "first-realm",
    `${fixture.origin}/documents/messaging.html`,
  );
  const second = await mountContractFrame(
    page,
    "second-realm",
    `${fixture.origin}/documents/messaging.html`,
  );
  await expect
    .poll(() =>
      first.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  await expect
    .poll(() =>
      second.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  const message = await page.evaluate(async (origin) => {
    const firstFrame = document.querySelector("#first-realm") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const secondFrame = document.querySelector("#second-realm") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const firstWindow = firstFrame.contentWindow;
    const secondWindow = secondFrame.contentWindow;
    if (firstWindow === null || secondWindow === null) {
      throw new Error("Messaging fixtures did not expose child windows");
    }
    (firstWindow as Window & { __contractLocal?: string }).__contractLocal = "first";
    const response = await new Promise<{
      data: { kind: string; realm: string };
      origin: string;
      fromFirst: boolean;
    }>((resolve) => {
      const listener = (event: MessageEvent<{ kind: string; realm: string }>) => {
        window.removeEventListener("message", listener);
        resolve({
          data: event.data,
          origin: event.origin,
          fromFirst: event.source === firstWindow,
        });
      };
      window.addEventListener("message", listener);
      firstWindow.postMessage({ kind: "host-ping" }, origin);
    });
    return {
      ...response,
      distinctWindows: firstWindow !== secondWindow,
      secondHasFirstValue: "__contractLocal" in secondWindow,
    };
  }, fixture.origin);

  await expect(first.locator("#message-result")).toHaveText("host-ping");
  expect(message).toEqual({
    data: { kind: "host-ping", realm: "child" },
    origin: fixture.origin,
    fromFirst: true,
    distinctWindows: true,
    secondHasFirstValue: false,
  });
});

test("delivers composed DOM events to child window listeners before link defaults", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "window-events",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  await frame.evaluate((element) => {
    (element as HTMLElement & { navigationCount?: number }).navigationCount = 0;
    element.addEventListener("v-frame-navigate", () => {
      (element as HTMLElement & { navigationCount: number }).navigationCount += 1;
    });
  });
  const result = await childValue(frame, async (window) => {
    const received: string[] = [];
    window.addEventListener("contract-custom", (event) => {
      received.push((event as CustomEvent<{ value: string }>).detail.value);
    });
    window.addEventListener("click", (event) => {
      if ((event.target as Element).closest("#blocked-link") !== null) {
        event.preventDefault();
      }
    });
    window.document.querySelector("main")?.dispatchEvent(
      new window.CustomEvent("contract-custom", {
        detail: { value: "received" },
        bubbles: true,
        composed: true,
      }),
    );
    (window.document.querySelector("#blocked-link") as HTMLAnchorElement).click();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    return { received, url: window.document.URL };
  });

  expect(result).toEqual({
    received: ["received"],
    url: `${fixture.origin}/documents/history.html`,
  });
  expect(
    await frame.evaluate(
      (element) => (element as HTMLElement & { navigationCount: number }).navigationCount,
    ),
  ).toBe(0);
});

test("keeps innerHTML scripts inert while running dynamic scripts and reporting runtime failures", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "scripts",
    `${fixture.origin}/documents/scripts.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  const result = await page.evaluate(async () => {
    const frame = document.querySelector("#scripts") as HTMLElement & {
      contentWindow: (Window & typeof globalThis) | null;
    };
    const child = frame.contentWindow;
    if (child === null) {
      throw new Error("Script fixture did not expose a child window");
    }
    const runtimeFailure = new Promise<{
      phase: string;
      fatal: boolean;
      hasURL: boolean;
    }>((resolve) => {
      frame.addEventListener(
        "v-frame-error",
        (event) => {
          const detail = (
            event as CustomEvent<{ phase: string; fatal: boolean; url: string }>
          ).detail;
          if (detail.phase === "runtime") {
            resolve({
              phase: detail.phase,
              fatal: detail.fatal,
              hasURL: detail.url !== "",
            });
          }
        },
        { once: true },
      );
    });
    const root = child.document.querySelector("#script-root") as HTMLElement;
    root.innerHTML =
      '<script>window.__innerHTMLScriptRan = true</script><p id="inner-html-copy">inert</p>';
    const dynamic = child.document.createElement("script");
    dynamic.text =
      "window.__dynamicScriptRan = true; setTimeout(() => { throw new Error('dynamic runtime failure'); }, 0);";
    child.document.body.append(dynamic);
    const failure = await runtimeFailure;
    return {
      innerHTMLScriptRan: "__innerHTMLScriptRan" in child,
      dynamicScriptRan:
        (child as Window & { __dynamicScriptRan?: boolean }).__dynamicScriptRan === true,
      failure,
    };
  });

  await expect(frame.locator("#inner-html-copy")).toHaveText("inert");
  expect(result).toEqual({
    innerHTMLScriptRan: false,
    dynamicScriptRan: true,
    failure: {
      phase: "runtime",
      fatal: false,
      hasURL: true,
    },
  });
});

test("rewrites dynamic inline and linked styles without crossing the shadow boundary", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "styles",
    `${fixture.origin}/documents/styles.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  await childValue(frame, (window) => {
    const inlineCopy = window.document.createElement("p");
    inlineCopy.id = "dynamic-inline";
    inlineCopy.textContent = "Inline CSS";
    window.document.body.append(inlineCopy);
    const linkedCopy = window.document.createElement("p");
    linkedCopy.id = "dynamic-linked";
    linkedCopy.textContent = "Linked CSS";
    window.document.body.append(linkedCopy);
    const inlineStyle = window.document.createElement("style");
    inlineStyle.textContent = "#dynamic-inline { color: rgb(21, 22, 23); }";
    window.document.head.append(inlineStyle);
    const linkedStyle = window.document.createElement("link");
    linkedStyle.rel = "stylesheet";
    linkedStyle.href = "/assets/dynamic-linked.css";
    window.document.head.append(linkedStyle);
  });

  await expect(frame.locator("#dynamic-inline")).toHaveCSS("color", "rgb(21, 22, 23)");
  await expect(frame.locator("#dynamic-linked")).toHaveCSS("color", "rgb(31, 32, 33)");
  await expect(page.locator("body > #host-isolated")).toHaveCSS(
    "color",
    "rgb(91, 92, 93)",
  );
  await expect(frame.locator("#host-isolated")).toHaveCSS("color", "rgb(0, 0, 0)");
});
