import { expect, test, type Locator, type Page } from "@playwright/test";
import { type FixtureServer, startFixtureServer } from "./support/fixture-server";
import { childValue } from "./support/guest-frames";
import { installBundle, mountFrame } from "./support/mount-frame";

let fixture: FixtureServer;

test.beforeAll(async () => {
  fixture = await startFixtureServer();
});

test.afterAll(async () => {
  await fixture.close();
});

function mountDocument(page: Page, path: string): Promise<Locator> {
  return mountFrame(page, { src: `${fixture.origin}${path}`, settle: "none" });
}

test("executes an insertAdjacentElement script only in the child realm", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/dynamic-insert.html");

  await expect(frame.locator("#dynamic-insert-result")).toHaveText(
    "child realm executed",
  );
  expect(await page.evaluate(() => "__dynamicInsertRealm" in window)).toBe(false);
  expect(
    await childValue(frame, (window) => (window as any).__dynamicInsertRealm === window),
  ).toBe(true);
});

test("waits for an inline module top-level await before becoming ready", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/inline-module.html");

  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");
  await expect(frame.locator("#module-result")).toHaveText("module settled");
});

test("runs classic, deferred, and async scripts with their current script and ready state", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/script-order.html");

  // The async script is parked, so it lands after the deferred one because the test says
  // so rather than because a response delay outran the browser's scheduling.
  await expect
    .poll(() => childValue(frame, (window) => (window as any).__scriptEvents))
    .toEqual([
      "classic-inline:classic-inline:loading",
      "classic-external:classic-external:loading",
      "defer-external:deferred-external:interactive",
    ]);
  await fixture.releaseAsyncScript();

  await expect
    .poll(() => frame.evaluate((element) => (element as any).status))
    .toBe("ready");
  await expect
    .poll(() => childValue(frame, (window) => (window as any).__scriptEvents))
    .toEqual([
      "classic-inline:classic-inline:loading",
      "classic-external:classic-external:loading",
      "defer-external:deferred-external:interactive",
      "async-external:async-external:interactive",
      "load:complete",
    ]);
});

test("preserves insertion order for dynamic external scripts with async false", async ({
  page,
}) => {
  await installBundle(page, fixture.origin);
  const frame = await mountDocument(page, "/documents/dynamic-external-order.html");

  // The guarantee is insertion order despite arrival order, so the first script answers
  // only once the second one's response has already been written.
  await fixture.dynamicScriptOrder.secondServed;
  await fixture.dynamicScriptOrder.releaseFirst();

  await expect
    .poll(() => childValue(frame, (window) => (window as any).__dynamicExternalEvents))
    .toEqual(["first", "second"]);
});
