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

test("traverses virtual history with popstate and hashchange without changing host history", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "history",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  const hostHistory = await page.evaluate(() => ({
    href: location.href,
    length: history.length,
    state: history.state,
  }));
  await frame.evaluate((element) => {
    (
      element as HTMLElement & {
        navigationEvents?: Array<{ kind: string; cancelable: boolean }>;
      }
    ).navigationEvents = [];
    element.addEventListener("v-frame-navigate", (event) => {
      const detail = (event as CustomEvent<{ kind: string }>).detail;
      (
        element as HTMLElement & {
          navigationEvents: Array<{ kind: string; cancelable: boolean }>;
        }
      ).navigationEvents.push({ kind: detail.kind, cancelable: event.cancelable });
    });
  });

  const state = await childValue(frame, async (window) => {
    const events: Array<{
      type: string;
      state?: unknown;
      oldURL?: string;
      newURL?: string;
    }> = [];
    window.addEventListener("popstate", (event) =>
      events.push({ type: "popstate", state: event.state }),
    );
    window.addEventListener("hashchange", (event) =>
      events.push({ type: "hashchange", oldURL: event.oldURL, newURL: event.newURL }),
    );
    window.history.pushState({ step: 1 }, "", "#one");
    window.history.pushState({ step: 2 }, "", "#two");
    window.history.back();
    window.history.forward();
    const beforeTraversalTasks = { events: [...events], state: window.history.state };
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    window.history.forward();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    return {
      beforeTraversalTasks,
      events,
      state: window.history.state,
      length: window.history.length,
    };
  });

  await expect
    .poll(() =>
      frame.evaluate(
        (element: HTMLElement & { currentURL: string | null }) => element.currentURL,
      ),
    )
    .toBe(`${fixture.origin}/documents/history.html#two`);
  expect(state).toEqual({
    beforeTraversalTasks: { events: [], state: { step: 2 } },
    events: [
      { type: "popstate", state: { step: 1 } },
      {
        type: "hashchange",
        oldURL: `${fixture.origin}/documents/history.html#two`,
        newURL: `${fixture.origin}/documents/history.html#one`,
      },
      { type: "popstate", state: { step: 2 } },
      {
        type: "hashchange",
        oldURL: `${fixture.origin}/documents/history.html#one`,
        newURL: `${fixture.origin}/documents/history.html#two`,
      },
    ],
    state: { step: 2 },
    length: 3,
  });
  expect(
    await page.evaluate(() => ({
      href: location.href,
      length: history.length,
      state: history.state,
    })),
  ).toEqual(hostHistory);
  expect(
    await frame.evaluate(
      (element) =>
        (
          element as HTMLElement & {
            navigationEvents: Array<{ kind: string; cancelable: boolean }>;
          }
        ).navigationEvents,
    ),
  ).toEqual([
    { kind: "push", cancelable: false },
    { kind: "push", cancelable: false },
    { kind: "traverse", cancelable: false },
    { kind: "traverse", cancelable: false },
  ]);
});

test("treats an empty hash as a local fragment and scrolls to the top", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "empty-fragment",
    `${fixture.origin}/documents/history.html`,
  );
  await expect
    .poll(() =>
      frame.evaluate((element: HTMLElement & { status: string }) => element.status),
    )
    .toBe("ready");
  await frame.evaluate((element) => {
    element.setAttribute("style", "display: block; height: 80px; overflow: auto;");
    element.scrollTop = 120;
    (element as HTMLElement & { navigationKinds?: string[] }).navigationKinds = [];
    element.addEventListener("v-frame-navigate", (event) => {
      (element as HTMLElement & { navigationKinds: string[] }).navigationKinds.push(
        (event as CustomEvent<{ kind: string }>).detail.kind,
      );
    });
  });
  await childValue(frame, (window) => {
    const events: Array<{ type: string; oldURL?: string; newURL?: string }> = [];
    (
      window as Window & typeof globalThis & { __fragmentEvents?: typeof events }
    ).__fragmentEvents = events;
    window.addEventListener("popstate", () => events.push({ type: "popstate" }));
    window.addEventListener("hashchange", (event) =>
      events.push({
        type: "hashchange",
        oldURL: event.oldURL,
        newURL: event.newURL,
      }),
    );
  });

  await frame.locator("#top-link").click();

  // The navigation default runs from a scheduled task, so the commit must be
  // observed before asserting on the recorded kinds and events.
  await expect
    .poll(() =>
      frame.evaluate(
        (element) => (element as HTMLElement & { currentURL: string }).currentURL,
      ),
    )
    .toBe(`${fixture.origin}/documents/history.html#`);
  await expect.poll(() => frame.evaluate((element) => element.scrollTop)).toBe(0);
  expect(
    await frame.evaluate((element) => ({
      url: (element as HTMLElement & { currentURL: string }).currentURL,
      kinds: (element as HTMLElement & { navigationKinds: string[] }).navigationKinds,
    })),
  ).toEqual({
    url: `${fixture.origin}/documents/history.html#`,
    kinds: ["fragment"],
  });
  expect(
    await childValue(
      frame,
      (window) =>
        (
          window as Window &
            typeof globalThis & {
              __fragmentEvents: Array<{ type: string; oldURL?: string; newURL?: string }>;
            }
        ).__fragmentEvents,
    ),
  ).toEqual([
    { type: "popstate" },
    {
      type: "hashchange",
      oldURL: `${fixture.origin}/documents/history.html`,
      newURL: `${fixture.origin}/documents/history.html#`,
    },
  ]);
});

test("replaces the history entry when a fragment link targets the current URL", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountContractFrame(
    page,
    "repeat-fragment",
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
  const historyLength = () => childValue(frame, (window) => window.history.length);
  const recordedKinds = () =>
    frame.evaluate(
      (element) =>
        (element as HTMLElement & { navigationKinds: string[] }).navigationKinds.length,
    );

  const initialLength = await historyLength();
  await frame.locator("#top-link").click();
  await expect.poll(recordedKinds).toBe(1);
  const afterFirst = await historyLength();

  await frame.locator("#top-link").click();
  await frame.locator("#top-link").click();
  await expect.poll(recordedKinds).toBe(3);

  expect(afterFirst).toBe(initialLength + 1);
  expect(await historyLength()).toBe(afterFirst);
});
