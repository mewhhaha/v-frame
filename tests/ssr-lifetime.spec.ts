import { expect, test } from "@playwright/test";
import { startFixtureServer } from "./support/fixture-server";

// A Playwright trace snapshot holds a strong reference to the nodes it recorded.
test.use({ trace: "off" });

test("releases the removed SSR preview including native radio groups", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "webkit",
    "Playwright WebKit cannot request deterministic GC",
  );
  const fixture = await startFixtureServer();
  try {
    await page.goto(`${fixture.origin}/documents/adopted-host.html`);
    await page.evaluate(async (url) => {
      const preview = document
        .querySelector("v-frame")!
        .shadowRoot!.querySelector("v-html")!;
      const choice = document.createElement("input");
      choice.type = "radio";
      choice.name = "rating";
      choice.checked = true;
      preview.querySelector("v-body")!.append(choice);
      (window as Window & { previewProbe?: WeakRef<Node> }).previewProbe = new WeakRef(
        preview,
      );
      (await import(url)).defineVFrame();
    }, `${fixture.origin}/dist/index.js`);
    const frame = page.locator("v-frame");
    await expect(frame).toHaveJSProperty("status", "ready");
    await page.requestGC();
    await page.requestGC();
    expect(
      await page.evaluate(
        () =>
          (window as Window & { previewProbe?: WeakRef<Node> }).previewProbe!.deref() ===
          undefined,
      ),
    ).toBe(true);
    await expect(frame.locator("input[name=rating]")).toBeChecked();
  } finally {
    await fixture.close();
  }
});
