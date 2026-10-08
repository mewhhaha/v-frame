import { expect, test } from "@playwright/test";
import {
  type ContractFixtureServers,
  startContractFixtureServers,
} from "./support/fixture-server";
import { childValue, mountContractFrame } from "./support/guest-frames";
import { installBundle } from "./support/mount-frame";
import { flushTasks } from "./support/settle";

let fixture: ContractFixtureServers;

test.beforeAll(async () => {
  fixture = await startContractFixtureServers();
});

test.afterAll(async () => {
  await fixture.close();
});

test("binds an explicit host-navigation frame to shell location and history", async ({
  page,
}) => {
  await page.goto(`${fixture.origin}/documents/bound-shell.html`);
  await page.evaluate(async (bundleURL) => {
    const bundle = await import(bundleURL);
    bundle.defineVFrame();
    (
      window as Window &
        typeof globalThis & { __unpatchedPushState?: History["pushState"] }
    ).__unpatchedPushState = history.pushState;
    const frame = document.createElement("v-frame");
    frame.setAttribute("navigation", "host");
    frame.setAttribute("src", location.href);
    document.querySelector("#host")?.append(frame);
  }, `${fixture.origin}/dist/index.js`);
  const frame = page.locator("v-frame");
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");

  expect(
    await childValue(frame, (window) => ({
      href: window.location.href,
      pathname: window.location.pathname,
    })),
  ).toEqual({
    href: `${fixture.origin}/documents/bound-shell.html`,
    pathname: "/documents/bound-shell.html",
  });

  await childValue(frame, (window) => {
    window.history.pushState({ owner: "child" }, "", "/documents/bound-child");
  });
  await expect(page).toHaveURL(`${fixture.origin}/documents/bound-child`);
  await expect
    .poll(() =>
      frame.evaluate(
        (element: HTMLElement & { currentURL: string | null }) => element.currentURL,
      ),
    )
    .toBe(`${fixture.origin}/documents/bound-child`);

  await page.evaluate(() => {
    history.replaceState({ owner: "host" }, "", "/documents/bound-host");
  });
  await expect
    .poll(() =>
      childValue(frame, (window) => ({
        href: window.location.href,
        state: window.history.state,
        events: (window as Window & typeof globalThis & { __boundPopStates: unknown[] })
          .__boundPopStates,
      })),
    )
    .toEqual({
      href: `${fixture.origin}/documents/bound-host`,
      state: { owner: "host" },
      events: [{ owner: "host" }],
    });

  expect(
    await frame.evaluate((element) => {
      const childHistory = (
        element as HTMLElement & { contentWindow: Window & typeof globalThis }
      ).contentWindow.history;
      element.remove();
      childHistory.back();
      return (
        history.pushState ===
        (
          window as Window &
            typeof globalThis & { __unpatchedPushState: History["pushState"] }
        ).__unpatchedPushState
      );
    }),
  ).toBe(true);
  await expect(page).toHaveURL(`${fixture.origin}/documents/bound-host`);
});

test("reports but does not perform canceled link and form navigation", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "canceled-navigation",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  const before = await frame.evaluate(
    (element: HTMLElement & { currentURL: string | null }) => element.currentURL,
  );
  const hostHistory = await page.evaluate(() => ({
    href: location.href,
    length: history.length,
    state: history.state,
  }));

  await page.evaluate(() => {
    const frame = document.querySelector("#canceled-navigation");
    const navigations: Array<{ kind: string; to: string; cancelable: boolean }> = [];
    frame?.addEventListener("v-frame-navigate", (event) => {
      const detail = (event as CustomEvent<{ kind: string; to: string }>).detail;
      navigations.push({
        kind: detail.kind,
        to: detail.to,
        cancelable: event.cancelable,
      });
      event.preventDefault();
    });
    (
      window as Window & { contractNavigations?: typeof navigations }
    ).contractNavigations = navigations;
  });
  await childValue(frame, (window) => {
    const events: string[] = [];
    (
      window as Window & typeof globalThis & { __canceledFragmentEvents?: string[] }
    ).__canceledFragmentEvents = events;
    window.addEventListener("popstate", () => events.push("popstate"));
    window.addEventListener("hashchange", () => events.push("hashchange"));
  });
  await frame.locator("#top-link").click();
  await frame.locator("#blocked-link").click();
  await frame.locator("#blocked-form button").click();

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { contractNavigations?: unknown[] }).contractNavigations
            ?.length ?? 0,
      ),
    )
    .toBe(3);
  expect(
    await page.evaluate(
      () =>
        (
          window as Window &
            typeof globalThis & {
              contractNavigations: Array<{
                kind: string;
                to: string;
                cancelable: boolean;
              }>;
            }
        ).contractNavigations,
    ),
  ).toEqual([
    {
      kind: "fragment",
      to: `${fixture.origin}/documents/history.html#`,
      cancelable: true,
    },
    {
      kind: "link",
      to: `${fixture.origin}/documents/blocked-link.html`,
      cancelable: true,
    },
    {
      kind: "form",
      to: `${fixture.origin}/documents/blocked-form.html?query=fixture`,
      cancelable: true,
    },
  ]);
  expect(
    await childValue(
      frame,
      (window) =>
        (window as Window & typeof globalThis & { __canceledFragmentEvents: string[] })
          .__canceledFragmentEvents,
    ),
  ).toEqual([]);
  expect(
    await frame.evaluate(
      (element: HTMLElement & { currentURL: string | null }) => element.currentURL,
    ),
  ).toBe(before);
  expect(
    await page.evaluate(() => ({
      href: location.href,
      length: history.length,
      state: history.state,
    })),
  ).toEqual(hostHistory);
});

test("loads an allowed same-context link inside the guest", async ({ page }) => {
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "staged-navigation",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as HTMLElement & { status: string }).status),
    )
    .toBe("ready");
  await frame.evaluate((element) => {
    const child = (
      element as HTMLElement & { contentWindow: (Window & typeof globalThis) | null }
    ).contentWindow;
    const link = child?.document.createElement("a");
    if (child === null || child === undefined || link === undefined) {
      throw new Error("The staged-navigation frame has no child window");
    }
    link.id = "slow-document-link";
    link.href = "/documents/slow.html";
    link.textContent = "Slow document";
    child.document.body.append(link);
  });

  await frame.locator("#slow-document-link").click();
  await expect(frame.locator("#slow-copy")).toHaveText("Slow document");
  await expect
    .poll(() =>
      frame.evaluate(
        (element) => (element as HTMLElement & { currentURL: string | null }).currentURL,
      ),
    )
    .toBe(`${fixture.origin}/documents/slow.html`);
  expect(page.url()).toBe(`${fixture.origin}/`);
});

test("gates modified primary and middle link activations before opening a new context", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "new-context-navigation",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  const hostURL = page.url();
  await frame.evaluate((element) => {
    const controlledFrame = element as HTMLElement & {
      allowNavigation: boolean;
      navigations: Array<{ kind: string; to: string; cancelable: boolean }>;
    };
    controlledFrame.allowNavigation = false;
    controlledFrame.navigations = [];
    element.addEventListener("v-frame-navigate", (event) => {
      const navigationEvent = event as CustomEvent<{ kind: string; to: string }>;
      controlledFrame.navigations.push({
        kind: navigationEvent.detail.kind,
        to: navigationEvent.detail.to,
        cancelable: event.cancelable,
      });
      if (!controlledFrame.allowNavigation) {
        event.preventDefault();
      }
    });
  });

  const openedPages: import("@playwright/test").Page[] = [];
  page.context().on("page", (openedPage) => openedPages.push(openedPage));
  const link = frame.locator("#new-context-link");

  await link.click({ modifiers: ["Shift"] });
  await expect
    .poll(() =>
      frame.evaluate(
        (element) =>
          (element as HTMLElement & { navigations: unknown[] }).navigations.length,
      ),
    )
    .toBe(1);
  // Popups reach Playwright through the browser process; two painted frames order the check after one.
  await flushTasks(page);
  expect(openedPages).toHaveLength(0);

  await frame.evaluate((element) => {
    (element as HTMLElement & { allowNavigation: boolean }).allowNavigation = true;
  });
  const modifiedPagePromise = page.context().waitForEvent("page");
  await link.click({ modifiers: ["Control"] });
  const modifiedPage = await modifiedPagePromise;
  await expect
    .poll(() => modifiedPage.url())
    .toBe(`${fixture.origin}/documents/new-context.html`);
  await modifiedPage.close();

  await frame.evaluate((element) => {
    (element as HTMLElement & { allowNavigation: boolean }).allowNavigation = false;
  });
  await link.click({ button: "middle" });
  await expect
    .poll(() =>
      frame.evaluate(
        (element) =>
          (element as HTMLElement & { navigations: unknown[] }).navigations.length,
      ),
    )
    .toBe(3);
  // Popups reach Playwright through the browser process; two painted frames order the check after one.
  await flushTasks(page);
  expect(openedPages).toHaveLength(1);

  await frame.evaluate((element) => {
    (element as HTMLElement & { allowNavigation: boolean }).allowNavigation = true;
  });
  const middlePagePromise = page.context().waitForEvent("page");
  await link.click({ button: "middle" });
  const middlePage = await middlePagePromise;
  await expect
    .poll(() => middlePage.url())
    .toBe(`${fixture.origin}/documents/new-context.html`);
  await middlePage.close();

  expect(
    await frame.evaluate(
      (element) =>
        (
          element as HTMLElement & {
            navigations: Array<{ kind: string; to: string; cancelable: boolean }>;
          }
        ).navigations,
    ),
  ).toEqual(
    Array.from({ length: 4 }, () => ({
      kind: "link",
      to: `${fixture.origin}/documents/new-context.html`,
      cancelable: true,
    })),
  );
  expect(openedPages).toHaveLength(2);
  expect(
    await frame.evaluate(
      (element: HTMLElement & { currentURL: string | null }) => element.currentURL,
    ),
  ).toBe(`${fixture.origin}/documents/history.html`);
  expect(page.url()).toBe(hostURL);
});

test("uses submitter overrides and replacement query data for gated GET form windows", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "submitter-navigation",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  await frame.evaluate((element) => {
    const controlledFrame = element as HTMLElement & {
      allowNavigation: boolean;
      navigations: Array<{ from: string; to: string; kind: string; state: unknown }>;
    };
    controlledFrame.allowNavigation = false;
    controlledFrame.navigations = [];
    element.addEventListener("v-frame-navigate", (event) => {
      controlledFrame.navigations.push(
        (event as CustomEvent<{ from: string; to: string; kind: string; state: unknown }>)
          .detail,
      );
      if (!controlledFrame.allowNavigation) {
        event.preventDefault();
      }
    });
  });
  await frame.locator("#form-file").setInputFiles({
    name: "report.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("report"),
  });

  const openedPages: import("@playwright/test").Page[] = [];
  page.context().on("page", (openedPage) => openedPages.push(openedPage));
  await frame.locator("#override-submit").click();
  await expect
    .poll(() =>
      frame.evaluate(
        (element) =>
          (element as HTMLElement & { navigations: unknown[] }).navigations.length,
      ),
    )
    .toBe(1);
  // Popups reach Playwright through the browser process; two painted frames order the check after one.
  await flushTasks(page);
  expect(openedPages).toHaveLength(0);

  await frame.evaluate((element) => {
    (element as HTMLElement & { allowNavigation: boolean }).allowNavigation = true;
  });
  const formPagePromise = page.context().waitForEvent("page");
  await frame.locator("#override-submit").click();
  const formPage = await formPagePromise;
  const expectedURL = `${fixture.origin}/documents/override-form.html?query=fixture&upload=report.txt&submitter=override`;
  await expect.poll(() => formPage.url()).toBe(expectedURL);
  await formPage.close();

  expect(
    await frame.evaluate(
      (element) =>
        (
          element as HTMLElement & {
            navigations: Array<{
              from: string;
              to: string;
              kind: string;
              state: unknown;
            }>;
          }
        ).navigations,
    ),
  ).toEqual(
    Array.from({ length: 2 }, () => ({
      from: `${fixture.origin}/documents/history.html`,
      to: expectedURL,
      kind: "form",
      state: null,
    })),
  );
  expect(openedPages).toHaveLength(1);
  expect(
    await frame.evaluate(
      (element: HTMLElement & { currentURL: string | null }) => element.currentURL,
    ),
  ).toBe(`${fixture.origin}/documents/history.html`);
});

test("closes dialog form submissions natively without emitting navigation", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "dialog-form",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  await frame.evaluate((element) => {
    (element as HTMLElement & { navigationKinds?: string[] }).navigationKinds = [];
    element.addEventListener("v-frame-navigate", (event) => {
      (element as HTMLElement & { navigationKinds: string[] }).navigationKinds.push(
        (event as CustomEvent<{ kind: string }>).detail.kind,
      );
    });
  });

  const state = await childValue(frame, async (window) => {
    const document = window.document;
    const dialog = document.createElement("dialog");
    const form = document.createElement("form");
    form.setAttribute("method", "dialog");
    const button = document.createElement("button");
    button.value = "confirmed";
    form.append(button);
    dialog.append(form);
    document.body.append(dialog);
    dialog.showModal();
    const openBefore = dialog.open;
    button.click();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
    return { openBefore, openAfter: dialog.open, returnValue: dialog.returnValue };
  });

  expect(state).toEqual({ openBefore: true, openAfter: false, returnValue: "confirmed" });
  expect(
    await frame.evaluate(
      (element) =>
        (element as HTMLElement & { navigationKinds: string[] }).navigationKinds,
    ),
  ).toEqual([]);
});
