import { expect, test } from "@playwright/test";
import {
  startContractFixtureServers,
  type ContractFixtureServers,
} from "./support/fixture-server";

let fixture: ContractFixtureServers;

test.beforeAll(async () => {
  fixture = await startContractFixtureServers();
});

test.afterAll(async () => {
  await fixture.close();
});

test("uses the public route for native Location while keeping soft history frame-local", async ({
  page,
}) => {
  await page.goto(fixture.origin);
  await page.evaluate(async (url) => {
    const bundle = await import(url);
    bundle.defineVFrame();
    localStorage.setItem("vframe_origin_storage", "host-origin");
    sessionStorage.setItem("vframe_origin_session", "host-origin");
    document.cookie = "vframe_origin_cookie=host-origin; Path=/; SameSite=Lax";
  }, `${fixture.origin}/dist/index.js`);

  const hostHistory = await page.evaluate(() => ({
    href: location.href,
    length: history.length,
    state: history.state,
  }));
  const sourceURL = `${fixture.origin}/documents/location.html?entry=1#initial`;
  await page.evaluate((source) => {
    const frame = document.createElement("v-frame");
    frame.id = "origin-history";
    frame.setAttribute("src", source);
    document.querySelector("#host")?.append(frame);
  }, sourceURL);

  const frame = page.locator("#origin-history");
  await expect
    .poll(() =>
      frame.evaluate((element) => (element as HTMLElement & { status: string }).status),
    )
    .toBe("ready");
  await expect
    .poll(() =>
      frame.evaluate(
        (element) =>
          (
            element as HTMLElement & {
              contentWindow: Window &
                typeof globalThis & { __originHistoryAnimationFrameCount: number };
            }
          ).contentWindow.__originHistoryAnimationFrameCount,
      ),
    )
    .toBe(1);

  const initial = await frame.evaluate(
    (element) =>
      (
        element as HTMLElement & {
          contentWindow: Window &
            typeof globalThis & {
              __initialLocationSnapshot: Record<string, string | null>;
            };
        }
      ).contentWindow.__initialLocationSnapshot,
  );
  expect(initial).toEqual({
    href: sourceURL,
    origin: fixture.origin,
    globalOrigin: fixture.origin,
    pathname: "/documents/location.html",
    search: "?entry=1",
    hash: "#initial",
    documentURL: sourceURL,
    documentURI: sourceURL,
    localStorage: "host-origin",
    sessionStorage: "host-origin",
    cookie: expect.stringContaining("vframe_origin_cookie=host-origin"),
  });

  const states = await frame.evaluate(async (element) => {
    const controlledFrame = element as HTMLElement & {
      contentWindow: Window & typeof globalThis;
      currentURL: string;
    };
    const child = controlledFrame.contentWindow;
    const snapshot = () => ({
      currentURL: controlledFrame.currentURL,
      documentURL: child.document.URL,
      href: child.location.href,
    });

    child.history.pushState({ step: "push" }, "", "pushed.html?step=1#pushed");
    const pushed = snapshot();
    child.history.replaceState({ step: "replace" }, "", "replaced.html?step=2#replaced");
    const replaced = snapshot();
    child.history.back();
    await new Promise((resolve) => child.setTimeout(resolve, 0));
    const traversedBack = snapshot();
    child.history.forward();
    await new Promise((resolve) => child.setTimeout(resolve, 0));
    return { pushed, replaced, traversedBack, traversedForward: snapshot() };
  });

  expect(states).toEqual({
    pushed: {
      currentURL: `${fixture.origin}/documents/pushed.html?step=1#pushed`,
      documentURL: `${fixture.origin}/documents/pushed.html?step=1#pushed`,
      href: `${fixture.origin}/documents/pushed.html?step=1#pushed`,
    },
    replaced: {
      currentURL: `${fixture.origin}/documents/replaced.html?step=2#replaced`,
      documentURL: `${fixture.origin}/documents/replaced.html?step=2#replaced`,
      href: `${fixture.origin}/documents/replaced.html?step=2#replaced`,
    },
    traversedBack: {
      currentURL: sourceURL,
      documentURL: sourceURL,
      href: sourceURL,
    },
    traversedForward: {
      currentURL: `${fixture.origin}/documents/replaced.html?step=2#replaced`,
      documentURL: `${fixture.origin}/documents/replaced.html?step=2#replaced`,
      href: `${fixture.origin}/documents/replaced.html?step=2#replaced`,
    },
  });
  expect(
    await page.evaluate(() => ({
      href: location.href,
      length: history.length,
      state: history.state,
    })),
  ).toEqual(hostHistory);
});
