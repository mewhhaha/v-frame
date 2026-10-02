import { expect, test } from "@playwright/test";
import {
  bundleRoute,
  htmlDocument,
  startHTTPFixture,
  type HTTPFixture,
} from "./support/http-fixture";
import { installBundle, mountFrame } from "./support/mount-frame";
import { interactionLab } from "./support/interaction-lab";
import { auditAccessibility } from "./support/accessibility";
import type { VFrameElement } from "../src/index";

let fixture: HTTPFixture;
test.beforeAll(async () => {
  fixture = await startHTTPFixture({
    routes: {
      "/": htmlDocument(
        '<main><div id="host"></div><button id="outside" style="position:fixed;right:4px;bottom:4px">Outside</button></main>',
        '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Touch host</title>',
      ).replace("<html>", '<html lang="en">'),
      "/dist/index.js": bundleRoute,
      "/guest": interactionLab,
    },
  });
});
test.afterAll(async () => fixture.close());
test.beforeEach(async ({ page }) => installBundle(page, fixture.origin));

test("touch inputs and native popover dismissal cross the host boundary", async ({
  page,
}) => {
  const frame = await mountFrame(page, { id: "touch", src: fixture.origin + "/guest" });
  await frame.evaluate((element) => {
    element.style.cssText = "width:100%;height:650px;overflow:auto";
    const guest = (element as VFrameElement).contentWindow! as Window & {
      pointerTypes: string[];
    };
    guest.pointerTypes = [];
    guest.document.addEventListener("pointerdown", (event) =>
      guest.pointerTypes.push(event.pointerType),
    );
  });
  await frame.getByRole("switch", { name: "Delivery updates" }).tap();
  await expect(frame.getByRole("switch", { name: "Delivery updates" })).toBeChecked();
  await frame.locator("#email").tap();
  await frame.locator("#email").fill("touch@example.test");
  await frame.getByRole("button", { name: "Save settings" }).tap();
  await expect(frame.getByRole("status")).toHaveText("Saved touch@example.test");
  await frame.getByRole("button", { name: "Delivery details", exact: true }).tap();
  await expect(
    frame.getByRole("dialog", { name: "Delivery details", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Outside", exact: true }).tap();
  await expect(frame.locator("#info")).not.toBeVisible();
  const types = await frame.evaluate(
    (element) =>
      ((element as VFrameElement).contentWindow! as Window & { pointerTypes: string[] })
        .pointerTypes,
  );
  expect(types.length).toBeGreaterThan(0);
  expect(types.every((type) => type === "touch")).toBe(true);
  expect((await auditAccessibility(page)).violations).toEqual([]);
});

test("native modal controls stay operable after portrait-to-landscape resizing", async ({
  page,
}) => {
  const frame = await mountFrame(page, {
    id: "orientation",
    src: fixture.origin + "/guest",
  });
  await frame.evaluate((element) => {
    element.style.cssText = "width:100%;height:650px;overflow:auto";
  });
  await frame.getByRole("button", { name: "Edit delivery", exact: true }).tap();
  await expect(frame.getByRole("dialog", { name: "Edit delivery" })).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await frame.getByRole("textbox", { name: "Delivery name" }).fill("Landscape");
  await frame.getByRole("button", { name: "Confirm edit" }).tap();
  await expect(frame.locator("#modal")).not.toBeVisible();
  await expect(frame.locator("#modal-trigger")).toBeFocused();
});
